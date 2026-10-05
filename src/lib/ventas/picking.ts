import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import type { Usuario } from './pedidos';

/**
 * Picking y empaque con tiempos (§6.4). Cada nota de entrega de un almacén que usa picking genera una orden:
 *
 *   pendiente → asignada → en_proceso → completa (→ empacada) → salida de mercancía (despacho.ts)
 *                                     → con_faltante → esperar (en_proceso) | despachar parcial (despacho.ts)
 *
 * Las marcas de hora las pone la base de datos y los indicadores salen de la vista vw_picking_tiempos (migración 0018).
 */

export const ROLES_PICKING = ['almacen', 'gerencia'] as const satisfies readonly Rol[];
/** Deciden qué hacer con un faltante: esperar la mercancía o despachar parcial. */
export const ROLES_DECIDEN_FALTANTE = ['gerencia', 'supervisor_ventas'] as const satisfies readonly Rol[];
export const ROLES_VEN_PICKING = ['almacen', 'gerencia', 'supervisor_ventas', 'facturacion', 'auditor'] as const satisfies readonly Rol[];

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;

interface Orden {
  id: string; estado: string; almacen_id: string; nota_entrega_id: string; asignada_a: string | null; empacada_at: string | null;
}

export async function ordenDe(tx: Db, id: string, bloquear = true): Promise<Orden> {
  const { rows } = await tx.query<Orden>(
    `select id, estado, almacen_id, nota_entrega_id, asignada_a, empacada_at::text from orden_picking where id = $1 ${bloquear ? 'for update' : ''}`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La orden de picking no existe.');
  return rows[0];
}

/** El almacenista solo trabaja en los almacenes que tiene asignados (§4.3). */
export async function exigirAlmacen(tx: Db, u: Usuario, almacenId: string): Promise<void> {
  if (!(await almacenesVisibles(tx, u)).includes(almacenId)) throw new ErrorMaestro('Ese almacén no está entre los suyos.');
}

/**
 * Crea la orden de picking de una nota de entrega con sus productos inventariables. Devuelve null si la nota no tiene
 * ninguno (por ejemplo, solo servicios): no hay nada que recoger.
 */
export async function crearOrdenPicking(tx: Db, u: Usuario, notaId: string, prioridad: number | undefined = 3): Promise<string | null> {
  const { rows: lineas } = await tx.query<{ id: string; producto_id: string; cantidad: string }>(
    `select l.id, l.producto_id, l.cantidad::text from documento_venta_linea l join producto p on p.id = l.producto_id
      where l.documento_id = $1 and p.inventariable order by l.linea`, [notaId]);
  if (!lineas.length) return null;
  const { rows } = await tx.query<{ id: string }>(
    `insert into orden_picking (nota_entrega_id, almacen_id, prioridad, created_by)
     select id, almacen_id, $2, $3 from documento_venta where id = $1 returning id`, [notaId, prioridad, u.id]);
  for (const l of lineas) {
    await tx.query(
      `insert into orden_picking_linea (orden_id, nota_linea_id, producto_id, cantidad_pedida) values ($1, $2, $3, $4)`,
      [rows[0].id, l.id, l.producto_id, l.cantidad]);
  }
  return rows[0].id;
}

/** Cancela la orden vigente de una nota (se anula la nota o se reemplaza por un despacho parcial). */
export async function cancelarOrdenDeNota(tx: Db, notaId: string): Promise<void> {
  await tx.query(`update orden_picking set estado = 'cancelada' where nota_entrega_id = $1 and estado <> 'cancelada'`, [notaId]);
}

export async function cambiarPrioridad(tx: Db, u: Usuario, id: string, prioridad: number): Promise<void> {
  if (!Number.isInteger(prioridad) || prioridad < 1 || prioridad > 5) throw new ErrorMaestro('La prioridad va de 1 (más urgente) a 5.');
  const o = await ordenDe(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (!['pendiente', 'asignada'].includes(o.estado)) throw new ErrorMaestro('La prioridad solo se cambia antes de iniciar el picking.');
  await tx.query('update orden_picking set prioridad = $2 where id = $1', [id, prioridad]);
}

/** El almacenista toma la orden para sí. */
export async function tomarOrden(tx: Db, u: Usuario, id: string): Promise<void> {
  const o = await ordenDe(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'pendiente') throw new ErrorMaestro('Solo se toma una orden pendiente.');
  await tx.query(`update orden_picking set estado = 'asignada', asignada_a = $2 where id = $1`, [id, u.id]);
}

export async function iniciarOrden(tx: Db, u: Usuario, id: string): Promise<void> {
  const o = await ordenDe(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (!['pendiente', 'asignada'].includes(o.estado)) throw new ErrorMaestro('Solo se inicia una orden pendiente o asignada.');
  if (o.asignada_a && o.asignada_a !== u.id && !u.roles.includes('gerencia')) throw new ErrorMaestro('Esa orden está asignada a otra persona.');
  await tx.query(`update orden_picking set estado = 'en_proceso', asignada_a = coalesce(asignada_a, $2) where id = $1`, [id, u.id]);
}

/** Registra lo recogido de una línea (0 hasta lo pedido). */
export async function registrarRecogida(
  tx: Db, u: Usuario, ordenId: string, lineaId: string, d: { cantidad: string; motivoFaltante?: string },
): Promise<void> {
  const o = await ordenDe(tx, ordenId);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'en_proceso') throw new ErrorMaestro('Solo se registra lo recogido mientras la orden está en proceso.');
  if (o.asignada_a && o.asignada_a !== u.id && !u.roles.includes('gerencia')) throw new ErrorMaestro('Esa orden está asignada a otra persona.');
  const cantidad = d.cantidad.trim();
  if (!CANTIDAD.test(cantidad)) throw new ErrorMaestro('La cantidad recogida debe ser un número con hasta 4 decimales.');
  const { rows } = await tx.query<{ cantidad_pedida: string }>(
    'select cantidad_pedida::text from orden_picking_linea where id = $1 and orden_id = $2', [lineaId, ordenId]);
  if (!rows[0]) throw new ErrorMaestro('La línea no existe.');
  if (new Decimal(cantidad).gt(rows[0].cantidad_pedida)) {
    throw new ErrorMaestro(`No se puede recoger más de lo pedido (${new Decimal(rows[0].cantidad_pedida).toString()}).`);
  }
  await tx.query('update orden_picking_linea set cantidad_recogida = $2, motivo_faltante = $3 where id = $1',
    [lineaId, cantidad, d.motivoFaltante?.trim() || null]);
}

/** Cierra el picking: completa si se recogió todo; con faltante si no (exige el motivo de cada faltante). */
export async function finalizarOrden(tx: Db, u: Usuario, id: string): Promise<'completa' | 'con_faltante'> {
  const o = await ordenDe(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'en_proceso') throw new ErrorMaestro('Solo se finaliza una orden en proceso.');
  if (o.asignada_a && o.asignada_a !== u.id && !u.roles.includes('gerencia')) throw new ErrorMaestro('Esa orden está asignada a otra persona.');
  const { rows } = await tx.query<{ falta: string; motivo: string | null }>(
    `select (cantidad_pedida - cantidad_recogida)::text as falta, motivo_faltante as motivo
       from orden_picking_linea where orden_id = $1`, [id]);
  const cortas = rows.filter((r) => new Decimal(r.falta).gt(0));
  if (cortas.some((r) => (r.motivo?.trim().length ?? 0) < 3)) {
    throw new ErrorMaestro('Indique el motivo del faltante de cada línea que no se recogió completa.');
  }
  const estado = cortas.length ? 'con_faltante' : 'completa';
  await tx.query('update orden_picking set estado = $2 where id = $1', [id, estado]);
  return estado;
}

/** Registra el empaque de una orden completa. */
export async function empacarOrden(tx: Db, u: Usuario, id: string): Promise<void> {
  const o = await ordenDe(tx, id);
  await exigirAlmacen(tx, u, o.almacen_id);
  if (o.estado !== 'completa') throw new ErrorMaestro('Solo se empaca una orden con el picking completo.');
  if (o.empacada_at) throw new ErrorMaestro('La orden ya está empacada.');
  await tx.query('update orden_picking set empacada_at = now() where id = $1', [id]);
}

/** Gerencia o el supervisor deciden esperar la mercancía faltante: la orden vuelve a estar en proceso. */
export async function esperarFaltante(tx: Db, id: string): Promise<void> {
  const o = await ordenDe(tx, id);
  if (o.estado !== 'con_faltante') throw new ErrorMaestro('La orden no tiene faltante pendiente de decisión.');
  await tx.query(`update orden_picking set estado = 'en_proceso' where id = $1`, [id]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaOrden {
  id: string; numero: string; estado: string; prioridad: number; nota_numero: string; cliente: string; almacen: string;
  asignada_a: string | null; creada: string; lineas: number;
}

/** Órdenes de los almacenes que el usuario puede ver. */
export async function buscarOrdenes(db: Db, u: Usuario, filtro: { estado?: string }, limite = 100): Promise<FilaOrden[]> {
  if (!u.roles.some((r) => (ROLES_VEN_PICKING as readonly string[]).includes(r))) return [];
  const visibles = await almacenesVisibles(db, u);
  if (!visibles.length) return [];
  const { rows } = await db.query<FilaOrden>(
    `select o.id, o.numero::text, o.estado, o.prioridad, n.numero::text as nota_numero, t.razon_social as cliente, a.codigo as almacen,
            us.nombre as asignada_a, to_char(o.creada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creada,
            (select count(*)::int from orden_picking_linea where orden_id = o.id) as lineas
       from orden_picking o
       join documento_venta n on n.id = o.nota_entrega_id
       join tercero t on t.id = n.cliente_id
       join almacen a on a.id = o.almacen_id
       left join usuario us on us.id = o.asignada_a
      where o.almacen_id = any($1::uuid[]) and ($2 = '' or o.estado = $2)
      order by (o.estado in ('completa', 'cancelada')), o.prioridad, o.creada_at
      limit $3`, [visibles, filtro.estado ?? '', limite]);
  return rows;
}

export interface LineaOrden {
  id: string; codigo: string; descripcion: string; pedida: string; recogida: string; motivo: string | null;
}

export interface DetalleOrden {
  id: string; numero: string; estado: string; prioridad: number; almacen_id: string; almacen: string;
  nota_id: string; nota_numero: string; nota_despachada: boolean; cliente: string; asignada_a: string | null; asignada_a_id: string | null;
  creada: string; empacada: string | null;
  espera_seg: string | null; picking_seg: string | null; ciclo_seg: string | null; lineas_por_hora: string | null;
  objetivo_horas: string | null; cumple_objetivo: boolean | null;
  lineas: LineaOrden[];
}

export async function detalleOrden(db: Db, id: string): Promise<DetalleOrden | null> {
  const { rows } = await db.query<Omit<DetalleOrden, 'lineas'>>(
    `select o.id, o.numero::text, o.estado, o.prioridad, o.almacen_id, a.codigo || ' · ' || a.nombre as almacen,
            n.id as nota_id, n.numero::text as nota_numero, (n.salida_at is not null) as nota_despachada,
            t.razon_social as cliente, us.nombre as asignada_a, o.asignada_a as asignada_a_id,
            to_char(o.creada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creada,
            to_char(o.empacada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as empacada,
            v.espera_seg::text, v.picking_seg::text, v.ciclo_seg::text, v.lineas_por_hora::text,
            v.objetivo_horas::text, v.cumple_objetivo
       from orden_picking o
       join documento_venta n on n.id = o.nota_entrega_id
       join tercero t on t.id = n.cliente_id
       join almacen a on a.id = o.almacen_id
       left join usuario us on us.id = o.asignada_a
       left join vw_picking_tiempos v on v.orden_id = o.id
      where o.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: lineas } = await db.query<LineaOrden>(
    `select l.id, p.codigo, p.descripcion, l.cantidad_pedida::text as pedida, l.cantidad_recogida::text as recogida, l.motivo_faltante as motivo
       from orden_picking_linea l join producto p on p.id = l.producto_id where l.orden_id = $1 order by p.codigo`, [id]);
  return { ...rows[0], lineas };
}
