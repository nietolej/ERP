import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { cancelarSolicitud, solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { CRITERIOS_REPARTO, mensajeSinMedida, productosSinMedida, type CriterioReparto } from './costo-destino';

/**
 * Orden de compra (§7.1, §7.2). Migración 0023.
 *
 *   borrador (Compras arma las líneas) → enviar → pendiente → Gerencia aprueba o rechaza → aprobada → recepciones
 *
 * La orden guarda el criterio con que se repartirán los gastos de importación (valor, peso, volumen o cantidad):
 * con peso o volumen todos sus productos deben tener esa medida en el maestro. Los totales los calcula la base.
 */

export const ROLES_COMPRAN = ['compras', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_COMPRAS = [
  'compras', 'almacen', 'gerencia', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor',
] as const satisfies readonly Rol[];

export type Usuario = { id: string; roles: readonly string[] };

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const PRECIO = /^\d{1,12}(\.\d{1,4})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const NOMBRE_ESTADO_ORDEN: Record<string, string> = {
  borrador: 'Borrador', pendiente: 'Pendiente de aprobación', aprobada: 'Aprobada', rechazada: 'Rechazada', anulada: 'Anulada',
};

interface Orden { id: string; estado: string; moneda: string; criterio_reparto: CriterioReparto; created_by: string }

async function orden(tx: Db, id: string, bloquear = true): Promise<Orden> {
  const { rows } = await tx.query<Orden>(
    `select id, estado, moneda, criterio_reparto, created_by from documento_compra where id = $1 and tipo = 'orden_compra' ${bloquear ? 'for update' : ''}`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La orden de compra no existe.');
  return rows[0];
}

async function exigirBorrador(tx: Db, id: string): Promise<Orden> {
  const o = await orden(tx, id);
  if (o.estado !== 'borrador') throw new ErrorMaestro('Solo se edita una orden de compra en borrador.');
  return o;
}

export interface DatosOrden {
  proveedorId: string;
  almacenId: string;
  moneda: string;
  criterioReparto?: string;
  /** 'AAAA-MM-DD'. */
  fechaPrometida?: string;
  observaciones?: string;
}

function validar(d: DatosOrden): CriterioReparto {
  const criterio = (d.criterioReparto || 'valor') as CriterioReparto;
  if (!d.proveedorId) throw new ErrorMaestro('Seleccione el proveedor.');
  if (!d.almacenId) throw new ErrorMaestro('Seleccione el almacén donde se recibirá.');
  if (!/^[A-Z]{3,4}$/.test(d.moneda)) throw new ErrorMaestro('Seleccione la moneda de la orden.');
  if (!CRITERIOS_REPARTO.includes(criterio)) throw new ErrorMaestro('Seleccione cómo se repartirán los gastos de importación.');
  if (d.fechaPrometida && !FECHA.test(d.fechaPrometida)) throw new ErrorMaestro('La fecha prometida debe tener el formato dd-mm-aaaa.');
  return criterio;
}

export async function crearOrden(tx: Db, u: Usuario, d: DatosOrden): Promise<string> {
  const criterio = validar(d);
  const { rows: prov } = await tx.query<{ estado: string }>('select estado from proveedor where tercero_id = $1', [d.proveedorId]);
  if (!prov[0]) throw new ErrorMaestro('El proveedor no existe.');
  if (prov[0].estado !== 'activo') throw new ErrorMaestro('El proveedor debe estar activo para comprarle.');
  const { rows: alm } = await tx.query('select 1 from almacen where id = $1 and activo', [d.almacenId]);
  if (!alm.length) throw new ErrorMaestro('El almacén no existe o está inactivo.');
  const { rows: mon } = await tx.query('select 1 from moneda where codigo = $1', [d.moneda]);
  if (!mon.length) throw new ErrorMaestro('La moneda no existe.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into documento_compra (tipo, proveedor_id, almacen_id, moneda, criterio_reparto, fecha_prometida, observaciones, created_by)
     values ('orden_compra', $1, $2, $3, $4, $5, $6, $7) returning id`,
    [d.proveedorId, d.almacenId, d.moneda, criterio, d.fechaPrometida || null, d.observaciones?.trim() || null, u.id]);
  return rows[0].id;
}

/** Cambia los datos de la orden mientras está en borrador. Si ya tiene líneas, no se cambia la moneda. */
export async function actualizarOrden(tx: Db, id: string, d: DatosOrden): Promise<void> {
  const o = await exigirBorrador(tx, id);
  const criterio = validar(d);
  const { rows: l } = await tx.query('select 1 from documento_compra_linea where documento_id = $1', [id]);
  if (l.length && d.moneda !== o.moneda) throw new ErrorMaestro('No se cambia la moneda de una orden que ya tiene productos.');
  await tx.query(
    `update documento_compra set almacen_id = $2, moneda = $3, criterio_reparto = $4, fecha_prometida = $5, observaciones = $6 where id = $1`,
    [id, d.almacenId, d.moneda, criterio, d.fechaPrometida || null, d.observaciones?.trim() || null]);
}

/** Agrega (o reemplaza) un producto de la orden. */
export async function guardarLinea(
  tx: Db, ordenId: string, d: { productoId: string; cantidad: string; precio: string },
): Promise<void> {
  await exigirBorrador(tx, ordenId);
  const cantidad = d.cantidad.trim();
  const precio = d.precio.trim();
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser un número mayor que cero, con hasta 4 decimales.');
  if (!PRECIO.test(precio)) throw new ErrorMaestro('El precio debe ser un monto con hasta 4 decimales.');
  const { rows } = await tx.query<{ descripcion: string; codigo: string }>('select codigo, descripcion from producto where id = $1', [d.productoId]);
  if (!rows[0]) throw new ErrorMaestro('El producto no existe.');
  await tx.query('delete from documento_compra_linea where documento_id = $1 and producto_id = $2', [ordenId, d.productoId]);
  await tx.query(
    `insert into documento_compra_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario)
     values ($1, (select coalesce(max(linea), 0) + 1 from documento_compra_linea where documento_id = $1), $2, $3, $4, $5)`,
    [ordenId, d.productoId, rows[0].descripcion, cantidad, precio]);
}

export async function quitarLinea(tx: Db, ordenId: string, lineaId: string): Promise<void> {
  await exigirBorrador(tx, ordenId);
  await tx.query('delete from documento_compra_linea where id = $2 and documento_id = $1', [ordenId, lineaId]);
}

export async function eliminarBorrador(tx: Db, ordenId: string): Promise<void> {
  await exigirBorrador(tx, ordenId);
  await tx.query('delete from documento_compra where id = $1', [ordenId]);
}

/** Envía la orden a aprobación: calcula sus totales a la tasa del día, recibe su número y ya no se edita. */
export async function enviarOrden(tx: Db, u: Usuario, id: string): Promise<void> {
  const o = await exigirBorrador(tx, id);
  const { rows: lineas } = await tx.query<{ codigo: string; peso: string | null; volumen: string | null }>(
    `select p.codigo, p.peso_kg::text as peso, p.volumen_unitario_m3::text as volumen
       from documento_compra_linea l join producto p on p.id = l.producto_id where l.documento_id = $1`, [id]);
  if (!lineas.length) throw new ErrorMaestro('Agregue al menos un producto a la orden.');
  const faltan = productosSinMedida(lineas.map((l) => ({ codigo: l.codigo, pesoUnitarioKg: l.peso, volumenUnitarioM3: l.volumen })), o.criterio_reparto);
  if (faltan.length) throw new ErrorMaestro(mensajeSinMedida(o.criterio_reparto, faltan));

  await tx.query('select fn_compra_calcular($1)', [id]);
  const { rows } = await tx.query<{ total_usd: string }>(
    `update documento_compra set estado = 'pendiente' where id = $1 returning total_usd::text`, [id]);
  await solicitarAprobacion(tx, { tipo: 'orden_compra', objetoId: id, solicitanteId: u.id, contexto: { valor_usd: Number(rows[0].total_usd) } });
}

/** Lo llama el motor de flujo cuando Gerencia aprueba (la base exige que sea Gerencia y no quien la creó). */
export async function aprobarOrden(tx: Db, id: string, aprobador: string): Promise<void> {
  const o = await orden(tx, id);
  if (o.estado !== 'pendiente') throw new ErrorMaestro('La orden de compra no está pendiente de aprobación.');
  await tx.query(`update documento_compra set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, aprobador]);
}

/** Lo llama el motor de flujo cuando Gerencia rechaza. */
export async function rechazarOrden(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const o = await orden(tx, id);
  if (o.estado !== 'pendiente') throw new ErrorMaestro('La orden de compra no está pendiente de aprobación.');
  await tx.query(`update documento_compra set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

/** Anula una orden pendiente o aprobada que no tenga mercancía recibida. */
export async function anularOrden(tx: Db, u: Usuario, id: string, motivo: string): Promise<void> {
  const o = await orden(tx, id);
  if (o.estado !== 'pendiente' && o.estado !== 'aprobada') throw new ErrorMaestro('Solo se anula una orden pendiente o aprobada.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  await tx.query(`update documento_compra set estado = 'anulada', anulado_por = $2, anulado_motivo = $3 where id = $1`, [id, u.id, motivo.trim()]);
  if (o.estado === 'pendiente') await cancelarSolicitud(tx, 'orden_compra', id);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaOrden {
  id: string; numero: string | null; estado: string; proveedor: string; almacen: string; moneda: string; total: string; fecha: string;
  fecha_prometida: string | null; pendiente: string;
}

export async function buscarOrdenes(db: Db, u: Usuario, filtro: { estado?: string; proveedorId?: string }, limite = 100): Promise<FilaOrden[]> {
  if (!u.roles.some((r) => (ROLES_VEN_COMPRAS as readonly string[]).includes(r))) return [];
  const { rows } = await db.query<FilaOrden>(
    `select d.id, d.numero::text, d.estado, p.codigo || ' · ' || t.razon_social as proveedor, a.codigo as almacen, d.moneda,
            d.total::text, to_char(d.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha,
            to_char(d.fecha_prometida, 'DD-MM-YYYY') as fecha_prometida,
            coalesce((select sum(l.cantidad - fn_orden_linea_recibida(l.id)) from documento_compra_linea l where l.documento_id = d.id), 0)::text as pendiente
       from documento_compra d
       join proveedor p on p.tercero_id = d.proveedor_id join tercero t on t.id = p.tercero_id
       join almacen a on a.id = d.almacen_id
      where d.tipo = 'orden_compra' and ($1 = '' or d.estado = $1) and ($2::uuid is null or d.proveedor_id = $2::uuid)
      order by d.created_at desc limit $3`,
    [filtro.estado ?? '', filtro.proveedorId ?? null, limite]);
  return rows;
}

export interface LineaOrden {
  id: string; linea: number; producto_id: string; codigo: string; descripcion: string; unidad: string; cantidad: string;
  precio_unitario: string; total: string; recibida: string; pendiente: string; peso_kg: string | null; volumen_unitario_m3: string | null;
}

export interface DetalleOrden {
  id: string; numero: string | null; estado: string; proveedor_id: string; proveedor: string; almacen_id: string; almacen: string;
  moneda: string; tasa: string | null; criterio_reparto: CriterioReparto; fecha_prometida: string | null; observaciones: string | null;
  subtotal: string; total: string; total_usd: string; creado_por_id: string; creado_por: string; fecha: string;
  aprobado_por: string | null; aprobado_at: string | null; rechazo_motivo: string | null; anulado_motivo: string | null;
  lineas: LineaOrden[]; recepciones: { id: string; numero: string; fecha: string; total_usd: string }[];
}

export async function detalleOrden(db: Db, id: string): Promise<DetalleOrden | null> {
  const { rows } = await db.query<Omit<DetalleOrden, 'lineas' | 'recepciones'>>(
    `select d.id, d.numero::text, d.estado, d.proveedor_id, p.codigo || ' · ' || t.razon_social as proveedor, d.almacen_id,
            a.codigo || ' · ' || a.nombre as almacen, d.moneda, d.tasa::text, d.criterio_reparto,
            to_char(d.fecha_prometida, 'DD-MM-YYYY') as fecha_prometida, d.observaciones, d.subtotal::text, d.total::text, d.total_usd::text,
            d.created_by as creado_por_id, cr.nombre as creado_por, to_char(d.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha,
            ap.nombre as aprobado_por, to_char(d.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado_at,
            d.rechazo_motivo, d.anulado_motivo
       from documento_compra d
       join proveedor p on p.tercero_id = d.proveedor_id join tercero t on t.id = p.tercero_id
       join almacen a on a.id = d.almacen_id join usuario cr on cr.id = d.created_by left join usuario ap on ap.id = d.aprobado_por
      where d.id = $1 and d.tipo = 'orden_compra'`, [id]);
  if (!rows[0]) return null;
  const [lineas, recepciones] = await Promise.all([
    db.query<LineaOrden>(
      `select l.id, l.linea, l.producto_id, p.codigo, l.descripcion, p.unidad, l.cantidad::text, l.precio_unitario::text, l.total::text,
              fn_orden_linea_recibida(l.id)::text as recibida, (l.cantidad - fn_orden_linea_recibida(l.id))::text as pendiente,
              p.peso_kg::text, p.volumen_unitario_m3::text
         from documento_compra_linea l join producto p on p.id = l.producto_id where l.documento_id = $1 order by l.linea`, [id]),
    db.query<{ id: string; numero: string; fecha: string; total_usd: string }>(
      `select id, numero::text, to_char(fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, total_usd::text
         from documento_compra where orden_id = $1 and estado = 'emitido' order by numero`, [id]),
  ]);
  return { ...rows[0], lineas: lineas.rows, recepciones: recepciones.rows };
}
