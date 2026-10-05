import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { soloSuCartera, type Usuario } from './pedidos';

/**
 * Ventas perdidas (§6.1, docs/catalogo_decisiones.md D3 y D5): lo que un cliente pidió o quiso y no se vendió,
 * con su motivo (no había, precio, plazo, condición de pago…). Se guarda en `demanda_no_atendida`, la misma tabla
 * donde el sistema registra solo lo que falta por existencia, para separar "no se vendió" de "no había".
 */

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;

export async function registrarVentaPerdida(
  tx: Db, u: Usuario,
  d: { clienteId: string; productoId: string; almacenId: string; cantidad: string; motivoId: string; observacion?: string },
): Promise<string> {
  const cantidad = d.cantidad.trim();
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser mayor que cero, con hasta 4 decimales.');
  const { rows: cli } = await tx.query<{ vendedor_usuario: string | null }>(
    `select v.usuario_id as vendedor_usuario from cliente c left join vendedor v on v.id = c.vendedor_id where c.tercero_id = $1`, [d.clienteId]);
  if (!cli[0]) throw new ErrorMaestro('Seleccione el cliente.');
  if (soloSuCartera(u) && cli[0].vendedor_usuario !== u.id) throw new ErrorMaestro('Ese cliente no está en su cartera.');
  const { rows: prod } = await tx.query('select 1 from producto where id = $1', [d.productoId]);
  if (!prod.length) throw new ErrorMaestro('Seleccione el producto.');
  const { rows: alm } = await tx.query('select 1 from almacen where id = $1 and activo', [d.almacenId]);
  if (!alm.length) throw new ErrorMaestro('Seleccione el almacén.');
  const { rows: mot } = await tx.query<{ codigo: string }>(`select codigo from motivo where id = $1 and tipo = 'venta_perdida'`, [d.motivoId]);
  if (!mot[0]) throw new ErrorMaestro('Seleccione el motivo de la venta perdida.');
  const obs = (d.observacion ?? '').trim();
  if (mot[0].codigo === 'OTRO' && obs.length < 3) throw new ErrorMaestro('Explique el motivo de la venta perdida.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into demanda_no_atendida (producto_id, almacen_id, cliente_id, cantidad, motivo_id, observacion, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [d.productoId, d.almacenId, d.clienteId, cantidad, d.motivoId, obs || null, u.id]);
  return rows[0].id;
}

export interface FilaVentaPerdida {
  id: string; fecha: string; cliente: string; codigo: string; producto: string; almacen: string; cantidad: string;
  motivo: string; observacion: string | null; registro: 'manual' | 'sistema';
}

/** Últimas ventas perdidas. Quien solo vende ve las de su cartera. */
export async function listarVentasPerdidas(db: Db, u: Usuario, limite = 100): Promise<FilaVentaPerdida[]> {
  const { rows } = await db.query<FilaVentaPerdida>(
    `select n.id, to_char(n.fecha, 'DD-MM-YYYY') as fecha, t.razon_social as cliente, p.codigo, p.descripcion as producto, a.codigo as almacen,
            n.cantidad::text, m.nombre as motivo, n.observacion, case when n.documento_id is null then 'manual' else 'sistema' end as registro
       from demanda_no_atendida n
       join cliente c on c.tercero_id = n.cliente_id
       join tercero t on t.id = c.tercero_id
       join producto p on p.id = n.producto_id
       join almacen a on a.id = n.almacen_id
       join motivo m on m.id = n.motivo_id
       left join vendedor v on v.id = c.vendedor_id
      where (not $1 or v.usuario_id = $2)
      order by n.created_at desc limit $3`, [soloSuCartera(u), u.id, limite]);
  return rows;
}
