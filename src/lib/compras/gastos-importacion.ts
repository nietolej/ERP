import Decimal from 'decimal.js';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { CRITERIOS_REPARTO, repartirCosto, type CriterioReparto, type LineaReparto } from './costo-destino';
import { dos } from './facturas';
import { ROLES_VEN_COMPRAS, type Usuario } from './ordenes';

/**
 * Gastos de importación y costo en destino (§7.1, §7.2 regla 3). Migración 0025.
 *
 *   borrador (factura del proveedor de servicios + recepciones a las que se aplica + criterio) → vista previa del reparto
 *     → registrar: reparto exacto por línea, ajuste de costo de lo que sigue en existencia, costo de ventas por lo ya vendido,
 *       cuenta por pagar y asiento.
 *
 * Los gastos de una compra se reparten entre las líneas de las recepciones elegidas por valor (lo que costó cada línea en USD),
 * peso (cantidad × kg por unidad), volumen (cantidad × m³ por unidad) o cantidad. Las unidades que siguen en existencia se toman de
 * la existencia total de cada producto: esa parte encarece el inventario; el resto va al costo de ventas.
 */

export { CRITERIOS_REPARTO, type CriterioReparto };

export const CONCEPTOS_GASTO = ['flete', 'seguro', 'arancel', 'agente_aduana', 'almacenaje', 'otros'] as const;
export type ConceptoGasto = (typeof CONCEPTOS_GASTO)[number];
export const NOMBRE_CONCEPTO: Record<ConceptoGasto, string> = {
  flete: 'Flete', seguro: 'Seguro', arancel: 'Aranceles y tasas aduaneras', agente_aduana: 'Agente de aduana', almacenaje: 'Almacenaje', otros: 'Otros',
};

const MONTO = /^\d{1,12}(\.\d{1,2})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export interface DatosGasto {
  proveedorId: string;
  concepto: string;
  descripcion?: string;
  numeroFactura: string;
  numeroControl: string;
  fechaFactura: string;
  fechaVencimiento?: string;
  moneda: string;
  criterioReparto?: string;
  /** Monto del gasto sin IVA. */
  base: string;
  alicuotaIvaId: string;
  recepcionIds: string[];
}

interface Gasto { id: string; estado: string; criterio_reparto: CriterioReparto; moneda: string }

async function gasto(tx: Db, id: string): Promise<Gasto> {
  const { rows } = await tx.query<Gasto>('select id, estado, criterio_reparto, moneda from gasto_importacion where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El gasto de importación no existe.');
  return rows[0];
}

async function exigirBorrador(tx: Db, id: string): Promise<Gasto> {
  const g = await gasto(tx, id);
  if (g.estado !== 'borrador') throw new ErrorMaestro('Solo se edita un gasto de importación en borrador.');
  return g;
}

async function validar(tx: Db, d: DatosGasto, excluirId?: string): Promise<{ criterio: CriterioReparto; recepciones: string[] }> {
  if (!d.proveedorId) throw new ErrorMaestro('Seleccione el proveedor del gasto.');
  if (!(CONCEPTOS_GASTO as readonly string[]).includes(d.concepto)) throw new ErrorMaestro('Seleccione el concepto del gasto.');
  const numero = d.numeroFactura.trim();
  if (!numero || numero.length > 40) throw new ErrorMaestro('Indique el número de la factura del proveedor (hasta 40 caracteres).');
  if (!d.numeroControl.trim() || d.numeroControl.trim().length > 40) throw new ErrorMaestro('Indique el número de control de la factura del proveedor.');
  if (!FECHA.test(d.fechaFactura)) throw new ErrorMaestro('Indique la fecha de la factura.');
  if (d.fechaVencimiento && !FECHA.test(d.fechaVencimiento)) throw new ErrorMaestro('La fecha de vencimiento no es válida.');
  if (!/^[A-Z]{3,4}$/.test(d.moneda)) throw new ErrorMaestro('Seleccione la moneda de la factura.');
  if (!MONTO.test(d.base.trim()) || new Decimal(d.base).lte(0)) throw new ErrorMaestro('El monto del gasto debe ser mayor que cero, con hasta 2 decimales.');
  if (!d.alicuotaIvaId) throw new ErrorMaestro('Seleccione la alícuota de IVA de la factura.');
  const recepciones = [...new Set(d.recepcionIds)];
  if (!recepciones.length) throw new ErrorMaestro('Seleccione al menos una recepción a la que se aplica el gasto.');

  const { rows: prov } = await tx.query<{ estado: string }>('select estado from proveedor where tercero_id = $1', [d.proveedorId]);
  if (!prov[0]) throw new ErrorMaestro('El proveedor no existe.');
  if (prov[0].estado !== 'activo') throw new ErrorMaestro('El proveedor debe estar activo.');
  const { rows: dup } = await tx.query(
    `select 1 from gasto_importacion where proveedor_id = $1 and upper(trim(numero_factura)) = upper($2) and ($3::uuid is null or id <> $3::uuid)
     union all
     select 1 from factura_compra where proveedor_id = $1 and upper(trim(numero_factura)) = upper($2) and estado in ('borrador', 'retenida', 'contabilizada')`,
    [d.proveedorId, numero, excluirId ?? null]);
  if (dup.length) throw new ErrorMaestro(`Ese proveedor ya tiene registrada la factura ${numero.toUpperCase()}.`);

  const { rows: recs } = await tx.query<{ id: string; criterio: CriterioReparto }>(
    `select r.id, o.criterio_reparto as criterio from documento_compra r join documento_compra o on o.id = r.orden_id
      where r.id = any($1::uuid[]) and r.tipo = 'recepcion' and r.estado = 'emitido'`, [recepciones]);
  if (recs.length !== recepciones.length) throw new ErrorMaestro('Alguna de las recepciones no existe o no está emitida.');
  const propuestos = new Set(recs.map((r) => r.criterio));
  const criterio = (d.criterioReparto || (propuestos.size === 1 ? [...propuestos][0] : 'valor')) as CriterioReparto;
  if (!CRITERIOS_REPARTO.includes(criterio)) throw new ErrorMaestro('Seleccione cómo se reparte el gasto.');
  return { criterio, recepciones };
}

export async function crearGasto(tx: Db, u: Usuario, d: DatosGasto): Promise<string> {
  const { criterio, recepciones } = await validar(tx, d);
  const { rows: cp } = await tx.query<{ dias: number | null }>(
    `select cp.dias from proveedor p left join condicion_pago cp on cp.id = p.condicion_pago_id where p.tercero_id = $1`, [d.proveedorId]);
  const { rows } = await tx.query<{ id: string }>(
    `insert into gasto_importacion (proveedor_id, concepto, descripcion, numero_factura, numero_control, fecha_factura, fecha_vencimiento, moneda,
                                    criterio_reparto, base, alicuota_iva_id, created_by)
     values ($1, $2, $3, $4, $5, $6::date, coalesce($7::date, $6::date + $8::int), $9, $10, $11, $12, $13) returning id`,
    [d.proveedorId, d.concepto, d.descripcion?.trim() || null, d.numeroFactura.trim(), d.numeroControl.trim(), d.fechaFactura,
     d.fechaVencimiento || null, cp[0]?.dias ?? 0, d.moneda, criterio, d.base.trim(), d.alicuotaIvaId, u.id]);
  for (const r of recepciones) await tx.query('insert into gasto_importacion_recepcion (gasto_id, recepcion_id) values ($1, $2)', [rows[0].id, r]);
  return rows[0].id;
}

export async function actualizarGasto(tx: Db, id: string, d: DatosGasto): Promise<void> {
  await exigirBorrador(tx, id);
  const { criterio, recepciones } = await validar(tx, d, id);
  await tx.query(
    `update gasto_importacion set proveedor_id = $2, concepto = $3, descripcion = $4, numero_factura = $5, numero_control = $6, fecha_factura = $7::date,
            fecha_vencimiento = coalesce($8::date, $7::date + (select coalesce(cp.dias, 0) from proveedor p left join condicion_pago cp on cp.id = p.condicion_pago_id
                                                                where p.tercero_id = $2)),
            moneda = $9, criterio_reparto = $10, base = $11, alicuota_iva_id = $12 where id = $1`,
    [id, d.proveedorId, d.concepto, d.descripcion?.trim() || null, d.numeroFactura.trim(), d.numeroControl.trim(), d.fechaFactura,
     d.fechaVencimiento || null, d.moneda, criterio, d.base.trim(), d.alicuotaIvaId]);
  await tx.query('delete from gasto_importacion_recepcion where gasto_id = $1', [id]);
  for (const r of recepciones) await tx.query('insert into gasto_importacion_recepcion (gasto_id, recepcion_id) values ($1, $2)', [id, r]);
}

export async function eliminarGasto(tx: Db, id: string): Promise<void> {
  await exigirBorrador(tx, id);
  await tx.query('delete from gasto_importacion where id = $1', [id]);
}

// ---------------------------------------------------------------------
// Reparto
// ---------------------------------------------------------------------

export interface LineaRepartida {
  recepcionLineaId: string;
  productoId: string;
  codigo: string;
  recepcion: string;
  cantidad: string;
  valorUsd: string;
  /** Parte del gasto que le toca, en la moneda del gasto. */
  monto: string;
  montoInventario: string;
  montoCostoVentas: string;
}

/** Calcula el reparto del gasto (sin escribir nada). Falla si a algún producto le falta la medida del criterio. */
export async function calcularReparto(tx: Db, id: string): Promise<{ criterio: CriterioReparto; base: string; lineas: LineaRepartida[] }> {
  const { rows: g } = await tx.query<{ criterio_reparto: CriterioReparto; base: string }>(
    'select criterio_reparto, base::text from gasto_importacion where id = $1', [id]);
  if (!g[0]) throw new ErrorMaestro('El gasto de importación no existe.');
  const { rows: ls } = await tx.query<{
    id: string; producto_id: string; codigo: string; recepcion: string; cantidad: string; costo_total_usd: string;
    peso: string | null; volumen: string | null; en_existencia: string;
  }>(
    `select l.id, l.producto_id, p.codigo, r.numero::text as recepcion, l.cantidad::text, l.costo_total_usd::text,
            p.peso_kg::text as peso, p.volumen_unitario_m3::text as volumen,
            coalesce((select c.cantidad from producto_costo c where c.producto_id = l.producto_id), 0)::text as en_existencia
       from gasto_importacion_recepcion gr
       join documento_compra r on r.id = gr.recepcion_id
       join documento_compra_linea l on l.documento_id = r.id
       join producto p on p.id = l.producto_id
      where gr.gasto_id = $1 order by r.numero, l.linea`, [id]);
  if (!ls.length) throw new ErrorMaestro('Las recepciones elegidas no tienen productos.');

  const partes = repartirCosto(ls.map<LineaReparto>((l) => ({
    id: l.id, codigo: l.codigo, cantidad: l.cantidad, valor: l.costo_total_usd, pesoUnitarioKg: l.peso, volumenUnitarioM3: l.volumen,
  })), g[0].base, g[0].criterio_reparto);

  // Lo que sigue en existencia se calcula por producto, no por línea: dos recepciones del mismo producto comparten la existencia.
  const porProducto = new Map<string, { cantidad: Decimal; enExistencia: Decimal }>();
  for (const l of ls) {
    const p = porProducto.get(l.producto_id) ?? { cantidad: new Decimal(0), enExistencia: new Decimal(l.en_existencia) };
    p.cantidad = p.cantidad.plus(l.cantidad);
    porProducto.set(l.producto_id, p);
  }
  const lineas = ls.map<LineaRepartida>((l) => {
    const p = porProducto.get(l.producto_id)!;
    const fraccion = Decimal.min(p.cantidad, p.enExistencia).dividedBy(p.cantidad);
    const monto = new Decimal(partes.get(l.id)!);
    const inv = dos(monto.times(fraccion));
    return {
      recepcionLineaId: l.id, productoId: l.producto_id, codigo: l.codigo, recepcion: l.recepcion, cantidad: l.cantidad, valorUsd: l.costo_total_usd,
      monto: monto.toFixed(2), montoInventario: inv.toFixed(2), montoCostoVentas: monto.minus(inv).toFixed(2),
    };
  });
  return { criterio: g[0].criterio_reparto, base: g[0].base, lineas };
}

export interface ResultadoGasto { numero: string; asiento: string; inventario: string; costoVentas: string }

/** Registra el gasto: reparto, ajuste de costo, cuenta por pagar y asiento, todo en la misma transacción. */
export async function registrarGasto(tx: Db, u: Usuario, id: string): Promise<ResultadoGasto> {
  await exigirBorrador(tx, id);
  await tx.query('select fn_gasto_importacion_calcular($1)', [id]);
  const { lineas } = await calcularReparto(tx, id);
  const { rows: cab } = await tx.query<{
    proveedor_id: string; moneda: string; tasa: string; fecha: string; vencimiento: string; iva: string; total: string; total_usd: string;
    numero_factura: string; concepto: string;
  }>(
    `select proveedor_id, moneda, tasa::text, fecha_factura::text as fecha, fecha_vencimiento::text as vencimiento, iva::text, total::text,
            total_usd::text, numero_factura, concepto from gasto_importacion where id = $1`, [id]);
  const g = cab[0];
  const { rows: t } = await tx.query<{ usd: string }>(`select fn_tasa('USD', $1::date)::text as usd`, [g.fecha]);
  const tasaMon = new Decimal(g.tasa);
  const tasaUsd = new Decimal(t[0].usd);
  const enUsd = (orig: Decimal): Decimal => (g.moneda === 'USD' ? dos(orig) : dos(dos(orig.times(tasaMon)).dividedBy(tasaUsd)));

  for (const l of lineas) {
    await tx.query(
      `insert into gasto_importacion_reparto (gasto_id, recepcion_linea_id, producto_id, monto, monto_inventario, monto_costo_ventas)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, l.recepcionLineaId, l.productoId, l.monto, l.montoInventario, l.montoCostoVentas]);
  }

  const inventario = lineas.reduce((s, l) => s.plus(l.montoInventario), new Decimal(0));
  const costoVentas = lineas.reduce((s, l) => s.plus(l.montoCostoVentas), new Decimal(0));

  // Ajuste de costo por producto; el USD sumado debe ser el mismo del asiento (el residuo de redondeo va al mayor).
  const porProducto = new Map<string, Decimal>();
  for (const l of lineas) porProducto.set(l.productoId, (porProducto.get(l.productoId) ?? new Decimal(0)).plus(l.montoInventario));
  const ajustes = [...porProducto].filter(([, v]) => v.gt(0)).map(([productoId, v]) => ({ productoId, usd: enUsd(v) }));
  const objetivo = enUsd(inventario);
  const actual = ajustes.reduce((s, a) => s.plus(a.usd), new Decimal(0));
  if (ajustes.length && !objetivo.equals(actual)) {
    const mayor = ajustes.reduce((m, a) => (a.usd.gt(m.usd) ? a : m));
    mayor.usd = mayor.usd.plus(objetivo.minus(actual));
  }
  for (const a of ajustes) {
    if (a.usd.isZero()) continue;
    await tx.query(
      `insert into ajuste_costo (producto_id, valor_usd, origen_tipo, origen_id, created_by) values ($1, $2, 'gasto_importacion', $3, $4)`,
      [a.productoId, a.usd.toFixed(2), id, u.id]);
  }

  const { rows: num } = await tx.query<{ numero: string }>(`update gasto_importacion set estado = 'contabilizado' where id = $1 returning numero::text`, [id]);
  await tx.query(
    `insert into partida_cxp (proveedor_id, gasto_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
     values ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $7)`,
    [g.proveedor_id, id, g.fecha, g.vencimiento, g.moneda, g.tasa, g.total, g.total_usd]);
  const r = await contabilizar(tx, {
    evento: 'gasto_importacion', fecha: g.fecha, descripcion: `Gasto de importación (${NOMBRE_CONCEPTO[g.concepto as ConceptoGasto] ?? g.concepto}) · factura ${g.numero_factura}`,
    origen: { tipo: 'gasto_importacion', id }, moneda: g.moneda,
    importes: { inventario: inventario.toFixed(2), costo_ventas: costoVentas.toFixed(2), iva: g.iva, total: g.total },
    terceroId: g.proveedor_id, usuarioId: u.id,
  });
  return { numero: num[0].numero, asiento: r.numero, inventario: inventario.toFixed(2), costoVentas: costoVentas.toFixed(2) };
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaGasto {
  id: string; numero: string | null; estado: string; concepto: string; numero_factura: string; proveedor: string; moneda: string;
  base: string; total: string; fecha: string; criterio_reparto: string; recepciones: number;
}

export async function buscarGastos(db: Db, u: Usuario, limite = 100): Promise<FilaGasto[]> {
  if (!u.roles.some((r) => (ROLES_VEN_COMPRAS as readonly string[]).includes(r))) return [];
  const { rows } = await db.query<FilaGasto>(
    `select g.id, g.numero::text, g.estado, g.concepto, g.numero_factura, p.codigo || ' · ' || t.razon_social as proveedor, g.moneda,
            g.base::text, g.total::text, to_char(g.fecha_factura, 'DD-MM-YYYY') as fecha, g.criterio_reparto,
            (select count(*)::int from gasto_importacion_recepcion x where x.gasto_id = g.id) as recepciones
       from gasto_importacion g join proveedor p on p.tercero_id = g.proveedor_id join tercero t on t.id = p.tercero_id
      order by g.created_at desc limit $1`, [limite]);
  return rows;
}

export interface DetalleGasto {
  id: string; numero: string | null; estado: string; proveedor_id: string; proveedor: string; concepto: string; descripcion: string | null;
  numero_factura: string; numero_control: string; fecha_factura: string; fecha_vencimiento: string; moneda: string; tasa: string | null;
  criterio_reparto: CriterioReparto; base: string; alicuota_iva_id: string; alicuota_pct: string; iva: string; total: string; total_usd: string;
  creado_por: string; saldo: string | null; recepciones: { id: string; numero: string; orden: string; fecha: string; total_usd: string }[];
  reparto: { codigo: string; recepcion: string; cantidad: string; monto: string; monto_inventario: string; monto_costo_ventas: string }[];
}

export async function detalleGasto(db: Db, id: string): Promise<DetalleGasto | null> {
  const { rows } = await db.query<Omit<DetalleGasto, 'recepciones' | 'reparto' | 'saldo'>>(
    `select g.id, g.numero::text, g.estado, g.proveedor_id, p.codigo || ' · ' || t.razon_social as proveedor, g.concepto, g.descripcion,
            g.numero_factura, g.numero_control, to_char(g.fecha_factura, 'YYYY-MM-DD') as fecha_factura,
            to_char(g.fecha_vencimiento, 'YYYY-MM-DD') as fecha_vencimiento, g.moneda, g.tasa::text, g.criterio_reparto, g.base::text,
            g.alicuota_iva_id, g.alicuota_pct::text, g.iva::text, g.total::text, g.total_usd::text, cr.nombre as creado_por
       from gasto_importacion g join proveedor p on p.tercero_id = g.proveedor_id join tercero t on t.id = p.tercero_id
       join usuario cr on cr.id = g.created_by where g.id = $1`, [id]);
  if (!rows[0]) return null;
  const [recs, reparto, saldo] = await Promise.all([
    db.query<DetalleGasto['recepciones'][number]>(
      `select r.id, r.numero::text, o.numero::text as orden, to_char(r.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, r.total_usd::text
         from gasto_importacion_recepcion gr join documento_compra r on r.id = gr.recepcion_id join documento_compra o on o.id = r.orden_id
        where gr.gasto_id = $1 order by r.numero`, [id]),
    db.query<DetalleGasto['reparto'][number]>(
      `select p.codigo, r.numero::text as recepcion, l.cantidad::text, x.monto::text, x.monto_inventario::text, x.monto_costo_ventas::text
         from gasto_importacion_reparto x join documento_compra_linea l on l.id = x.recepcion_linea_id join documento_compra r on r.id = l.documento_id
         join producto p on p.id = x.producto_id where x.gasto_id = $1 order by r.numero, l.linea`, [id]),
    db.query<{ saldo: string }>('select saldo::text from partida_cxp where gasto_id = $1', [id]),
  ]);
  return { ...rows[0], recepciones: recs.rows, reparto: reparto.rows, saldo: saldo.rows[0]?.saldo ?? null };
}

export interface RecepcionElegible { id: string; texto: string }

/** Recepciones emitidas a las que se puede aplicar un gasto, las más recientes primero. */
export async function recepcionesElegibles(db: Db, limite = 100): Promise<RecepcionElegible[]> {
  const { rows } = await db.query<RecepcionElegible>(
    `select r.id, 'Recepción ' || r.numero || ' · orden ' || o.numero || ' · ' || p.codigo || ' · US$ ' || r.total_usd || ' · ' ||
            to_char(r.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as texto
       from documento_compra r join documento_compra o on o.id = r.orden_id join proveedor p on p.tercero_id = r.proveedor_id
      where r.tipo = 'recepcion' and r.estado = 'emitido' order by r.numero desc limit $1`, [limite]);
  return rows;
}
