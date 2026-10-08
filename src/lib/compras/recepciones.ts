import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_VEN_COMPRAS, type Usuario } from './ordenes';

/**
 * Recepción de mercancía contra una orden de compra aprobada (§7.2 regla 2, §8.1). Migración 0023.
 *
 * En una sola transacción: la recepción (con las cantidades reales), una entrada de inventario por línea al precio de la
 * orden convertido a USD con la tasa BCV del día, el costo promedio y el asiento (inventario contra "mercancía recibida
 * no facturada"). Nunca se recibe más de lo pendiente de cada línea.
 */

export const ROLES_RECIBEN = ['almacen', 'gerencia'] as const satisfies readonly Rol[];

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;

export async function recibirMercancia(
  tx: Db, u: Usuario, ordenId: string, lineas: { lineaId: string; cantidad: string }[], observaciones?: string,
): Promise<{ id: string; numero: string; costoUsd: string; asiento: string }> {
  const { rows: ords } = await tx.query<{
    estado: string; proveedor_id: string; almacen_id: string; moneda: string; hoy: string; numero: string;
  }>(
    `select estado, proveedor_id, almacen_id, moneda, numero::text, ((now() at time zone 'America/Caracas')::date)::text as hoy
       from documento_compra where id = $1 and tipo = 'orden_compra' for update`, [ordenId]);
  const o = ords[0];
  if (!o) throw new ErrorMaestro('La orden de compra no existe.');
  if (o.estado !== 'aprobada') throw new ErrorMaestro('Solo se recibe mercancía de una orden de compra aprobada.');
  if (!(await almacenesVisibles(tx, u)).includes(o.almacen_id)) throw new ErrorMaestro('El almacén de esta orden no está entre los suyos.');

  const pedidas = lineas.filter((l) => l.cantidad.trim() !== '' && l.cantidad.trim() !== '0');
  if (!pedidas.length) throw new ErrorMaestro('Indique la cantidad recibida de al menos un producto.');
  if (new Set(pedidas.map((l) => l.lineaId)).size !== pedidas.length) throw new ErrorMaestro('Una línea de la orden aparece repetida.');

  const { rows: ordenadas } = await tx.query<{
    id: string; producto_id: string; codigo: string; descripcion: string; precio: string; pendiente: string;
  }>(
    `select l.id, l.producto_id, p.codigo, l.descripcion, l.precio_unitario::text as precio,
            (l.cantidad - fn_orden_linea_recibida(l.id))::text as pendiente
       from documento_compra_linea l join producto p on p.id = l.producto_id where l.documento_id = $1`, [ordenId]);
  const porId = new Map(ordenadas.map((l) => [l.id, l]));

  for (const p of pedidas) {
    const l = porId.get(p.lineaId);
    if (!l) throw new ErrorMaestro('Una de las líneas no pertenece a la orden.');
    const c = p.cantidad.trim();
    if (!CANTIDAD.test(c) || new Decimal(c).lte(0)) throw new ErrorMaestro(`La cantidad de ${l.codigo} debe ser un número mayor que cero, con hasta 4 decimales.`);
    if (new Decimal(c).gt(l.pendiente)) {
      throw new ErrorMaestro(`De ${l.codigo} solo quedan ${new Decimal(l.pendiente).toString()} por recibir; no se puede recibir ${new Decimal(c).toString()}.`);
    }
  }

  const { rows: cab } = await tx.query<{ id: string }>(
    `insert into documento_compra (tipo, proveedor_id, almacen_id, orden_id, moneda, observaciones, created_by)
     values ('recepcion', $1, $2, $3, $4, $5, $6) returning id`,
    [o.proveedor_id, o.almacen_id, ordenId, o.moneda, observaciones?.trim() || null, u.id]);
  const recepcionId = cab[0].id;
  for (const [i, p] of pedidas.entries()) {
    const l = porId.get(p.lineaId)!;
    await tx.query(
      `insert into documento_compra_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, linea_origen_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [recepcionId, i + 1, l.producto_id, l.descripcion, p.cantidad.trim(), l.precio, l.id]);
  }
  await tx.query('select fn_compra_calcular($1)', [recepcionId]);

  // Costo unitario en USD: precio de la orden × tasa de la moneda ÷ tasa del USD (ambas del día de la recepción).
  const { rows: t } = await tx.query<{ tasa: string; usd: string }>(
    `select fn_tasa($1, $2::date)::text as tasa, fn_tasa('USD', $2::date)::text as usd`, [o.moneda, o.hoy]);
  const factor = new Decimal(t[0].tasa).dividedBy(t[0].usd);

  let costo = new Decimal(0);
  const { rows: nuevas } = await tx.query<{ id: string; producto_id: string; cantidad: string; precio_unitario: string }>(
    `select id, producto_id, cantidad::text, precio_unitario::text from documento_compra_linea where documento_id = $1 order by linea`, [recepcionId]);
  for (const l of nuevas) {
    const unitario = new Decimal(l.precio_unitario).times(factor).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const { rows: mov } = await tx.query<{ costo_total_usd: string; costo_unitario_usd: string }>(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
       values ('entrada_compra', $1, $2, $3, $4, 'recepcion', $5, $6) returning costo_total_usd::text, costo_unitario_usd::text`,
      [l.producto_id, o.almacen_id, l.cantidad, unitario.toString(), recepcionId, u.id]);
    costo = costo.plus(mov[0].costo_total_usd);
    await tx.query('update documento_compra_linea set costo_unitario_usd = $2, costo_total_usd = $3 where id = $1',
      [l.id, mov[0].costo_unitario_usd, mov[0].costo_total_usd]);
  }
  await tx.query('update documento_compra set total_usd = $2 where id = $1', [recepcionId, costo.toFixed(2)]);
  const { rows: emitida } = await tx.query<{ numero: string }>(
    `update documento_compra set estado = 'emitido' where id = $1 returning numero::text`, [recepcionId]);

  const r = await contabilizar(tx, {
    evento: 'recepcion_compra', fecha: o.hoy, descripcion: `Recepción ${emitida[0].numero} · orden de compra ${o.numero}`,
    origen: { tipo: 'recepcion', id: recepcionId }, moneda: 'USD', importes: { costo: costo.toFixed(2) },
    terceroId: o.proveedor_id, usuarioId: u.id,
  });
  return { id: recepcionId, numero: emitida[0].numero, costoUsd: costo.toFixed(2), asiento: r.numero };
}

export interface FilaRecepcion {
  id: string; numero: string; fecha: string; orden_id: string; orden: string; proveedor: string; almacen: string; total_usd: string;
}

/** Recepciones emitidas de los almacenes que el usuario ve. */
export async function buscarRecepciones(db: Db, u: Usuario, limite = 100): Promise<FilaRecepcion[]> {
  if (!u.roles.some((r) => (ROLES_VEN_COMPRAS as readonly string[]).includes(r))) return [];
  const visibles = await almacenesVisibles(db, u);
  if (!visibles.length) return [];
  const { rows } = await db.query<FilaRecepcion>(
    `select r.id, r.numero::text, to_char(r.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, r.orden_id,
            o.numero::text as orden, p.codigo || ' · ' || t.razon_social as proveedor, a.codigo as almacen, r.total_usd::text
       from documento_compra r
       join documento_compra o on o.id = r.orden_id
       join proveedor p on p.tercero_id = r.proveedor_id join tercero t on t.id = p.tercero_id
       join almacen a on a.id = r.almacen_id
      where r.tipo = 'recepcion' and r.estado = 'emitido' and r.almacen_id = any($1::uuid[])
      order by r.numero desc limit $2`, [visibles, limite]);
  return rows;
}
