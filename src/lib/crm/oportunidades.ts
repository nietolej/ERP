import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { crearCliente } from '@/lib/maestros/clientes';
import { agregarLinea, crearPedido } from '@/lib/ventas/pedidos';
import { decimal, exigirTercero, FECHA, MONTO, soloLoSuyo, UUID, vendedorParaRegistro, type Usuario } from './comun';

/**
 * Oportunidades (§6.5 reglas 1 y 2, migración 0058). Las etapas avanzan una a una; la base lo impone, igual que la
 * cotización emitida para pasar a Cotizada y el motivo de la pérdida.
 *
 * Ganar: si el tercero aún es prospecto, se registra su ficha de cliente (nace pendiente y Gerencia la aprueba por el flujo
 * de alta, §5.5); el pedido se genera desde la cotización cuando el cliente está activo, de inmediato si ya lo estaba.
 */

export const ETAPAS = ['prospecto', 'calificada', 'cotizada', 'negociacion', 'ganada', 'perdida'] as const;
export type Etapa = (typeof ETAPAS)[number];
export const NOMBRE_ETAPA: Record<Etapa, string> = {
  prospecto: 'Prospecto', calificada: 'Calificada', cotizada: 'Cotizada', negociacion: 'Negociación', ganada: 'Ganada', perdida: 'Perdida',
};
export const SIGUIENTE: Partial<Record<Etapa, Etapa>> = { prospecto: 'calificada', calificada: 'cotizada', cotizada: 'negociacion', negociacion: 'ganada' };

interface Oportunidad {
  id: string; etapa: Etapa; tercero_id: string; vendedor_id: string; vendedor_usuario: string | null;
  cotizacion_id: string | null; pedido_id: string | null;
}

async function oportunidad(tx: Db, u: Usuario, id: string): Promise<Oportunidad> {
  if (!UUID.test(id)) throw new ErrorMaestro('La oportunidad no existe.');
  const { rows } = await tx.query<Oportunidad>(
    `select o.id, o.etapa, o.tercero_id, o.vendedor_id, v.usuario_id as vendedor_usuario, o.cotizacion_id, o.pedido_id
       from oportunidad o join vendedor v on v.id = o.vendedor_id where o.id = $1 for update of o`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La oportunidad no existe.');
  if (soloLoSuyo(u) && rows[0].vendedor_usuario !== u.id) throw new ErrorMaestro('Esa oportunidad es de otro vendedor.');
  return rows[0];
}

function abierta(o: Oportunidad): void {
  if (o.etapa === 'ganada' || o.etapa === 'perdida') throw new ErrorMaestro('La oportunidad ya está cerrada.');
}

export interface DatosOportunidad { titulo: string; montoEstimadoUsd: string; cierreEstimado?: string; vendedorId?: string | null }

function validar(d: DatosOportunidad): { monto: string; cierre: string | null } {
  if (d.titulo.trim().length < 3) throw new ErrorMaestro('Describa la oportunidad (por ejemplo, «Pastillas para la flota de 2027»).');
  const monto = decimal(d.montoEstimadoUsd) || '0';
  if (!MONTO.test(monto)) throw new ErrorMaestro('El monto estimado debe ser un monto en US$ con hasta 2 decimales.');
  const cierre = d.cierreEstimado?.trim() || null;
  if (cierre && !FECHA.test(cierre)) throw new ErrorMaestro('La fecha estimada de cierre no es válida.');
  return { monto, cierre };
}

export async function crearOportunidad(tx: Db, u: Usuario, terceroId: string, d: DatosOportunidad): Promise<string> {
  const t = await exigirTercero(tx, u, terceroId);
  const activo = (t.es_cliente && t.cliente_estado === 'activo') || (!t.es_cliente && t.prospecto_estado === 'activo');
  if (!activo) throw new ErrorMaestro('Una oportunidad es de un cliente activo o de un prospecto activo.');
  const { monto, cierre } = validar(d);
  const vendedorId = await vendedorParaRegistro(tx, u, d.vendedorId, t.vendedor_id);
  const { rows } = await tx.query<{ id: string }>(
    `insert into oportunidad (titulo, tercero_id, vendedor_id, monto_estimado_usd, cierre_estimado, created_by)
     values ($1, $2, $3, $4, $5::date, $6) returning id`,
    [d.titulo.trim(), terceroId, vendedorId, monto, cierre, u.id]);
  return rows[0].id;
}

/** Cambia la descripción, el monto, la fecha estimada y (Supervisor o Gerencia) el vendedor de una oportunidad abierta. */
export async function actualizarOportunidad(tx: Db, u: Usuario, id: string, d: DatosOportunidad): Promise<void> {
  const o = await oportunidad(tx, u, id);
  abierta(o);
  const { monto, cierre } = validar(d);
  const vendedorId = soloLoSuyo(u) ? o.vendedor_id : await vendedorParaRegistro(tx, u, d.vendedorId, o.vendedor_id);
  await tx.query(
    `update oportunidad set titulo = $2, monto_estimado_usd = $3, cierre_estimado = $4::date, vendedor_id = $5 where id = $1`,
    [id, d.titulo.trim(), monto, cierre, vendedorId]);
}

/** Pasa a la etapa siguiente. A Cotizada se pasa enlazando una cotización emitida del mismo tercero. Ganar va por `ganarOportunidad`. */
export async function avanzarOportunidad(tx: Db, u: Usuario, id: string, opciones: { cotizacionId?: string } = {}): Promise<Etapa> {
  const o = await oportunidad(tx, u, id);
  abierta(o);
  const siguiente = SIGUIENTE[o.etapa]!;
  if (siguiente === 'ganada') throw new ErrorMaestro('Para ganar la oportunidad use «Ganar».');
  if (siguiente === 'cotizada') {
    if (!opciones.cotizacionId || !UUID.test(opciones.cotizacionId)) throw new ErrorMaestro('Seleccione la cotización emitida que se le envió.');
    await tx.query(
      `update oportunidad set etapa = 'cotizada', cotizacion_id = $2,
              monto_estimado_usd = coalesce((select total from cotizacion where id = $2), monto_estimado_usd) where id = $1`, [id, opciones.cotizacionId]);
  } else {
    await tx.query('update oportunidad set etapa = $2 where id = $1', [id, siguiente]);
  }
  return siguiente;
}

/** En Cotizada o Negociación se enlaza una cotización nueva (por ejemplo, la que reemplaza a una vencida). */
export async function cambiarCotizacion(tx: Db, u: Usuario, id: string, cotizacionId: string): Promise<void> {
  const o = await oportunidad(tx, u, id);
  abierta(o);
  if (!UUID.test(cotizacionId)) throw new ErrorMaestro('Seleccione la cotización.');
  await tx.query(
    `update oportunidad set cotizacion_id = $2, monto_estimado_usd = coalesce((select total from cotizacion where id = $2), monto_estimado_usd) where id = $1`,
    [id, cotizacionId]);
}

export async function perderOportunidad(tx: Db, u: Usuario, id: string, motivoId: string, detalle?: string): Promise<void> {
  const o = await oportunidad(tx, u, id);
  abierta(o);
  if (!UUID.test(motivoId)) throw new ErrorMaestro('Seleccione el motivo por el que se perdió.');
  await tx.query(`update oportunidad set etapa = 'perdida', motivo_perdida_id = $2, motivo_perdida = $3 where id = $1`,
    [id, motivoId, detalle?.trim() || null]);
}

export interface ResultadoGanar {
  /** El pedido en borrador, si el cliente ya estaba activo. */
  pedidoId: string | null;
  /** Se registró la ficha de cliente del prospecto: espera la aprobación de Gerencia. */
  clientePendiente: boolean;
  /** El pedido no suma lo mismo que la cotización (cambió la lista del cliente, su descuento o una promoción). */
  difiereDeCotizacion: boolean;
}

export async function ganarOportunidad(tx: Db, u: Usuario, id: string): Promise<ResultadoGanar> {
  const o = await oportunidad(tx, u, id);
  if (o.etapa !== 'negociacion') throw new ErrorMaestro('Las etapas avanzan una a una: se gana una oportunidad en Negociación.');
  await tx.query(`update oportunidad set etapa = 'ganada' where id = $1`, [id]);

  const { rows } = await tx.query<{ cliente_estado: string | null; rif: string; razon_social: string; sucursal_id: string }>(
    `select c.estado as cliente_estado, t.rif, t.razon_social, q.sucursal_id
       from tercero t join cotizacion q on q.id = $2 left join cliente c on c.tercero_id = t.id where t.id = $1`,
    [o.tercero_id, o.cotizacion_id]);
  const t = rows[0];
  if (t.cliente_estado === null) {
    // Primera oportunidad ganada de un prospecto: se registra como cliente por el alta normal (§5.5).
    await crearCliente(tx, u.id, {
      rif: t.rif,
      tercero: { razonSocial: t.razon_social, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: { vendedorId: o.vendedor_id, sucursalId: t.sucursal_id },
    });
    return { pedidoId: null, clientePendiente: true, difiereDeCotizacion: false };
  }
  if (t.cliente_estado === 'pendiente') return { pedidoId: null, clientePendiente: true, difiereDeCotizacion: false };
  if (t.cliente_estado !== 'activo') throw new ErrorMaestro('El cliente está inactivo o bloqueado: no se le puede generar el pedido.');
  const r = await generarPedidoDeOportunidad(tx, u, id);
  return { ...r, clientePendiente: false };
}

/**
 * Copia la cotización de una oportunidad ganada a un pedido en borrador: mismos productos, cantidades y descuentos, al
 * precio de la lista del cliente vigente hoy (el pedido nunca lleva precios escritos a mano). Quien vende revisa el borrador
 * antes de emitirlo, que pasa por crédito y reserva existencia como cualquier pedido.
 */
export async function generarPedidoDeOportunidad(tx: Db, u: Usuario, id: string): Promise<{ pedidoId: string; difiereDeCotizacion: boolean }> {
  const o = await oportunidad(tx, u, id);
  if (o.etapa !== 'ganada') throw new ErrorMaestro('Solo una oportunidad ganada genera su pedido.');
  if (o.pedido_id) throw new ErrorMaestro('La oportunidad ya generó su pedido.');
  const { rows: q } = await tx.query<{ almacen_id: string; observaciones: string | null; numero: string; total: string; estado: string; cliente_estado: string | null }>(
    `select q.almacen_id, q.observaciones, q.numero::text, q.total::text, q.estado, c.estado as cliente_estado
       from cotizacion q left join cliente c on c.tercero_id = q.tercero_id where q.id = $1 for update of q`, [o.cotizacion_id]);
  if (q[0].estado !== 'emitida') throw new ErrorMaestro('La cotización de la oportunidad ya no está emitida.');
  if (q[0].cliente_estado !== 'activo') throw new ErrorMaestro('El pedido se genera cuando Gerencia apruebe al cliente.');

  const pedidoId = await crearPedido(tx, u, {
    clienteId: o.tercero_id, almacenId: q[0].almacen_id,
    observaciones: [`Desde la cotización ${q[0].numero}.`, q[0].observaciones].filter(Boolean).join(' '),
  });
  const { rows: lineas } = await tx.query<{ producto_id: string; cantidad: string; descuento_pct: string; motivo_descuento_id: string | null }>(
    `select producto_id, cantidad::text, descuento_pct::text, motivo_descuento_id from cotizacion_linea where cotizacion_id = $1 order by linea`,
    [o.cotizacion_id]);
  for (const l of lineas) {
    await agregarLinea(tx, u, pedidoId, {
      productoId: l.producto_id, cantidad: l.cantidad, descuentoPct: l.descuento_pct, motivoDescuentoId: l.motivo_descuento_id ?? undefined,
    });
  }
  await tx.query(`update cotizacion set estado = 'convertida', pedido_id = $2 where id = $1`, [o.cotizacion_id, pedidoId]);
  await tx.query('update oportunidad set pedido_id = $2 where id = $1', [id, pedidoId]);
  const { rows: p } = await tx.query<{ total: string }>('select total::text from documento_venta where id = $1', [pedidoId]);
  return { pedidoId, difiereDeCotizacion: !new Decimal(p[0].total).equals(q[0].total) };
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaOportunidad {
  id: string; titulo: string; tercero_id: string; tercero: string; prospecto: boolean; vendedor: string; etapa: Etapa;
  monto_estimado_usd: string; cierre_estimado: string | null; creada: string; cerrada: string | null;
  cotizacion_numero: string | null; pedido_id: string | null; motivo_perdida: string | null;
}

export async function listarOportunidades(
  db: Db, u: Usuario, filtro: { terceroId?: string; etapa?: string; abiertas?: boolean } = {}, limite = 300,
): Promise<FilaOportunidad[]> {
  const { rows } = await db.query<FilaOportunidad>(
    `select o.id, o.titulo, o.tercero_id, t.razon_social as tercero, c.tercero_id is null as prospecto, v.nombre as vendedor, o.etapa,
            o.monto_estimado_usd::text, to_char(o.cierre_estimado, 'DD-MM-YYYY') as cierre_estimado,
            to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as creada,
            to_char(o.cerrada_at at time zone 'America/Caracas', 'DD-MM-YYYY') as cerrada,
            q.numero::text as cotizacion_numero, o.pedido_id,
            m.nombre || coalesce(' · ' || o.motivo_perdida, '') as motivo_perdida
       from oportunidad o
       join tercero t on t.id = o.tercero_id
       join vendedor v on v.id = o.vendedor_id
       left join cliente c on c.tercero_id = o.tercero_id
       left join cotizacion q on q.id = o.cotizacion_id
       left join motivo m on m.id = o.motivo_perdida_id
      where (not $1 or v.usuario_id = $2)
        and ($3::uuid is null or o.tercero_id = $3)
        and ($4 = '' or o.etapa = $4)
        and (not $5 or o.cerrada_at is null)
      order by o.cerrada_at is null desc, o.cierre_estimado nulls last, o.created_at desc
      limit $6`, [soloLoSuyo(u), u.id, filtro.terceroId || null, filtro.etapa ?? '', !!filtro.abiertas, limite]);
  return rows;
}

export interface DetalleOportunidad extends FilaOportunidad {
  vendedor_id: string; vendedor_usuario: string | null; cotizacion_id: string | null; cotizacion_vigente: string | null;
  cotizacion_estado: string | null; pedido_numero: string | null; cliente_estado: string | null; creado_por: string; cierre_iso: string | null;
}

export async function detalleOportunidad(db: Db, id: string): Promise<DetalleOportunidad | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<DetalleOportunidad>(
    `select o.id, o.titulo, o.tercero_id, t.razon_social as tercero, c.tercero_id is null as prospecto, v.nombre as vendedor, o.etapa,
            o.monto_estimado_usd::text, to_char(o.cierre_estimado, 'DD-MM-YYYY') as cierre_estimado, o.cierre_estimado::text as cierre_iso,
            to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as creada,
            to_char(o.cerrada_at at time zone 'America/Caracas', 'DD-MM-YYYY') as cerrada,
            q.numero::text as cotizacion_numero, o.pedido_id, m.nombre || coalesce(' · ' || o.motivo_perdida, '') as motivo_perdida,
            o.vendedor_id, v.usuario_id as vendedor_usuario, o.cotizacion_id, to_char(q.vigente_hasta, 'DD-MM-YYYY') as cotizacion_vigente,
            q.estado as cotizacion_estado, d.numero::text as pedido_numero, c.estado as cliente_estado, us.nombre as creado_por
       from oportunidad o
       join tercero t on t.id = o.tercero_id
       join vendedor v on v.id = o.vendedor_id
       join usuario us on us.id = o.created_by
       left join cliente c on c.tercero_id = o.tercero_id
       left join cotizacion q on q.id = o.cotizacion_id
       left join documento_venta d on d.id = o.pedido_id
       left join motivo m on m.id = o.motivo_perdida_id
      where o.id = $1`, [id]);
  return rows[0] ?? null;
}
