import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_VEN_COMPRAS, type Usuario } from './ordenes';

/**
 * Factura de compra de mercancía con conciliación a tres vías y cuenta por pagar (§7.2, §7.3). Migración 0024.
 *
 *   borrador (se arma contra una orden aprobada) → registrar → conciliación con la orden (precio) y la recepción (cantidad)
 *     · dentro de tolerancia  → contabilizada: liquida la mercancía recibida no facturada, ajusta el costo, abre la cuenta por pagar
 *     · fuera de tolerancia   → retenida: no abre cuenta por pagar (no se puede pagar) hasta que Gerencia —no quien la registró— decida
 *
 * La diferencia entre lo facturado y lo recibido ajusta el costo de lo que sigue en existencia y va al costo de ventas por lo
 * que ya se vendió. Las unidades en existencia se toman de la existencia total del producto (costo promedio único, decisión 5).
 */

export const ROLES_REGISTRAN_FACTURA = ['compras', 'contabilidad', 'gerencia'] as const satisfies readonly Rol[];

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const PRECIO = /^\d{1,12}(\.\d{1,4})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const NOMBRE_ESTADO_FACTURA: Record<string, string> = {
  borrador: 'Borrador', retenida: 'Retenida: pendiente de Gerencia', contabilizada: 'Contabilizada', rechazada: 'Rechazada',
};

/** Redondeo a centavos igual al del motor contable. */
export const dos = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

interface Factura { id: string; estado: string; orden_id: string; created_by: string }

async function factura(tx: Db, id: string): Promise<Factura> {
  const { rows } = await tx.query<Factura>('select id, estado, orden_id, created_by from factura_compra where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La factura de compra no existe.');
  return rows[0];
}

async function exigirBorrador(tx: Db, id: string): Promise<Factura> {
  const f = await factura(tx, id);
  if (f.estado !== 'borrador') throw new ErrorMaestro('Solo se edita una factura de compra en borrador.');
  return f;
}

export interface DatosFactura {
  ordenId: string;
  numeroFactura: string;
  numeroControl: string;
  /** 'AAAA-MM-DD'. */
  fechaFactura: string;
  /** Si se omite: fecha de la factura + días de la condición de pago del proveedor. */
  fechaVencimiento?: string;
}

export async function crearFactura(tx: Db, u: Usuario, d: DatosFactura): Promise<string> {
  const numero = d.numeroFactura.trim();
  const control = d.numeroControl.trim();
  if (!numero || numero.length > 40) throw new ErrorMaestro('Indique el número de la factura del proveedor (hasta 40 caracteres).');
  if (!control || control.length > 40) throw new ErrorMaestro('Indique el número de control de la factura del proveedor.');
  if (!FECHA.test(d.fechaFactura)) throw new ErrorMaestro('Indique la fecha de la factura.');
  if (d.fechaVencimiento && !FECHA.test(d.fechaVencimiento)) throw new ErrorMaestro('La fecha de vencimiento no es válida.');
  const { rows: ord } = await tx.query<{ proveedor_id: string; estado: string; dias: number | null }>(
    `select o.proveedor_id, o.estado, cp.dias from documento_compra o
       join proveedor p on p.tercero_id = o.proveedor_id left join condicion_pago cp on cp.id = p.condicion_pago_id
      where o.id = $1 and o.tipo = 'orden_compra'`, [d.ordenId]);
  if (!ord[0]) throw new ErrorMaestro('La orden de compra no existe.');
  if (ord[0].estado !== 'aprobada') throw new ErrorMaestro('Solo se factura contra una orden de compra aprobada.');
  const { rows: dup } = await tx.query(
    `select 1 from factura_compra where proveedor_id = $1 and upper(trim(numero_factura)) = upper($2)
        and estado in ('borrador', 'retenida', 'contabilizada')`, [ord[0].proveedor_id, numero]);
  if (dup.length) throw new ErrorMaestro(`Ese proveedor ya tiene registrada la factura ${numero.toUpperCase()}.`);
  const { rows } = await tx.query<{ id: string }>(
    `insert into factura_compra (orden_id, proveedor_id, numero_factura, numero_control, fecha_factura, fecha_vencimiento, moneda, created_by)
     values ($1, $2, $3, $4, $5::date, coalesce($6::date, $5::date + $7::int), 'USD', $8) returning id`,
    [d.ordenId, ord[0].proveedor_id, numero, control, d.fechaFactura, d.fechaVencimiento || null, ord[0].dias ?? 0, u.id]);
  return rows[0].id;
}

/** Agrega (o reemplaza) una línea: cantidad y precio de la factura del proveedor para una línea de la orden. */
export async function guardarLinea(
  tx: Db, facturaId: string, d: { ordenLineaId: string; cantidad: string; precio: string },
): Promise<void> {
  const f = await exigirBorrador(tx, facturaId);
  const cantidad = d.cantidad.trim();
  const precio = d.precio.trim();
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser un número mayor que cero, con hasta 4 decimales.');
  if (!PRECIO.test(precio)) throw new ErrorMaestro('El precio debe ser un monto con hasta 4 decimales.');
  const { rows } = await tx.query<{ producto_id: string; descripcion: string; alicuota_iva_id: string }>(
    `select o.producto_id, o.descripcion, p.alicuota_iva_id from documento_compra_linea o join producto p on p.id = o.producto_id
      where o.id = $1 and o.documento_id = $2`, [d.ordenLineaId, f.orden_id]);
  if (!rows[0]) throw new ErrorMaestro('Esa línea no pertenece a la orden de compra de la factura.');
  await tx.query('delete from factura_compra_linea where factura_id = $1 and orden_linea_id = $2', [facturaId, d.ordenLineaId]);
  await tx.query(
    `insert into factura_compra_linea (factura_id, linea, orden_linea_id, producto_id, descripcion, cantidad, precio_unitario, alicuota_iva_id)
     values ($1, (select coalesce(max(linea), 0) + 1 from factura_compra_linea where factura_id = $1), $2, $3, $4, $5, $6, $7)`,
    [facturaId, d.ordenLineaId, rows[0].producto_id, rows[0].descripcion, cantidad, precio, rows[0].alicuota_iva_id]);
}

export async function quitarLinea(tx: Db, facturaId: string, lineaId: string): Promise<void> {
  await exigirBorrador(tx, facturaId);
  await tx.query('delete from factura_compra_linea where id = $2 and factura_id = $1', [facturaId, lineaId]);
}

export async function eliminarBorrador(tx: Db, facturaId: string): Promise<void> {
  await exigirBorrador(tx, facturaId);
  await tx.query('delete from factura_compra where id = $1', [facturaId]);
}

export interface ResultadoRegistro {
  estado: 'contabilizada' | 'retenida';
  numero: string;
  motivo: string | null;
  asiento: string | null;
}

/**
 * Registra la factura: calcula su IVA y totales, la concilia con la orden y la recepción y, si está dentro de tolerancia,
 * la contabiliza; si no, queda retenida a la espera de Gerencia.
 */
export async function registrarFactura(tx: Db, u: Usuario, id: string): Promise<ResultadoRegistro> {
  await exigirBorrador(tx, id);
  await tx.query('select fn_factura_compra_calcular($1)', [id]);
  const { rows: ok } = await tx.query<{ ok: boolean }>('select fn_factura_compra_conciliar($1) as ok', [id]);
  const conciliada = ok[0].ok;
  const { rows } = await tx.query<{ numero: string; motivo_retencion: string | null; total_usd: string }>(
    `update factura_compra set estado = $2 where id = $1 returning numero::text, motivo_retencion, total_usd::text`,
    [id, conciliada ? 'contabilizada' : 'retenida']);
  if (conciliada) {
    const asiento = await contabilizarFactura(tx, id, u.id);
    return { estado: 'contabilizada', numero: rows[0].numero, motivo: null, asiento };
  }
  await solicitarAprobacion(tx, { tipo: 'factura_compra', objetoId: id, solicitanteId: u.id, contexto: { valor_usd: Number(rows[0].total_usd) } });
  return { estado: 'retenida', numero: rows[0].numero, motivo: rows[0].motivo_retencion, asiento: null };
}

/** Lo llama el motor de flujo cuando Gerencia aprueba una factura retenida. */
export async function aprobarFactura(tx: Db, id: string, aprobador: string): Promise<void> {
  const f = await factura(tx, id);
  if (f.estado !== 'retenida') throw new ErrorMaestro('La factura no está retenida.');
  await tx.query(`update factura_compra set estado = 'contabilizada', aprobado_por = $2 where id = $1`, [id, aprobador]);
  await contabilizarFactura(tx, id, aprobador);
}

/** Lo llama el motor de flujo cuando Gerencia rechaza una factura retenida: no abre cuenta por pagar ni mueve costos. */
export async function rechazarFactura(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const f = await factura(tx, id);
  if (f.estado !== 'retenida') throw new ErrorMaestro('La factura no está retenida.');
  await tx.query(`update factura_compra set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

/**
 * Efectos de contabilizar una factura (R-BE): ajuste de costo de lo que sigue en existencia, cuenta por pagar y asiento.
 * Todo en la moneda de la factura; el USD del inventario se obtiene con el mismo redondeo del motor contable para que el
 * auxiliar de inventario coincida con el mayor.
 */
async function contabilizarFactura(tx: Db, id: string, usuarioId: string): Promise<string> {
  const { rows: cab } = await tx.query<{
    proveedor_id: string; moneda: string; tasa: string; fecha: string; vencimiento: string; total: string; total_usd: string; iva: string;
    numero: string; numero_factura: string;
  }>(
    `select proveedor_id, moneda, tasa::text, fecha_factura::text as fecha, fecha_vencimiento::text as vencimiento, total::text, total_usd::text,
            iva::text, numero::text, numero_factura from factura_compra where id = $1`, [id]);
  const f = cab[0];
  const { rows: lineas } = await tx.query<{ producto_id: string; cantidad: string; base: string; valor_recibido_usd: string; en_existencia: string }>(
    `select l.producto_id, l.cantidad::text, l.base::text, l.valor_recibido_usd::text,
            coalesce((select c.cantidad from producto_costo c where c.producto_id = l.producto_id), 0)::text as en_existencia
       from factura_compra_linea l where l.factura_id = $1 order by l.linea`, [id]);
  const { rows: t } = await tx.query<{ usd: string }>(`select fn_tasa('USD', $1::date)::text as usd`, [f.fecha]);
  const tasaMon = new Decimal(f.tasa);
  const tasaUsd = new Decimal(t[0].usd);
  const enUsd = (orig: Decimal): Decimal => (f.moneda === 'USD' ? dos(orig) : dos(dos(orig.times(tasaMon)).dividedBy(tasaUsd)));

  const cero = new Decimal(0);
  let recibido = cero, aumInv = cero, aumCv = cero, redInv = cero, redCv = cero;
  const ajustes: { productoId: string; usd: Decimal }[] = [];
  for (const l of lineas) {
    const recibidoOrig = f.moneda === 'USD' ? new Decimal(l.valor_recibido_usd) : dos(new Decimal(l.valor_recibido_usd).times(tasaUsd).dividedBy(tasaMon));
    const variacion = new Decimal(l.base).minus(recibidoOrig);
    const enStock = Decimal.min(l.cantidad, l.en_existencia);
    const inv = dos(variacion.times(enStock).dividedBy(l.cantidad));
    const cv = variacion.minus(inv);
    recibido = recibido.plus(recibidoOrig);
    if (inv.gt(0)) aumInv = aumInv.plus(inv); else redInv = redInv.plus(inv.abs());
    if (cv.gt(0)) aumCv = aumCv.plus(cv); else redCv = redCv.plus(cv.abs());
    if (!inv.isZero()) ajustes.push({ productoId: l.producto_id, usd: enUsd(inv.abs()).times(inv.isNegative() ? -1 : 1) });
  }

  // El inventario en USD debe sumar lo mismo que el asiento: la diferencia de redondeo se lleva a la línea mayor.
  const objetivo = enUsd(aumInv).minus(enUsd(redInv));
  const actual = ajustes.reduce((s, a) => s.plus(a.usd), cero);
  if (ajustes.length && !objetivo.equals(actual)) {
    const mayor = ajustes.reduce((m, a) => (a.usd.abs().gt(m.usd.abs()) ? a : m));
    mayor.usd = mayor.usd.plus(objetivo.minus(actual));
  }
  for (const a of ajustes) {
    if (a.usd.isZero()) continue;
    await tx.query(
      `insert into ajuste_costo (producto_id, valor_usd, origen_tipo, origen_id, created_by) values ($1, $2, 'factura_compra', $3, $4)`,
      [a.productoId, a.usd.toFixed(2), id, usuarioId]);
  }

  await tx.query(
    `insert into partida_cxp (proveedor_id, factura_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
     values ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $7)`,
    [f.proveedor_id, id, f.fecha, f.vencimiento, f.moneda, f.tasa, f.total, f.total_usd]);

  const r = await contabilizar(tx, {
    evento: 'factura_compra', fecha: f.fecha, descripcion: `Factura de compra ${f.numero_factura} · registro ${f.numero}`,
    origen: { tipo: 'factura_compra', id }, moneda: f.moneda,
    importes: {
      recibido: recibido.toFixed(2), aum_inv: aumInv.toFixed(2), aum_cv: aumCv.toFixed(2), red_inv: redInv.toFixed(2),
      red_cv: redCv.toFixed(2), iva: f.iva, total: f.total,
    },
    terceroId: f.proveedor_id, usuarioId,
  });
  return r.numero;
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaFactura {
  id: string; numero: string | null; estado: string; numero_factura: string; proveedor: string; orden: string; moneda: string;
  total: string; fecha: string; vencimiento: string;
}

export async function buscarFacturas(db: Db, u: Usuario, filtro: { estado?: string }, limite = 100): Promise<FilaFactura[]> {
  if (!u.roles.some((r) => (ROLES_VEN_COMPRAS as readonly string[]).includes(r))) return [];
  const { rows } = await db.query<FilaFactura>(
    `select f.id, f.numero::text, f.estado, f.numero_factura, p.codigo || ' · ' || t.razon_social as proveedor, o.numero::text as orden, f.moneda,
            f.total::text, to_char(f.fecha_factura, 'DD-MM-YYYY') as fecha, to_char(f.fecha_vencimiento, 'DD-MM-YYYY') as vencimiento
       from factura_compra f join documento_compra o on o.id = f.orden_id
       join proveedor p on p.tercero_id = f.proveedor_id join tercero t on t.id = p.tercero_id
      where ($1 = '' or f.estado = $1) order by f.created_at desc limit $2`, [filtro.estado ?? '', limite]);
  return rows;
}

export interface LineaFactura {
  id: string; linea: number; orden_linea_id: string; codigo: string; descripcion: string; cantidad: string; precio_unitario: string;
  base: string; iva: string; alicuota_pct: string; precio_orden: string | null; dif_precio: string | null; dentro_tolerancia: boolean | null;
}

export interface LineaPorFacturar {
  orden_linea_id: string; codigo: string; descripcion: string; precio_orden: string; recibido: string; facturado: string; por_facturar: string;
}

export interface DetalleFactura {
  id: string; numero: string | null; estado: string; orden_id: string; orden: string; proveedor_id: string; proveedor: string;
  numero_factura: string; numero_control: string; fecha_factura: string; fecha_vencimiento: string; moneda: string; tasa: string | null;
  base_imponible: string; exento: string; iva: string; total: string; total_usd: string; conciliada: boolean | null;
  motivo_retencion: string | null; creado_por_id: string; creado_por: string; aprobado_por: string | null; aprobado_at: string | null;
  rechazo_motivo: string | null; lineas: LineaFactura[]; por_facturar: LineaPorFacturar[]; saldo: string | null;
}

export async function detalleFactura(db: Db, id: string): Promise<DetalleFactura | null> {
  const { rows } = await db.query<Omit<DetalleFactura, 'lineas' | 'por_facturar' | 'saldo'>>(
    `select f.id, f.numero::text, f.estado, f.orden_id, o.numero::text as orden, f.proveedor_id, p.codigo || ' · ' || t.razon_social as proveedor,
            f.numero_factura, f.numero_control, to_char(f.fecha_factura, 'DD-MM-YYYY') as fecha_factura,
            to_char(f.fecha_vencimiento, 'DD-MM-YYYY') as fecha_vencimiento, f.moneda, f.tasa::text, f.base_imponible::text, f.exento::text,
            f.iva::text, f.total::text, f.total_usd::text, f.conciliada, f.motivo_retencion, f.created_by as creado_por_id, cr.nombre as creado_por,
            ap.nombre as aprobado_por, to_char(f.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado_at, f.rechazo_motivo
       from factura_compra f join documento_compra o on o.id = f.orden_id
       join proveedor p on p.tercero_id = f.proveedor_id join tercero t on t.id = p.tercero_id
       join usuario cr on cr.id = f.created_by left join usuario ap on ap.id = f.aprobado_por
      where f.id = $1`, [id]);
  if (!rows[0]) return null;
  const f = rows[0];
  const [lineas, porFacturar, saldo] = await Promise.all([
    db.query<LineaFactura>(
      `select l.id, l.linea, l.orden_linea_id, p.codigo, l.descripcion, l.cantidad::text, l.precio_unitario::text, l.base::text, l.iva::text,
              l.alicuota_pct::text, l.precio_orden::text, l.dif_precio::text, l.dentro_tolerancia
         from factura_compra_linea l join producto p on p.id = l.producto_id where l.factura_id = $1 order by l.linea`, [id]),
    f.estado === 'borrador'
      ? db.query<LineaPorFacturar>(
        `select o.id as orden_linea_id, p.codigo, o.descripcion, o.precio_unitario::text as precio_orden, x.recibido::text,
                fn_orden_linea_facturada(o.id, $2)::text as facturado, (x.recibido - fn_orden_linea_facturada(o.id, $2))::text as por_facturar
           from documento_compra_linea o join producto p on p.id = o.producto_id
           cross join lateral (select coalesce(sum(r.cantidad), 0) as recibido from documento_compra_linea r
                                 join documento_compra d on d.id = r.documento_id and d.estado = 'emitido' where r.linea_origen_id = o.id) x
          where o.documento_id = $1 order by o.linea`, [f.orden_id, id])
      : Promise.resolve({ rows: [] as LineaPorFacturar[] }),
    db.query<{ saldo: string }>('select saldo::text from partida_cxp where factura_id = $1', [id]),
  ]);
  return { ...f, lineas: lineas.rows, por_facturar: porFacturar.rows, saldo: saldo.rows[0]?.saldo ?? null };
}

export interface FilaCxp {
  id: string; factura_id: string | null; gasto_id: string | null; proveedor: string; numero_factura: string; fecha: string; vencimiento: string; moneda: string;
  monto_original: string; saldo: string; saldo_usd: string; dias_vencida: number;
}

/** Cuentas por pagar abiertas, las que vencen primero arriba. */
export async function cuentasPorPagar(db: Db, u: Usuario, limite = 300): Promise<FilaCxp[]> {
  if (!u.roles.some((r) => (ROLES_VEN_COMPRAS as readonly string[]).includes(r))) return [];
  const { rows } = await db.query<FilaCxp>(
    `select c.id, c.factura_id, c.gasto_id, p.codigo || ' · ' || t.razon_social as proveedor, coalesce(f.numero_factura, g.numero_factura) as numero_factura,
            to_char(c.fecha, 'DD-MM-YYYY') as fecha,
            to_char(c.vencimiento, 'DD-MM-YYYY') as vencimiento, c.moneda, c.monto_original::text, c.saldo::text,
            round(c.monto_usd * c.saldo / c.monto_original, 2)::text as saldo_usd,
            greatest(((now() at time zone 'America/Caracas')::date - c.vencimiento), 0)::int as dias_vencida
       from partida_cxp c left join factura_compra f on f.id = c.factura_id left join gasto_importacion g on g.id = c.gasto_id
       join proveedor p on p.tercero_id = c.proveedor_id join tercero t on t.id = p.tercero_id
      where c.estado = 'abierta' order by c.vencimiento, c.created_at limit $1`, [limite]);
  return rows;
}
