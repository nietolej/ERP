import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { motivoSistema } from '@/lib/maestros/motivos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { crearNotaDesdeReservas, type ReservaPorNota, type Usuario } from './pedidos';
import { exigirAlmacen, ordenDe } from './picking';

/**
 * Salida de mercancía de la nota de entrega y despacho parcial (§6.4, §8.2, §12.3).
 *
 * La salida descuenta la existencia al costo promedio vigente, guarda ese costo en cada línea (margen) y genera el
 * asiento de costo de ventas contra inventario con el motor contable, todo en la misma transacción.
 */

export const ROLES_SALIDA = ['almacen', 'gerencia'] as const satisfies readonly Rol[];

/** Confirma que la mercancía de una nota de entrega salió del almacén. Devuelve el costo total en USD y el asiento. */
export async function confirmarSalida(tx: Db, u: Usuario, notaId: string): Promise<{ costoUsd: string; asiento: string | null }> {
  const { rows: notas } = await tx.query<{
    estado: string; salida_at: string | null; almacen_id: string; cliente_id: string; numero: string; usa_picking: boolean; hoy: string;
  }>(
    `select d.estado, d.salida_at::text, d.almacen_id, d.cliente_id, d.numero::text, a.usa_picking,
            ((now() at time zone 'America/Caracas')::date)::text as hoy
       from documento_venta d join almacen a on a.id = d.almacen_id
      where d.id = $1 and d.tipo = 'nota_entrega' for update of d`, [notaId]);
  const nota = notas[0];
  if (!nota) throw new ErrorMaestro('La nota de entrega no existe.');
  await exigirAlmacen(tx, u, nota.almacen_id);
  if (nota.estado !== 'emitido') throw new ErrorMaestro('Solo sale la mercancía de una nota de entrega emitida.');
  if (nota.salida_at) throw new ErrorMaestro('La mercancía de esta nota ya salió del almacén.');

  if (nota.usa_picking) {
    const { rows: ord } = await tx.query<{ estado: string; empacada_at: string | null }>(
      `select estado, empacada_at::text from orden_picking where nota_entrega_id = $1 and estado <> 'cancelada'`, [notaId]);
    if (!ord[0]) throw new ErrorMaestro('La nota no tiene orden de picking.');
    if (ord[0].estado !== 'completa') {
      throw new ErrorMaestro(ord[0].estado === 'con_faltante'
        ? 'El picking tiene un faltante pendiente de decisión de Gerencia o del supervisor.'
        : 'El picking de esta nota todavía no está completo.');
    }
    if (!ord[0].empacada_at) throw new ErrorMaestro('Registre el empaque antes de confirmar la salida.');
  }

  const { rows: lineas } = await tx.query<{ id: string; producto_id: string; cantidad: string }>(
    `select l.id, l.producto_id, l.cantidad::text from documento_venta_linea l join producto p on p.id = l.producto_id
      where l.documento_id = $1 and p.inventariable order by l.linea`, [notaId]);
  if (!lineas.length) throw new ErrorMaestro('La nota de entrega no tiene productos con inventario.');

  let costo = new Decimal(0);
  for (const l of lineas) {
    const { rows: res } = await tx.query<{ cantidad: string }>(
      `update reserva_inventario set estado = 'consumida' where nota_linea_id = $1 and estado = 'en_nota' returning cantidad::text`, [l.id]);
    const reservado = res.reduce((s, r) => s.plus(r.cantidad), new Decimal(0));
    if (!reservado.equals(l.cantidad)) {
      throw new ErrorMaestro('La reserva de la nota no coincide con lo que debe salir: revise el pedido antes de confirmar.');
    }
    const { rows: mov } = await tx.query<{ costo_total_usd: string; costo_unitario_usd: string }>(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
       values ('salida_venta', $1, $2, $3, 0, 'nota_entrega', $4, $5) returning costo_total_usd::text, costo_unitario_usd::text`,
      [l.producto_id, nota.almacen_id, new Decimal(l.cantidad).negated().toString(), notaId, u.id]);
    costo = costo.plus(new Decimal(mov[0].costo_total_usd).abs());
    await tx.query('update documento_venta_linea set costo_unitario_usd = $2 where id = $1', [l.id, mov[0].costo_unitario_usd]);
  }
  await tx.query('update documento_venta set salida_at = now(), salida_por = $2 where id = $1', [notaId, u.id]);

  let asiento: string | null = null;
  if (costo.gt(0)) {
    const r = await contabilizar(tx, {
      evento: 'salida_venta', fecha: nota.hoy, descripcion: `Costo de la venta · nota de entrega ${nota.numero}`,
      origen: { tipo: 'nota_entrega', id: notaId }, moneda: 'USD', importes: { costo: costo.toFixed(2) },
      terceroId: nota.cliente_id, usuarioId: u.id,
    });
    asiento = r.numero;
  }
  return { costoUsd: costo.toFixed(2), asiento };
}

/**
 * Gerencia o el supervisor deciden despachar parcial: se registra la demanda no atendida de lo que faltó, la nota original
 * se anula y se emite otra con lo realmente recogido; la orden de picking sigue siendo la misma (conserva sus tiempos) y
 * queda completa. Lo que faltó deja de estar reservado: la diferencia de inventario se corrige con un conteo.
 */
export async function despacharParcial(tx: Db, u: Usuario, ordenId: string): Promise<{ notaNuevaId: string | null }> {
  const o = await ordenDe(tx, ordenId);
  if (o.estado !== 'con_faltante') throw new ErrorMaestro('La orden no tiene faltante pendiente de decisión.');
  const { rows: notas } = await tx.query<{ documento_origen_id: string; cliente_id: string; almacen_id: string; prioridad: number }>(
    `select d.documento_origen_id, d.cliente_id, d.almacen_id, o.prioridad
       from documento_venta d join orden_picking o on o.nota_entrega_id = d.id where d.id = $1 and o.id = $2 for update of d`, [o.nota_entrega_id, ordenId]);
  const nota = notas[0];
  const pedidoId = nota.documento_origen_id;

  const { rows: lineas } = await tx.query<{
    id: string; nota_linea_id: string; producto_id: string; pedida: string; recogida: string; linea_pedido: string;
  }>(
    `select pl.id, pl.nota_linea_id, pl.producto_id, pl.cantidad_pedida::text as pedida, pl.cantidad_recogida::text as recogida,
            nl.linea_origen_id as linea_pedido
       from orden_picking_linea pl join documento_venta_linea nl on nl.id = pl.nota_linea_id
      where pl.orden_id = $1 order by nl.linea`, [ordenId]);

  const paraNota: ReservaPorNota[] = [];
  for (const l of lineas) {
    const falta = new Decimal(l.pedida).minus(l.recogida);
    const { rows: reservas } = await tx.query<{ id: string; cantidad: string }>(
      `select id, cantidad::text from reserva_inventario where nota_linea_id = $1 and estado = 'en_nota' order by created_at, id`, [l.nota_linea_id]);
    if (falta.lte(0)) {
      await tx.query(`update reserva_inventario set estado = 'activa', nota_id = null, nota_linea_id = null where nota_linea_id = $1 and estado = 'en_nota'`, [l.nota_linea_id]);
      for (const r of reservas) paraNota.push({ id: r.id, pedido_linea_id: l.linea_pedido, cantidad: r.cantidad });
      continue;
    }
    await tx.query(
      `insert into demanda_no_atendida (producto_id, almacen_id, cliente_id, documento_id, linea_id, cantidad, motivo_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [l.producto_id, nota.almacen_id, nota.cliente_id, pedidoId, l.linea_pedido, falta.toString(), await motivoSistema(tx, 'venta_perdida', 'SIN_EXISTENCIA')]);
    await tx.query(`update reserva_inventario set estado = 'liberada', nota_id = null, nota_linea_id = null where nota_linea_id = $1 and estado = 'en_nota'`, [l.nota_linea_id]);
    if (new Decimal(l.recogida).gt(0)) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into reserva_inventario (pedido_id, pedido_linea_id, producto_id, almacen_id, cantidad) values ($1, $2, $3, $4, $5) returning id`,
        [pedidoId, l.linea_pedido, l.producto_id, nota.almacen_id, l.recogida]);
      paraNota.push({ id: rows[0].id, pedido_linea_id: l.linea_pedido, cantidad: l.recogida });
    }
  }

  await tx.query(
    `update documento_venta set estado = 'anulado', anulado_por = $2, anulado_motivo = 'Despacho parcial por faltante en el picking',
            anulado_motivo_id = $3 where id = $1`,
    [o.nota_entrega_id, u.id, await motivoSistema(tx, 'anulacion', 'DESPACHO_PARCIAL')]);

  if (!paraNota.length) {
    await tx.query(`update orden_picking set estado = 'cancelada' where id = $1`, [ordenId]);
    return { notaNuevaId: null };
  }
  const notaNueva = await crearNotaDesdeReservas(tx, u, pedidoId, paraNota, { crearPicking: false });

  // La misma orden sigue con la nota nueva y lo realmente recogido.
  await tx.query(`select set_config('app.picking_continuar', '1', true)`);
  try {
    const { rows: nuevas } = await tx.query<{ id: string; linea_origen_id: string }>(
      `select id, linea_origen_id from documento_venta_linea where documento_id = $1`, [notaNueva]);
    const porOrigen = new Map(nuevas.map((n) => [n.linea_origen_id, n.id]));
    await tx.query('update orden_picking set nota_entrega_id = $2, estado = $3 where id = $1', [ordenId, notaNueva, 'completa']);
    for (const l of lineas) {
      const nueva = porOrigen.get(l.linea_pedido);
      if (new Decimal(l.recogida).gt(0) && nueva) {
        await tx.query('update orden_picking_linea set nota_linea_id = $2, cantidad_pedida = cantidad_recogida where id = $1', [l.id, nueva]);
      } else {
        await tx.query('delete from orden_picking_linea where id = $1', [l.id]);
      }
    }
  } finally {
    await tx.query(`select set_config('app.picking_continuar', '', true)`);
  }
  return { notaNuevaId: notaNueva };
}
