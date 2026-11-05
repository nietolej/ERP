import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Conteo físico inicial de inventario (spec §14.3; migración 0049).
 *
 *   Almacén cuenta (producto y cantidad) → Contabilidad fija el costo unitario en USD de cada línea → se envía → Gerencia (distinta de quien
 *   registró y de quien fijó costos) aprueba: una entrada «apertura» por línea al costo fijado, con la fecha de arranque, y su asiento
 *   (Inventario contra Saldos de apertura), todo en una transacción. Un conteo por almacén.
 */

export const ROLES_CUENTAN = ['almacen', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_FIJAN_COSTO = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_CONTEO = ['almacen', 'gerencia', 'contabilidad', 'jefe_contabilidad', 'auditor', 'compras', 'tesoreria'] as const satisfies readonly Rol[];

export type UsuarioConteo = { id: string; roles: readonly string[] };
const tiene = (u: UsuarioConteo, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));
const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const COSTO = /^\d{1,12}(\.\d{1,4})?$/;
const dos = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const NOMBRE_ESTADO_CONTEO: Record<string, string> = { borrador: 'Borrador', pendiente: 'Pendiente de Gerencia', aprobado: 'Aprobado', rechazado: 'Rechazado' };

interface Conteo { id: string; estado: string; almacen_id: string; created_by: string; fecha: string; numero: string }

async function conteo(tx: Db, id: string): Promise<Conteo> {
  const { rows } = await tx.query<Conteo>('select id, estado, almacen_id, created_by, fecha::text, numero::text from apertura_inventario where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El conteo inicial no existe.');
  return rows[0];
}

async function exigirAlmacen(tx: Db, u: UsuarioConteo, almacenId: string) {
  if (!tiene(u, ROLES_CUENTAN)) throw new ErrorMaestro('Solo Almacén o Gerencia registran el conteo inicial.');
  if (!(await almacenesVisibles(tx, u)).includes(almacenId)) throw new ErrorMaestro('Ese almacén no está entre los suyos.');
}

async function exigirBorrador(tx: Db, id: string): Promise<Conteo> {
  const c = await conteo(tx, id);
  if (c.estado !== 'borrador') throw new ErrorMaestro('Solo se edita un conteo en borrador.');
  return c;
}

export async function crearConteo(tx: Db, u: UsuarioConteo, d: { almacenId: string; observaciones?: string }): Promise<{ id: string; numero: string }> {
  await exigirAlmacen(tx, u, d.almacenId);
  const { rows } = await tx.query<{ id: string; numero: string }>(
    `insert into apertura_inventario (almacen_id, observaciones, created_by, fecha) values ($1, nullif(trim($2), ''), $3, current_date) returning id, numero::text`,
    [d.almacenId, d.observaciones ?? '', u.id]);
  return rows[0];
}

/** Agrega o cambia la cantidad contada de un producto (Almacén). El costo no se toca aquí. */
export async function guardarLineaConteo(tx: Db, u: UsuarioConteo, id: string, d: { productoId: string; cantidad: string }): Promise<void> {
  const c = await exigirBorrador(tx, id);
  await exigirAlmacen(tx, u, c.almacen_id);
  if (!d.productoId) throw new ErrorMaestro('Seleccione el producto contado.');
  const cantidad = d.cantidad.trim().replace(',', '.');
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad contada debe ser mayor que cero, con hasta 4 decimales.');
  const { rows: previa } = await tx.query<{ id: string }>('select id from apertura_inventario_linea where apertura_id = $1 and producto_id = $2', [id, d.productoId]);
  if (previa[0]) {
    await tx.query('update apertura_inventario_linea set cantidad = $2 where id = $1', [previa[0].id, cantidad]);
    return;
  }
  const { rows: sig } = await tx.query<{ n: number }>('select coalesce(max(linea), 0) + 1 as n from apertura_inventario_linea where apertura_id = $1', [id]);
  await tx.query('insert into apertura_inventario_linea (apertura_id, linea, producto_id, cantidad) values ($1, $2, $3, $4)', [id, sig[0].n, d.productoId, cantidad]);
}

export async function quitarLineaConteo(tx: Db, u: UsuarioConteo, id: string, lineaId: string): Promise<void> {
  const c = await exigirBorrador(tx, id);
  await exigirAlmacen(tx, u, c.almacen_id);
  const { rows } = await tx.query('delete from apertura_inventario_linea where id = $1 and apertura_id = $2 returning id', [lineaId, id]);
  if (!rows[0]) throw new ErrorMaestro('La línea no existe.');
}

/** Contabilidad (o Gerencia) fija el costo unitario en USD de las líneas indicadas: {lineaId: costo}. */
export async function fijarCostos(tx: Db, u: UsuarioConteo, id: string, costos: Record<string, string>): Promise<number> {
  if (!tiene(u, ROLES_FIJAN_COSTO)) throw new ErrorMaestro('Solo Contabilidad o Gerencia fijan el costo del conteo inicial.');
  await exigirBorrador(tx, id);
  let n = 0;
  for (const [lineaId, crudo] of Object.entries(costos)) {
    const v = crudo.trim().replace(',', '.');
    if (v === '') continue;
    if (!COSTO.test(v)) throw new ErrorMaestro(`El costo «${crudo}» no es válido: use un número con hasta 4 decimales.`);
    const { rows } = await tx.query('update apertura_inventario_linea set costo_unitario_usd = $3 where id = $1 and apertura_id = $2 returning id', [lineaId, id, v]);
    if (!rows[0]) throw new ErrorMaestro('Una de las líneas no existe.');
    n++;
  }
  return n;
}

/** Envía el conteo a Gerencia: exige todas las líneas con su costo. */
export async function enviarConteo(tx: Db, u: UsuarioConteo, id: string): Promise<void> {
  const c = await exigirBorrador(tx, id);
  await exigirAlmacen(tx, u, c.almacen_id);
  await tx.query(`update apertura_inventario set estado = 'pendiente' where id = $1`, [id]);
  const { rows } = await tx.query<{ total: string }>('select coalesce(sum(round(cantidad * costo_unitario_usd, 2)), 0)::text as total from apertura_inventario_linea where apertura_id = $1', [id]);
  await solicitarAprobacion(tx, { tipo: 'apertura_inventario', objetoId: id, solicitanteId: u.id, contexto: { valor_usd: new Decimal(rows[0].total).toNumber() } });
}

export async function eliminarConteo(tx: Db, u: UsuarioConteo, id: string): Promise<void> {
  const c = await exigirBorrador(tx, id);
  await exigirAlmacen(tx, u, c.almacen_id);
  await tx.query('delete from apertura_inventario_linea where apertura_id = $1', [id]);
  await tx.query('delete from apertura_inventario where id = $1', [id]);
}

/** Lo llama el motor de flujo cuando Gerencia aprueba: las entradas de apertura y el asiento, en la misma transacción. */
export async function aprobarConteo(tx: Db, id: string, aprobador: string): Promise<{ asiento: string; totalUsd: string }> {
  const c = await conteo(tx, id);
  if (c.estado !== 'pendiente') throw new ErrorMaestro('El conteo inicial no está pendiente de aprobación.');
  await tx.query(`update apertura_inventario set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id, aprobador]);
  const { rows: ls } = await tx.query<{ producto_id: string; cantidad: string; costo: string }>(
    'select producto_id, cantidad::text, costo_unitario_usd::text as costo from apertura_inventario_linea where apertura_id = $1 order by linea', [id]);
  let total = new Decimal(0);
  for (const l of ls) {
    const { rows } = await tx.query<{ costo_total_usd: string }>(
      `insert into movimiento_inventario (fecha, tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
       values (($1::date + time '12:00') at time zone 'America/Caracas', 'apertura', $2, $3, $4, $5, 'apertura_inventario', $6, $7) returning costo_total_usd::text`,
      [c.fecha, l.producto_id, c.almacen_id, l.cantidad, l.costo, id, aprobador]);
    total = total.plus(rows[0].costo_total_usd);
  }
  const a = await contabilizar(tx, {
    evento: 'apertura_inventario', fecha: c.fecha, descripcion: `Inventario inicial · conteo ${c.numero}`, origen: { tipo: 'apertura_inventario', id }, moneda: 'USD',
    importes: { monto: dos(total) }, usuarioId: aprobador,
  });
  return { asiento: a.numero, totalUsd: dos(total) };
}

export async function rechazarConteo(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const c = await conteo(tx, id);
  if (c.estado !== 'pendiente') throw new ErrorMaestro('El conteo inicial no está pendiente de aprobación.');
  await tx.query(`update apertura_inventario set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaConteo { id: string; numero: string; estado: string; almacen: string; almacen_id: string; lineas: number; total_usd: string; creador: string; creado: string }

export async function buscarConteos(db: Db, u: UsuarioConteo): Promise<FilaConteo[]> {
  const visibles = await almacenesVisibles(db, u);
  const { rows } = await db.query<FilaConteo>(
    `select o.id, o.numero::text, o.estado, a.codigo || ' · ' || a.nombre as almacen, o.almacen_id,
            (select count(*)::int from apertura_inventario_linea l where l.apertura_id = o.id) as lineas,
            (select coalesce(sum(round(l.cantidad * coalesce(l.costo_unitario_usd, 0), 2)), 0)::text from apertura_inventario_linea l where l.apertura_id = o.id) as total_usd,
            cr.nombre as creador, to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as creado
       from apertura_inventario o join almacen a on a.id = o.almacen_id join usuario cr on cr.id = o.created_by
      where o.almacen_id = any($1::uuid[]) order by o.numero desc`, [visibles]);
  return rows;
}

export interface DetalleConteo extends FilaConteo {
  fecha: string; observaciones: string | null; creador_id: string; costos_por: string | null; aprobado_por: string | null; rechazo_motivo: string | null; asiento: string | null;
  detalle: { id: string; linea: number; producto_id: string; codigo: string; descripcion: string; cantidad: string; costo: string | null; total: string | null }[];
}

export async function detalleConteo(db: Db, id: string): Promise<DetalleConteo | null> {
  const { rows } = await db.query<Omit<DetalleConteo, 'detalle'>>(
    `select o.id, o.numero::text, o.estado, a.codigo || ' · ' || a.nombre as almacen, o.almacen_id, o.fecha::text, o.observaciones,
            (select count(*)::int from apertura_inventario_linea l where l.apertura_id = o.id) as lineas,
            (select coalesce(sum(round(l.cantidad * coalesce(l.costo_unitario_usd, 0), 2)), 0)::text from apertura_inventario_linea l where l.apertura_id = o.id) as total_usd,
            o.created_by as creador_id, cr.nombre as creador, to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as creado,
            cp.nombre as costos_por, ap.nombre as aprobado_por, o.rechazo_motivo, x.numero::text as asiento
       from apertura_inventario o join almacen a on a.id = o.almacen_id join usuario cr on cr.id = o.created_by
       left join usuario cp on cp.id = o.costos_por left join usuario ap on ap.id = o.aprobado_por
       left join asiento x on x.origen_tipo = 'apertura_inventario' and x.origen_id = o.id and x.tipo = 'automatico' where o.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: d } = await db.query<DetalleConteo['detalle'][number]>(
    `select l.id, l.linea, l.producto_id, p.codigo, p.descripcion, l.cantidad::text, l.costo_unitario_usd::text as costo,
            case when l.costo_unitario_usd is null then null else round(l.cantidad * l.costo_unitario_usd, 2)::text end as total
       from apertura_inventario_linea l join producto p on p.id = l.producto_id where l.apertura_id = $1 order by l.linea`, [id]);
  return { ...rows[0], detalle: d };
}
