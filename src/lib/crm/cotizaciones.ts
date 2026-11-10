import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { motivoSistema } from '@/lib/maestros/motivos';
import { CANTIDAD, decimal, exigirTercero, FECHA, PORCENTAJE, soloLoSuyo, UUID, vendedorParaRegistro, type Usuario } from './comun';

/**
 * Cotización (§6.5 regla 2, migración 0058; decisión del 10-11-2026): documento propio en USD, con vigencia, numerado al
 * emitir. No reserva existencia ni pasa por crédito. El precio sale de la lista de precio vigente hoy, nunca a mano:
 * la del nivel del cliente, o la que se elige para un prospecto (todavía no tiene nivel: lo asigna Gerencia al aprobarlo).
 * Al ganarse la oportunidad se copia a un pedido en borrador (oportunidades.ts).
 */

export const LISTAS = ['A', 'B', 'D'] as const;

interface Cotizacion {
  id: string; estado: string; tercero_id: string; vendedor_usuario: string | null; lista_precio: string; cliente_descuento: string | null;
}

async function cotizacion(tx: Db, u: Usuario, id: string, bloquear = true): Promise<Cotizacion> {
  if (!UUID.test(id)) throw new ErrorMaestro('La cotización no existe.');
  const { rows } = await tx.query<Cotizacion>(
    `select q.id, q.estado, q.tercero_id, v.usuario_id as vendedor_usuario, q.lista_precio, c.descuento_pct::text as cliente_descuento
       from cotizacion q join vendedor v on v.id = q.vendedor_id left join cliente c on c.tercero_id = q.tercero_id
      where q.id = $1 ${bloquear ? 'for update of q' : ''}`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La cotización no existe.');
  if (soloLoSuyo(u) && rows[0].vendedor_usuario !== u.id) throw new ErrorMaestro('Esa cotización es de otro vendedor.');
  return rows[0];
}

async function borrador(tx: Db, u: Usuario, id: string): Promise<Cotizacion> {
  const q = await cotizacion(tx, u, id);
  if (q.estado !== 'borrador') throw new ErrorMaestro('Solo se edita una cotización en borrador.');
  return q;
}

export interface DatosCotizacion { terceroId: string; almacenId: string; vendedorId?: string | null; listaPrecio?: string; observaciones?: string }

export async function crearCotizacion(tx: Db, u: Usuario, d: DatosCotizacion): Promise<string> {
  const t = await exigirTercero(tx, u, d.terceroId);
  const activo = (t.es_cliente && t.cliente_estado === 'activo') || (!t.es_cliente && t.prospecto_estado === 'activo');
  if (!activo) throw new ErrorMaestro('Solo se cotiza a un cliente activo o a un prospecto activo.');
  let lista: string;
  if (t.es_cliente) {
    const { rows } = await tx.query<{ nivel_precio: string }>('select nivel_precio from cliente where tercero_id = $1', [t.id]);
    lista = rows[0].nivel_precio;
  } else {
    if (!d.listaPrecio || !(LISTAS as readonly string[]).includes(d.listaPrecio)) throw new ErrorMaestro('Seleccione la lista de precio para el prospecto.');
    lista = d.listaPrecio;
  }
  const { rows: alm } = await tx.query<{ sucursal_id: string; activo: boolean; permite_venta: boolean }>(
    'select sucursal_id, activo, permite_venta from almacen where id = $1', [d.almacenId]);
  if (!alm[0]) throw new ErrorMaestro('Seleccione el almacén.');
  if (!alm[0].activo || !alm[0].permite_venta) throw new ErrorMaestro('Ese almacén no está habilitado para vender.');
  const vendedorId = await vendedorParaRegistro(tx, u, d.vendedorId, t.vendedor_id);
  const { rows } = await tx.query<{ id: string }>(
    `insert into cotizacion (tercero_id, vendedor_id, sucursal_id, almacen_id, lista_precio, observaciones, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [t.id, vendedorId, alm[0].sucursal_id, d.almacenId, lista, d.observaciones?.trim() || null, u.id]);
  return rows[0].id;
}

/**
 * Agrega un producto al precio de la lista de la cotización. Sin descuento indicado lleva el pactado con el cliente
 * (prospecto: ninguno); un descuento distinto exige su motivo del catálogo.
 */
export async function agregarLineaCotizacion(
  tx: Db, u: Usuario, id: string, d: { productoId: string; cantidad: string; descuentoPct?: string; motivoDescuentoId?: string },
): Promise<void> {
  const q = await borrador(tx, u, id);
  const cantidad = decimal(d.cantidad);
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser mayor que cero, con hasta 4 decimales.');
  const manual = decimal(d.descuentoPct);
  if (manual && (!PORCENTAJE.test(manual) || new Decimal(manual).gt(100))) throw new ErrorMaestro('El descuento debe ser un porcentaje entre 0 y 100.');
  const { rows: prod } = await tx.query<{ descripcion: string; estado: string; alicuota_iva_id: string; precio: string | null }>(
    `select p.descripcion, p.estado, p.alicuota_iva_id, fn_precio(p.id, $2::char, fn_hoy_caracas())::text as precio from producto p where p.id = $1`,
    [d.productoId, q.lista_precio]);
  const p = prod[0];
  if (!p) throw new ErrorMaestro('El producto no existe.');
  if (p.estado !== 'activo') throw new ErrorMaestro('El producto está inactivo.');
  if (p.precio === null) throw new ErrorMaestro(`El producto no tiene precio vigente en la lista ${q.lista_precio}.`);
  const { rows: previa } = await tx.query('select 1 from cotizacion_linea where cotizacion_id = $1 and producto_id = $2', [id, d.productoId]);
  if (previa.length) throw new ErrorMaestro('Ese producto ya está en la cotización: quítelo y agréguelo con la nueva cantidad.');

  const pactado = q.cliente_descuento ?? '0';
  const pct = new Decimal(manual || pactado);
  let motivo: string | null = null;
  if (!pct.isZero()) {
    if (pct.equals(pactado)) motivo = await motivoSistema(tx, 'descuento', 'DESCUENTO_CLIENTE');
    else if (!d.motivoDescuentoId) throw new ErrorMaestro('Indique el motivo del descuento: es distinto del pactado con el cliente.');
    else motivo = d.motivoDescuentoId;
  }
  await tx.query(
    `insert into cotizacion_linea (cotizacion_id, linea, producto_id, descripcion, cantidad, precio_lista, precio_unitario, descuento_pct,
                                   motivo_descuento_id, alicuota_iva_id)
     values ($1, (select coalesce(max(linea), 0) + 1 from cotizacion_linea where cotizacion_id = $1), $2, $3, $4, $5, $5, $6, $7, $8)`,
    [id, d.productoId, p.descripcion, cantidad, p.precio, pct.toFixed(2), motivo, p.alicuota_iva_id]);
  await tx.query('select fn_cotizacion_calcular($1)', [id]);
}

export async function quitarLineaCotizacion(tx: Db, u: Usuario, id: string, lineaId: string): Promise<void> {
  await borrador(tx, u, id);
  await tx.query('delete from cotizacion_linea where id = $1 and cotizacion_id = $2', [lineaId, id]);
  await tx.query('select fn_cotizacion_calcular($1)', [id]);
}

export async function eliminarCotizacion(tx: Db, u: Usuario, id: string): Promise<void> {
  await borrador(tx, u, id);
  await tx.query('delete from cotizacion where id = $1', [id]);
}

/** Emite la cotización con su vigencia ('AAAA-MM-DD'): recalcula a la tasa y los precios de hoy y la numera. */
export async function emitirCotizacion(tx: Db, u: Usuario, id: string, vigenteHasta: string): Promise<string> {
  await borrador(tx, u, id);
  if (!FECHA.test(vigenteHasta)) throw new ErrorMaestro('Indique hasta qué fecha es válida la cotización.');
  await tx.query('select fn_cotizacion_calcular($1)', [id]);
  const { rows } = await tx.query<{ numero: string }>(
    `update cotizacion set estado = 'emitida', vigente_hasta = $2::date where id = $1 returning numero::text`, [id, vigenteHasta]);
  return rows[0].numero;
}

export async function anularCotizacion(tx: Db, u: Usuario, id: string, motivo: string): Promise<void> {
  const q = await cotizacion(tx, u, id);
  if (q.estado !== 'emitida') throw new ErrorMaestro('Solo se anula una cotización emitida que no se haya convertido en pedido.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  const { rows } = await tx.query(`select 1 from oportunidad where cotizacion_id = $1 and cerrada_at is null`, [id]);
  if (rows.length) throw new ErrorMaestro('La cotización está enlazada a una oportunidad abierta: enlace otra o cierre la oportunidad antes de anularla.');
  await tx.query(`update cotizacion set estado = 'anulada', anulado_por = $2, anulado_motivo = $3 where id = $1`, [id, u.id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaCotizacion {
  id: string; numero: string | null; estado: string; tercero_id: string; tercero: string; prospecto: boolean; vendedor: string;
  fecha: string | null; vigente_hasta: string | null; vencida: boolean; total: string;
}

export async function listarCotizaciones(db: Db, u: Usuario, filtro: { terceroId?: string; estado?: string } = {}, limite = 200): Promise<FilaCotizacion[]> {
  const { rows } = await db.query<FilaCotizacion>(
    `select q.id, q.numero::text, q.estado, q.tercero_id, t.razon_social as tercero, c.tercero_id is null as prospecto, v.nombre as vendedor,
            to_char(q.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, to_char(q.vigente_hasta, 'DD-MM-YYYY') as vigente_hasta,
            q.estado = 'emitida' and q.vigente_hasta < fn_hoy_caracas() as vencida, q.total::text
       from cotizacion q
       join tercero t on t.id = q.tercero_id
       join vendedor v on v.id = q.vendedor_id
       left join cliente c on c.tercero_id = q.tercero_id
      where (not $1 or v.usuario_id = $2)
        and ($3::uuid is null or q.tercero_id = $3)
        and ($4 = '' or q.estado = $4)
      order by q.created_at desc limit $5`, [soloLoSuyo(u), u.id, filtro.terceroId || null, filtro.estado ?? '', limite]);
  return rows;
}

export interface LineaCotizacion {
  id: string; linea: number; codigo: string; descripcion: string; cantidad: string; precio_lista: string; precio_unitario: string;
  descuento_pct: string; motivo: string | null; alicuota_pct: string; base: string; iva: string; total: string;
}

export interface DetalleCotizacion {
  id: string; numero: string | null; estado: string; tercero_id: string; tercero: string; rif: string; prospecto: boolean;
  vendedor: string; vendedor_usuario: string | null; almacen: string; lista_precio: string; fecha: string | null; vigente_hasta: string | null;
  vencida: boolean; tasa: string | null; subtotal: string; descuento: string; base_imponible: string; exento: string; iva: string; total: string;
  total_ves: string; observaciones: string | null; pedido_id: string | null; pedido_numero: string | null; anulado_motivo: string | null;
  creado_por: string; lineas: LineaCotizacion[];
}

export async function detalleCotizacion(db: Db, id: string): Promise<DetalleCotizacion | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<Omit<DetalleCotizacion, 'lineas'>>(
    `select q.id, q.numero::text, q.estado, q.tercero_id, t.razon_social as tercero, t.rif, c.tercero_id is null as prospecto,
            v.nombre as vendedor, v.usuario_id as vendedor_usuario, a.codigo || ' · ' || a.nombre as almacen, q.lista_precio,
            to_char(q.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, to_char(q.vigente_hasta, 'DD-MM-YYYY') as vigente_hasta,
            q.estado = 'emitida' and q.vigente_hasta < fn_hoy_caracas() as vencida, q.tasa::text, q.subtotal::text, q.descuento::text,
            q.base_imponible::text, q.exento::text, q.iva::text, q.total::text, q.total_ves::text, q.observaciones, q.pedido_id,
            d.numero::text as pedido_numero, q.anulado_motivo, us.nombre as creado_por
       from cotizacion q
       join tercero t on t.id = q.tercero_id
       join vendedor v on v.id = q.vendedor_id
       join almacen a on a.id = q.almacen_id
       join usuario us on us.id = q.created_by
       left join cliente c on c.tercero_id = q.tercero_id
       left join documento_venta d on d.id = q.pedido_id
      where q.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: lineas } = await db.query<LineaCotizacion>(
    `select l.id, l.linea, p.codigo, l.descripcion, l.cantidad::text, l.precio_lista::text, l.precio_unitario::text, l.descuento_pct::text,
            m.nombre as motivo, l.alicuota_pct::text, l.base::text, l.iva::text, l.total::text
       from cotizacion_linea l join producto p on p.id = l.producto_id left join motivo m on m.id = l.motivo_descuento_id
      where l.cotizacion_id = $1 order by l.linea`, [id]);
  return { ...rows[0], lineas };
}
