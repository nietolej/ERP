import Decimal from 'decimal.js';
import { guardarAdjunto } from '@/lib/adjuntos/adjuntos';
import type { AlmacenArchivos } from '@/lib/adjuntos/almacen';
import { calcularRetenciones, guardarRetenciones, sumaRetenciones } from '@/lib/compras/retenciones';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/errores';
import { ROLES_CATEGORIAS, ROLES_REGISTRAN_GASTO, ROLES_VEN_GASTOS } from './roles';

/**
 * Categorías de gasto y factura de gasto de un proveedor (spec §10.1; migración 0040).
 *
 *   registrar con su soporte (pendiente, no mueve nada) → Gerencia (distinta de quien la registró) aprueba → retenciones de IVA e ISLR,
 *   cuenta por pagar (neta de retención) y asiento, todo en la misma transacción. La cuenta por pagar se paga como cualquier otra (§7.3).
 *
 * El IVA es crédito fiscal solo si la categoría lo permite; si no, se suma al gasto (R-CH).
 */

export { ROLES_CATEGORIAS, ROLES_REGISTRAN_GASTO, ROLES_VEN_GASTOS };

export type UsuarioGasto = { id: string; roles: readonly string[] };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^\d{1,12}(\.\d{1,2})?$/;
const CODIGO = /^[A-Z0-9_]{2,30}$/;
const dos = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const NOMBRE_ESTADO_GASTO: Record<string, string> = { pendiente: 'Pendiente de Gerencia', contabilizado: 'Contabilizado', rechazado: 'Rechazado' };

// ---------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------

export interface Categoria {
  id: string; codigo: string; nombre: string; cuenta: string; cuenta_id: string; centro_costo: string | null; centro_costo_id: string | null;
  iva_deducible: boolean; activa: boolean;
}

export async function listarCategorias(db: Db, soloActivas = false): Promise<Categoria[]> {
  const { rows } = await db.query<Categoria>(
    `select k.id, k.codigo, k.nombre, c.codigo || ' · ' || c.nombre as cuenta, k.cuenta_contable_id as cuenta_id,
            cc.codigo || ' · ' || cc.nombre as centro_costo, k.centro_costo_id, k.iva_deducible, k.activa
       from categoria_gasto k join cuenta_contable c on c.id = k.cuenta_contable_id left join centro_costo cc on cc.id = k.centro_costo_id
      where ($1 = false or k.activa) order by k.activa desc, k.nombre`, [soloActivas]);
  return rows;
}

export interface DatosCategoria { codigo: string; nombre: string; cuentaId: string; centroCostoId?: string; ivaDeducible: boolean }

function validarCategoria(d: DatosCategoria) {
  if (!CODIGO.test(d.codigo.trim().toUpperCase())) throw new ErrorMaestro('El código admite letras, números y guion bajo (2 a 30 caracteres).');
  if (d.nombre.trim().length < 3) throw new ErrorMaestro('Indique el nombre de la categoría.');
  if (!d.cuentaId) throw new ErrorMaestro('Seleccione la cuenta contable de gasto.');
}

export async function crearCategoria(tx: Db, u: UsuarioGasto, d: DatosCategoria): Promise<string> {
  if (!u.roles.some((r) => (ROLES_CATEGORIAS as readonly string[]).includes(r))) throw new ErrorMaestro('No tiene permiso para crear categorías de gasto.');
  validarCategoria(d);
  const { rows: dup } = await tx.query('select 1 from categoria_gasto where codigo = $1', [d.codigo.trim().toUpperCase()]);
  if (dup.length) throw new ErrorMaestro('Ya existe una categoría con ese código.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into categoria_gasto (codigo, nombre, cuenta_contable_id, centro_costo_id, iva_deducible) values ($1, $2, $3, $4, $5) returning id`,
    [d.codigo.trim().toUpperCase(), d.nombre.trim(), d.cuentaId, d.centroCostoId || null, d.ivaDeducible]);
  return rows[0].id;
}

/** Cambia nombre, cuenta, centro de costo e IVA de una categoría hacia adelante: los gastos ya registrados conservan lo suyo. */
export async function actualizarCategoria(tx: Db, u: UsuarioGasto, id: string, d: Omit<DatosCategoria, 'codigo'>): Promise<void> {
  if (!u.roles.some((r) => (ROLES_CATEGORIAS as readonly string[]).includes(r))) throw new ErrorMaestro('No tiene permiso para editar categorías de gasto.');
  validarCategoria({ ...d, codigo: 'AA' });
  const { rows } = await tx.query(
    `update categoria_gasto set nombre = $2, cuenta_contable_id = $3, centro_costo_id = $4, iva_deducible = $5 where id = $1 returning id`,
    [id, d.nombre.trim(), d.cuentaId, d.centroCostoId || null, d.ivaDeducible]);
  if (!rows[0]) throw new ErrorMaestro('La categoría no existe.');
}

export async function cambiarEstadoCategoria(tx: Db, u: UsuarioGasto, id: string, activa: boolean): Promise<void> {
  if (!u.roles.some((r) => (ROLES_CATEGORIAS as readonly string[]).includes(r))) throw new ErrorMaestro('No tiene permiso para editar categorías de gasto.');
  const { rows } = await tx.query('update categoria_gasto set activa = $2 where id = $1 returning id', [id, activa]);
  if (!rows[0]) throw new ErrorMaestro('La categoría no existe.');
}

export async function cuentasDeGasto(db: Db): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(
    `select id, codigo || ' · ' || nombre as texto from cuenta_contable where tipo = 'gasto' and imputable and activa order by codigo`);
  return rows;
}

export async function centrosDeCosto(db: Db): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(`select id, codigo || ' · ' || nombre as texto from centro_costo where activo order by codigo`);
  return rows;
}

// ---------------------------------------------------------------------
// Factura de gasto de un proveedor
// ---------------------------------------------------------------------

export interface DatosGastoProveedor {
  proveedorId: string;
  categoriaId: string;
  descripcion: string;
  numeroFactura: string;
  numeroControl: string;
  fechaFactura: string;
  fechaVencimiento?: string;
  moneda: string;
  /** Monto sin IVA. */
  base: string;
  alicuotaIvaId: string;
  retencionIvaTotal?: boolean;
}

export interface Soporte { almacen: AlmacenArchivos; nombre: string; bytes: Uint8Array }

/** Registra la factura de gasto con su soporte y la deja pendiente de Gerencia; no mueve nada. */
export async function crearGastoProveedor(tx: Db, u: UsuarioGasto, d: DatosGastoProveedor, soporte: Soporte): Promise<{ id: string; numero: string }> {
  if (!u.roles.some((r) => (ROLES_REGISTRAN_GASTO as readonly string[]).includes(r))) throw new ErrorMaestro('No tiene permiso para registrar gastos.');
  if (!d.proveedorId) throw new ErrorMaestro('Seleccione el proveedor.');
  if (!d.categoriaId) throw new ErrorMaestro('Seleccione la categoría del gasto.');
  if (d.descripcion.trim().length < 3) throw new ErrorMaestro('Describa el gasto.');
  const numero = d.numeroFactura.trim();
  if (!numero || numero.length > 40) throw new ErrorMaestro('Indique el número de la factura del proveedor (hasta 40 caracteres).');
  const control = d.numeroControl.trim();
  if (!control || control.length > 40) throw new ErrorMaestro('Indique el número de control de la factura del proveedor.');
  if (!FECHA.test(d.fechaFactura)) throw new ErrorMaestro('Indique la fecha de la factura.');
  if (d.fechaVencimiento && !FECHA.test(d.fechaVencimiento)) throw new ErrorMaestro('La fecha de vencimiento no es válida.');
  if (!/^[A-Z]{3,4}$/.test(d.moneda)) throw new ErrorMaestro('Seleccione la moneda de la factura.');
  if (!MONTO.test(d.base.trim()) || new Decimal(d.base).lte(0)) throw new ErrorMaestro('El monto debe ser mayor que cero, con hasta 2 decimales.');
  if (!d.alicuotaIvaId) throw new ErrorMaestro('Seleccione la alícuota de IVA de la factura.');
  if (!soporte?.bytes?.length) throw new ErrorMaestro('Adjunte el soporte de la factura (PDF o imagen).');

  const { rows: dup } = await tx.query(
    `select 1 from gasto_proveedor where proveedor_id = $1 and upper(trim(numero_factura)) = upper($2) and estado <> 'rechazado'
     union all select 1 from gasto_importacion where proveedor_id = $1 and upper(trim(numero_factura)) = upper($2)
     union all select 1 from factura_compra where proveedor_id = $1 and upper(trim(numero_factura)) = upper($2) and estado in ('borrador', 'retenida', 'contabilizada')`,
    [d.proveedorId, numero]);
  if (dup.length) throw new ErrorMaestro(`Ese proveedor ya tiene registrada la factura ${numero.toUpperCase()}.`);

  const { rows: cp } = await tx.query<{ dias: number | null }>(
    `select cp.dias from proveedor p left join condicion_pago cp on cp.id = p.condicion_pago_id where p.tercero_id = $1`, [d.proveedorId]);
  const { rows } = await tx.query<{ id: string; numero: string; total_usd: string }>(
    `insert into gasto_proveedor (proveedor_id, categoria_id, descripcion, numero_factura, numero_control, fecha_factura, fecha_vencimiento, moneda,
                                  base, alicuota_iva_id, retencion_iva_total, created_by, tasa, alicuota_pct, iva, total, total_usd, iva_deducible)
     values ($1, $2, $3, $4, $5, $6::date, coalesce($7::date, $6::date + $8::int), $9, $10, $11, $12, $13, 1, 0, 0, 0, 0, true)
     returning id, numero::text, total_usd::text`,
    [d.proveedorId, d.categoriaId, d.descripcion.trim(), numero, control, d.fechaFactura, d.fechaVencimiento || null, cp[0]?.dias ?? 0, d.moneda,
     d.base.trim(), d.alicuotaIvaId, d.retencionIvaTotal ?? false, u.id]);
  await guardarAdjunto(tx, soporte.almacen, u.id, { tipo: 'gasto_proveedor', entidadId: rows[0].id, nombre: soporte.nombre, bytes: soporte.bytes });
  await solicitarAprobacion(tx, { tipo: 'gasto_proveedor', objetoId: rows[0].id, solicitanteId: u.id, contexto: { valor_usd: new Decimal(rows[0].total_usd).toNumber() } });
  return { id: rows[0].id, numero: rows[0].numero };
}

export interface ResultadoGastoProveedor { asiento: string }

/**
 * Lo llama el motor de flujo cuando Gerencia aprueba: marca el gasto (la base exige Gerencia y distinta de quien lo registró),
 * practica las retenciones, abre la cuenta por pagar por el neto y genera el asiento.
 */
export async function aprobarGastoProveedor(tx: Db, id: string, aprobador: string): Promise<ResultadoGastoProveedor> {
  const { rows } = await tx.query<{
    estado: string; proveedor_id: string; categoria_id: string; moneda: string; tasa: string; fecha: string; vencimiento: string; base: string; iva: string;
    total: string; total_usd: string; numero: string; numero_factura: string; descripcion: string; iva_deducible: boolean; iva_total: boolean;
    cuenta_id: string; centro_costo_id: string | null;
  }>(
    `select g.estado, g.proveedor_id, g.categoria_id, g.moneda, g.tasa::text, g.fecha_factura::text as fecha, g.fecha_vencimiento::text as vencimiento,
            g.base::text, g.iva::text, g.total::text, g.total_usd::text, g.numero::text, g.numero_factura, g.descripcion, g.iva_deducible,
            g.retencion_iva_total as iva_total, k.cuenta_contable_id as cuenta_id, k.centro_costo_id
       from gasto_proveedor g join categoria_gasto k on k.id = g.categoria_id where g.id = $1 for update of g`, [id]);
  const g = rows[0];
  if (!g) throw new ErrorMaestro('La factura de gasto no existe.');
  if (g.estado !== 'pendiente') throw new ErrorMaestro('La factura de gasto no está pendiente de aprobación.');
  await tx.query(`update gasto_proveedor set estado = 'contabilizado', aprobado_por = $2 where id = $1`, [id, aprobador]);

  const { rows: t } = await tx.query<{ usd: string }>(`select fn_tasa('USD', $1::date)::text as usd`, [g.fecha]);
  const tasaMon = new Decimal(g.tasa);
  const tasaUsd = new Decimal(t[0].usd);
  const enUsd = (orig: Decimal): Decimal => (g.moneda === 'USD' ? dos(orig) : dos(dos(orig.times(tasaMon)).dividedBy(tasaUsd)));

  const retenciones = await calcularRetenciones(tx, {
    proveedorId: g.proveedor_id, fecha: g.fecha, tasa: g.tasa, baseSinIva: g.base, iva: g.iva, ivaTotal: g.iva_total,
  });
  const retIva = sumaRetenciones(retenciones, 'iva');
  const retIslr = sumaRetenciones(retenciones, 'islr');
  const neto = new Decimal(g.total).minus(retIva).minus(retIslr);
  await guardarRetenciones(tx, { gastoProveedorId: id }, { proveedorId: g.proveedor_id, fecha: g.fecha, moneda: g.moneda, tasa: g.tasa }, retenciones, enUsd);
  await tx.query(
    `insert into partida_cxp (proveedor_id, gasto_proveedor_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
     values ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $7)`,
    [g.proveedor_id, id, g.fecha, g.vencimiento, g.moneda, g.tasa, neto.toFixed(2), retenciones.length ? enUsd(neto).toFixed(2) : g.total_usd]);

  const gasto = g.iva_deducible ? new Decimal(g.base) : new Decimal(g.total);
  const iva = g.iva_deducible ? g.iva : '0.00';
  const r = await contabilizar(tx, {
    evento: 'gasto_proveedor', fecha: g.fecha, descripcion: `Gasto ${g.numero} · ${g.descripcion} · factura ${g.numero_factura}`,
    origen: { tipo: 'gasto_proveedor', id }, moneda: g.moneda,
    importes: { gasto: gasto.toFixed(2), iva, neto: neto.toFixed(2), ret_iva: retIva.toFixed(2), ret_islr: retIslr.toFixed(2) },
    cuentas: { gasto: g.cuenta_id }, centroCostoId: g.centro_costo_id ?? undefined, terceroId: g.proveedor_id, usuarioId: aprobador,
  });
  return { asiento: r.numero };
}

export async function rechazarGastoProveedor(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from gasto_proveedor where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La factura de gasto no existe.');
  if (rows[0].estado !== 'pendiente') throw new ErrorMaestro('La factura de gasto no está pendiente de aprobación.');
  await tx.query(`update gasto_proveedor set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

const puedeVer = (u: UsuarioGasto) => u.roles.some((r) => (ROLES_VEN_GASTOS as readonly string[]).includes(r));

export interface FilaGastoProveedor {
  id: string; numero: string; estado: string; proveedor: string; categoria: string; numero_factura: string; fecha: string; moneda: string; total: string;
}

export async function buscarGastosProveedor(db: Db, u: UsuarioGasto, filtro: { estado?: string; texto?: string } = {}, limite = 150): Promise<FilaGastoProveedor[]> {
  if (!puedeVer(u)) return [];
  const { rows } = await db.query<FilaGastoProveedor>(
    `select g.id, g.numero::text, g.estado, p.codigo || ' · ' || t.razon_social as proveedor, k.nombre as categoria, g.numero_factura,
            to_char(g.fecha_factura, 'DD-MM-YYYY') as fecha, g.moneda, g.total::text
       from gasto_proveedor g join proveedor p on p.tercero_id = g.proveedor_id join tercero t on t.id = g.proveedor_id
       join categoria_gasto k on k.id = g.categoria_id
      where ($1 = '' or g.estado = $1)
        and ($2 = '' or g.numero::text = $2 or upper(g.numero_factura) like '%' || upper($2) || '%' or p.codigo ilike '%' || $2 || '%'
             or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($2) || '%')
      order by g.created_at desc limit $3`, [filtro.estado ?? '', (filtro.texto ?? '').trim(), limite]);
  return rows;
}

export interface DetalleGastoProveedor {
  id: string; numero: string; estado: string; proveedor_id: string; proveedor: string; categoria: string; cuenta: string; descripcion: string;
  numero_factura: string; numero_control: string; fecha_factura: string; fecha_vencimiento: string; moneda: string; tasa: string; base: string;
  alicuota_pct: string; iva: string; total: string; total_usd: string; iva_deducible: boolean; retencion_iva_total: boolean; creador_id: string;
  creador: string; creado: string; aprobado_por: string | null; aprobado: string | null; rechazo_motivo: string | null; asiento: string | null; saldo: string | null;
}

export async function detalleGastoProveedor(db: Db, id: string): Promise<DetalleGastoProveedor | null> {
  const { rows } = await db.query<DetalleGastoProveedor>(
    `select g.id, g.numero::text, g.estado, g.proveedor_id, p.codigo || ' · ' || t.razon_social as proveedor, k.nombre as categoria,
            c.codigo || ' · ' || c.nombre as cuenta, g.descripcion, g.numero_factura, g.numero_control, g.fecha_factura::text, g.fecha_vencimiento::text,
            g.moneda, g.tasa::text, g.base::text, g.alicuota_pct::text, g.iva::text, g.total::text, g.total_usd::text, g.iva_deducible, g.retencion_iva_total,
            g.created_by as creador_id, cr.nombre as creador, to_char(g.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creado,
            ap.nombre as aprobado_por, to_char(g.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado, g.rechazo_motivo,
            a.numero::text as asiento, (select x.saldo::text from partida_cxp x where x.gasto_proveedor_id = g.id) as saldo
       from gasto_proveedor g join proveedor p on p.tercero_id = g.proveedor_id join tercero t on t.id = g.proveedor_id
       join categoria_gasto k on k.id = g.categoria_id join cuenta_contable c on c.id = k.cuenta_contable_id
       join usuario cr on cr.id = g.created_by left join usuario ap on ap.id = g.aprobado_por
       left join asiento a on a.origen_tipo = 'gasto_proveedor' and a.origen_id = g.id and a.tipo = 'automatico'
      where g.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Proveedores activos y alícuotas para el formulario. */
export async function opcionesGasto(db: Db) {
  const [proveedores, alicuotas, monedas] = await Promise.all([
    db.query<{ id: string; texto: string }>(
      `select p.tercero_id as id, p.codigo || ' · ' || t.razon_social as texto from proveedor p join tercero t on t.id = p.tercero_id
        where p.estado = 'activo' order by t.razon_social limit 500`),
    db.query<{ id: string; texto: string }>(`select id, nombre as texto from alicuota_iva where activa order by nombre`),
    db.query<{ codigo: string }>(`select codigo from moneda where activa order by codigo`),
  ]);
  return { proveedores: proveedores.rows, alicuotas: alicuotas.rows, monedas: monedas.rows.map((m) => m.codigo) };
}
