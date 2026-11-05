import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { cancelarSolicitud, solicitarAprobacion } from '@/lib/flujo/flujo';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Producción o ensamblaje: órdenes simples, sin listas de materiales (spec §8.4, decisión 12; migración 0043).
 *
 *   borrador (producto, cantidad, almacén, componentes) → enviar → Gerencia (distinta de quien la creó) libera → en proceso → terminar
 *
 * Liberar no reserva nada. Terminar, en una sola transacción: los componentes salen del almacén de la orden al costo promedio vigente y el
 * producto terminado entra al costo de la suma de esos costos. No se consume más de lo disponible ni se termina con un componente faltante.
 */

export const ROLES_PRODUCEN = ['almacen', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_PRODUCCION = ['almacen', 'gerencia', 'compras', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

export type UsuarioProd = { id: string; roles: readonly string[] };
const tiene = (u: UsuarioProd, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;

export const NOMBRE_ESTADO_ORDEN: Record<string, string> = {
  borrador: 'Borrador', pendiente: 'Pendiente de Gerencia', liberada: 'Liberada', en_proceso: 'En proceso', terminada: 'Terminada', rechazada: 'Rechazada', anulada: 'Anulada',
};

interface Orden { id: string; estado: string; producto_id: string; cantidad: string; almacen_id: string; created_by: string; numero: string }

async function orden(tx: Db, id: string): Promise<Orden> {
  const { rows } = await tx.query<Orden>(
    'select id, estado, producto_id, cantidad::text, almacen_id, created_by, numero::text from orden_produccion where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La orden de producción no existe.');
  return rows[0];
}

function exigirRol(u: UsuarioProd) {
  if (!tiene(u, ROLES_PRODUCEN)) throw new ErrorMaestro('Solo Almacén o Gerencia manejan órdenes de producción.');
}

async function exigirAlmacen(tx: Db, u: UsuarioProd, almacenId: string) {
  exigirRol(u);
  if (!(await almacenesVisibles(tx, u)).includes(almacenId)) throw new ErrorMaestro('Ese almacén no está entre los suyos.');
}

function leerCantidad(v: string, nombre: string): string {
  const t = v.trim().replace(',', '.');
  if (!CANTIDAD.test(t) || new Decimal(t).lte(0)) throw new ErrorMaestro(`${nombre} debe ser mayor que cero, con hasta 4 decimales.`);
  return t;
}

async function exigirBorrador(tx: Db, u: UsuarioProd, id: string): Promise<Orden> {
  const o = await orden(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'borrador') throw new ErrorMaestro('Solo se edita una orden en borrador.');
  return o;
}

export interface DatosOrden { productoId: string; cantidad: string; almacenId: string; observaciones?: string }

export async function crearOrden(tx: Db, u: UsuarioProd, d: DatosOrden): Promise<{ id: string; numero: string }> {
  await exigirAlmacen(tx, u, d.almacenId);
  if (!d.productoId) throw new ErrorMaestro('Seleccione el producto terminado.');
  const { rows } = await tx.query<{ id: string; numero: string }>(
    `insert into orden_produccion (producto_id, cantidad, almacen_id, observaciones, created_by) values ($1, $2, $3, nullif(trim($4), ''), $5) returning id, numero::text`,
    [d.productoId, leerCantidad(d.cantidad, 'La cantidad a producir'), d.almacenId, d.observaciones ?? '', u.id]);
  return rows[0];
}

export async function actualizarOrden(tx: Db, u: UsuarioProd, id: string, d: DatosOrden): Promise<void> {
  await exigirBorrador(tx, u, id);
  await exigirAlmacen(tx, u, d.almacenId);
  const { rows: comp } = await tx.query('select 1 from orden_produccion_componente where orden_id = $1 and producto_id = $2', [id, d.productoId]);
  if (comp.length) throw new ErrorMaestro('El producto terminado ya está como componente: quítelo primero.');
  await tx.query('update orden_produccion set producto_id = $2, cantidad = $3, almacen_id = $4, observaciones = nullif(trim($5), \'\') where id = $1',
    [id, d.productoId, leerCantidad(d.cantidad, 'La cantidad a producir'), d.almacenId, d.observaciones ?? '']);
}

export async function guardarComponente(tx: Db, u: UsuarioProd, ordenId: string, d: { productoId: string; cantidad: string }): Promise<void> {
  await exigirBorrador(tx, u, ordenId);
  if (!d.productoId) throw new ErrorMaestro('Seleccione el componente.');
  const cantidad = leerCantidad(d.cantidad, 'La cantidad del componente');
  const { rows: previo } = await tx.query<{ id: string }>('select id from orden_produccion_componente where orden_id = $1 and producto_id = $2', [ordenId, d.productoId]);
  if (previo[0]) {
    await tx.query('update orden_produccion_componente set cantidad = $2 where id = $1', [previo[0].id, cantidad]);
    return;
  }
  const { rows: sig } = await tx.query<{ n: number }>('select coalesce(max(linea), 0) + 1 as n from orden_produccion_componente where orden_id = $1', [ordenId]);
  await tx.query('insert into orden_produccion_componente (orden_id, linea, producto_id, cantidad) values ($1, $2, $3, $4)', [ordenId, sig[0].n, d.productoId, cantidad]);
}

export async function quitarComponente(tx: Db, u: UsuarioProd, ordenId: string, componenteId: string): Promise<void> {
  await exigirBorrador(tx, u, ordenId);
  const { rows } = await tx.query('delete from orden_produccion_componente where id = $1 and orden_id = $2 returning id', [componenteId, ordenId]);
  if (!rows[0]) throw new ErrorMaestro('El componente no existe.');
}

export async function eliminarBorrador(tx: Db, u: UsuarioProd, id: string): Promise<void> {
  await exigirBorrador(tx, u, id);
  await tx.query('delete from orden_produccion_componente where orden_id = $1', [id]);
  await tx.query('delete from orden_produccion where id = $1', [id]);
}

/** Envía la orden a Gerencia: queda pendiente y no mueve nada. */
export async function enviarOrden(tx: Db, u: UsuarioProd, id: string): Promise<void> {
  const o = await exigirBorrador(tx, u, id);
  await tx.query(`update orden_produccion set estado = 'pendiente' where id = $1`, [id]);
  await solicitarAprobacion(tx, { tipo: 'orden_produccion', objetoId: id, solicitanteId: u.id, contexto: { cantidad: new Decimal(o.cantidad).toNumber() } });
}

/** Lo llama el motor de flujo cuando Gerencia aprueba: la orden queda liberada (la base exige Gerencia y distinta de quien la creó). */
export async function aprobarOrden(tx: Db, id: string, aprobador: string): Promise<void> {
  const o = await orden(tx, id);
  if (o.estado !== 'pendiente') throw new ErrorMaestro('La orden no está pendiente de aprobación.');
  await tx.query(`update orden_produccion set estado = 'liberada', aprobado_por = $2 where id = $1`, [id, aprobador]);
}

export async function rechazarOrden(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const o = await orden(tx, id);
  if (o.estado !== 'pendiente') throw new ErrorMaestro('La orden no está pendiente de aprobación.');
  await tx.query(`update orden_produccion set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

export async function iniciarOrden(tx: Db, u: UsuarioProd, id: string): Promise<void> {
  const o = await orden(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'liberada') throw new ErrorMaestro('Solo se pone en proceso una orden liberada.');
  await tx.query(`update orden_produccion set estado = 'en_proceso', iniciada_por = $2 where id = $1`, [id, u.id]);
}

export interface FaltanteComponente { codigo: string; necesario: string; disponible: string }

/** Existencia disponible (menos lo reservado) de cada componente en el almacén de la orden y lo que falta. */
export async function faltantesDe(db: Db, ordenId: string): Promise<FaltanteComponente[]> {
  const { rows } = await db.query<FaltanteComponente>(
    `select p.codigo, c.cantidad::text as necesario, greatest(coalesce(e.cantidad - e.reservado, 0), 0)::text as disponible
       from orden_produccion o join orden_produccion_componente c on c.orden_id = o.id join producto p on p.id = c.producto_id
       left join existencia e on e.producto_id = c.producto_id and e.almacen_id = o.almacen_id
      where o.id = $1 and greatest(coalesce(e.cantidad - e.reservado, 0), 0) < c.cantidad order by c.linea`, [ordenId]);
  return rows;
}

export interface ResultadoTerminar { costoTotalUsd: string; costoUnitarioUsd: string; redondeo: string }

/** Termina la orden: consume los componentes al costo promedio y da entrada al terminado, todo en la misma transacción. */
export async function terminarOrden(tx: Db, u: UsuarioProd, id: string): Promise<ResultadoTerminar> {
  const o = await orden(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'en_proceso') throw new ErrorMaestro('Solo se termina una orden en proceso.');
  const faltan = await faltantesDe(tx, id);
  if (faltan.length) {
    throw new ErrorMaestro(`No hay existencia suficiente para terminar la orden: ${faltan.map((f) => `${f.codigo} (necesita ${new Decimal(f.necesario).toString()}, hay ${new Decimal(f.disponible).toString()})`).join('; ')}.`);
  }
  const { rows: comps } = await tx.query<{ id: string; producto_id: string; cantidad: string }>(
    'select id, producto_id, cantidad::text from orden_produccion_componente where orden_id = $1 order by linea', [id]);
  if (!comps.length) throw new ErrorMaestro('La orden no tiene componentes.');

  let total = new Decimal(0);
  for (const c of comps) {
    const { rows } = await tx.query<{ costo: string }>(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
       values ('consumo_produccion', $1, $2, $3, 0, 'orden_produccion', $4, $5) returning abs(costo_total_usd)::text as costo`,
      [c.producto_id, o.almacen_id, new Decimal(c.cantidad).negated().toString(), id, u.id]);
    await tx.query('update orden_produccion_componente set costo_total_usd = $2 where id = $1', [c.id, rows[0].costo]);
    total = total.plus(rows[0].costo);
  }
  const unitario = total.dividedBy(o.cantidad).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const { rows: ent } = await tx.query<{ costo: string }>(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
     values ('entrada_produccion', $1, $2, $3, $4, 'orden_produccion', $5, $6) returning costo_total_usd::text as costo`,
    [o.producto_id, o.almacen_id, o.cantidad, unitario.toFixed(4), id, u.id]);
  // El costo unitario lleva 4 decimales: lo que entra puede diferir de lo consumido por centavos, y esa diferencia se asienta para que el auxiliar siga igual al mayor.
  const diferencia = new Decimal(ent[0].costo).minus(total);
  if (!diferencia.isZero()) {
    const { rows: dia } = await tx.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`);
    await contabilizar(tx, {
      evento: diferencia.gt(0) ? 'produccion_redondeo_mas' : 'produccion_redondeo_menos', fecha: dia[0].hoy,
      descripcion: `Redondeo de la orden de producción ${o.numero}`, origen: { tipo: 'orden_produccion', id }, moneda: 'USD',
      importes: { monto: diferencia.abs().toFixed(2) }, usuarioId: u.id,
    });
  }
  await tx.query(`update orden_produccion set estado = 'terminada', costo_total_usd = $2, costo_unitario_usd = $3, terminada_por = $4 where id = $1`,
    [id, ent[0].costo, unitario.toFixed(4), u.id]);
  return { costoTotalUsd: ent[0].costo, costoUnitarioUsd: unitario.toFixed(4), redondeo: diferencia.toFixed(2) };
}

/** Anula una orden que todavía no se terminó (con motivo). */
export async function anularOrden(tx: Db, u: UsuarioProd, id: string, motivo: string): Promise<void> {
  const o = await orden(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (!['borrador', 'pendiente', 'liberada', 'en_proceso'].includes(o.estado)) throw new ErrorMaestro('Solo se anula una orden que todavía no se terminó.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  if (o.estado === 'pendiente') await cancelarSolicitud(tx, 'orden_produccion', id);
  await tx.query(`update orden_produccion set estado = 'anulada', anulado_motivo = $2, anulada_por = $3 where id = $1`, [id, motivo.trim(), u.id]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaOrden {
  id: string; numero: string; estado: string; producto: string; cantidad: string; almacen: string; creador: string; fecha: string; componentes: number;
}

export async function buscarOrdenes(db: Db, u: UsuarioProd, estado = '', limite = 150): Promise<FilaOrden[]> {
  if (!tiene(u, ROLES_VEN_PRODUCCION)) return [];
  const visibles = await almacenesVisibles(db, u);
  const { rows } = await db.query<FilaOrden>(
    `select o.id, o.numero::text, o.estado, p.codigo || ' · ' || p.descripcion as producto, o.cantidad::text, a.codigo as almacen, cr.nombre as creador,
            to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha,
            (select count(*)::int from orden_produccion_componente c where c.orden_id = o.id) as componentes
       from orden_produccion o join producto p on p.id = o.producto_id join almacen a on a.id = o.almacen_id join usuario cr on cr.id = o.created_by
      where ($1 = '' or o.estado = $1) and o.almacen_id = any($2::uuid[]) order by o.numero desc limit $3`, [estado, visibles, limite]);
  return rows;
}

export interface DetalleOrden extends FilaOrden {
  producto_id: string; almacen_id: string; observaciones: string | null; creador_id: string; aprobado_por: string | null; aprobado: string | null;
  rechazo_motivo: string | null; anulado_motivo: string | null; costo_total_usd: string | null; costo_unitario_usd: string | null;
  terminada_por: string | null; terminada: string | null;
  componentes_detalle: { id: string; linea: number; producto_id: string; codigo: string; descripcion: string; cantidad: string; disponible: string; costo_total_usd: string | null }[];
}

export async function detalleOrden(db: Db, id: string): Promise<DetalleOrden | null> {
  const { rows } = await db.query<Omit<DetalleOrden, 'componentes_detalle'>>(
    `select o.id, o.numero::text, o.estado, p.codigo || ' · ' || p.descripcion as producto, o.producto_id, o.cantidad::text, a.codigo as almacen, o.almacen_id,
            o.observaciones, o.created_by as creador_id, cr.nombre as creador, to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha,
            ap.nombre as aprobado_por, to_char(o.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado, o.rechazo_motivo, o.anulado_motivo,
            o.costo_total_usd::text, o.costo_unitario_usd::text, te.nombre as terminada_por, to_char(o.terminada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as terminada,
            (select count(*)::int from orden_produccion_componente c where c.orden_id = o.id) as componentes
       from orden_produccion o join producto p on p.id = o.producto_id join almacen a on a.id = o.almacen_id join usuario cr on cr.id = o.created_by
       left join usuario ap on ap.id = o.aprobado_por left join usuario te on te.id = o.terminada_por where o.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: comps } = await db.query<DetalleOrden['componentes_detalle'][number]>(
    `select c.id, c.linea, c.producto_id, p.codigo, p.descripcion, c.cantidad::text, greatest(coalesce(e.cantidad - e.reservado, 0), 0)::text as disponible, c.costo_total_usd::text
       from orden_produccion_componente c join producto p on p.id = c.producto_id
       left join existencia e on e.producto_id = c.producto_id and e.almacen_id = $2 where c.orden_id = $1 order by c.linea`, [id, rows[0].almacen_id]);
  return { ...rows[0], componentes_detalle: comps };
}

/** Productos inventariables para elegir terminado o componente. */
export async function productosInventariables(db: Db, limite = 800): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(
    `select id, codigo || ' · ' || descripcion as texto from producto where inventariable and estado = 'activo' order by codigo limit $1`, [limite]);
  return rows;
}
