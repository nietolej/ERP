import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { cancelarSolicitud, solicitarAprobacion } from '@/lib/flujo/flujo';
import { motivoSistema, textoDeAnulacion, type MotivoDocumento } from '@/lib/maestros/motivos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { cancelarOrdenDeNota, crearOrdenPicking } from './picking';
import { promocionParaLinea } from './promociones';

/**
 * Pedido de venta y nota de entrega (§6.1, §6.2). Ambos son `documento_venta`; la base de datos
 * garantiza la numeración, la inmutabilidad al emitir, la base e IVA guardados y las reservas
 * (migración 0017). Aquí viven los flujos:
 *
 *   borrador → emitir → (crédito ok) aprobado, con existencia reservada
 *                     → (crédito excedido) retenido_credito → Gerencia aprueba o rechaza (flujo 'pedido_credito')
 *   pedido aprobado → nota de entrega (con lo reservado) → [salida de mercancía: picking, siguiente entrega]
 *
 * La nota de entrega va en USD, igual que el pedido; la factura fiscal en bolívares es otro documento (decisión 14).
 */

export const ROLES_VENDEN = ['ventas', 'supervisor_ventas', 'facturacion', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_VENTAS = [...ROLES_VENDEN, 'cobranzas', 'almacen', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];
/** Roles que ven los documentos de todos los vendedores. Quien solo tiene Ventas ve los suyos. */
const VEN_TODOS: readonly string[] = [
  'supervisor_ventas', 'facturacion', 'gerencia', 'cobranzas', 'almacen', 'contabilidad', 'jefe_contabilidad', 'auditor',
];

export type Usuario = { id: string; roles: readonly string[] };

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;

export const verTodosLosDocumentos = (u: Usuario): boolean => u.roles.some((r) => VEN_TODOS.includes(r));

/** Quien solo tiene el rol Ventas vende únicamente a su cartera (seguridad por fila, §4.3). */
export const soloSuCartera = (u: Usuario): boolean =>
  u.roles.includes('ventas') && !u.roles.some((r) => ['supervisor_ventas', 'facturacion', 'gerencia'].includes(r));

interface Documento {
  id: string; tipo: string; estado: string; situacion: string | null; cliente_id: string; almacen_id: string;
  numero: string | null; documento_origen_id: string | null; vendedor_usuario: string | null;
}

async function documento(tx: Db, id: string, tipo: 'pedido' | 'nota_entrega', bloquear = true): Promise<Documento> {
  const { rows } = await tx.query<Documento>(
    `select d.id, d.tipo, d.estado, d.situacion, d.cliente_id, d.almacen_id, d.numero::text, d.documento_origen_id,
            v.usuario_id as vendedor_usuario
       from documento_venta d left join vendedor v on v.id = d.vendedor_id
      where d.id = $1 ${bloquear ? 'for update of d' : ''}`, [id]);
  if (!rows[0] || rows[0].tipo !== tipo) {
    throw new ErrorMaestro(tipo === 'pedido' ? 'El pedido no existe.' : 'La nota de entrega no existe.');
  }
  return rows[0];
}

/** ¿Puede este usuario ver y trabajar sobre un documento de ese vendedor? */
export function puedeTrabajarDocumento(u: Usuario, doc: { vendedor_usuario: string | null }): boolean {
  return !soloSuCartera(u) || doc.vendedor_usuario === u.id;
}

function exigirPropio(u: Usuario, doc: Documento): void {
  if (!puedeTrabajarDocumento(u, doc)) throw new ErrorMaestro('Ese documento es de otro vendedor.');
}

// ---------------------------------------------------------------------
// Borrador
// ---------------------------------------------------------------------

export interface DatosPedido {
  clienteId: string;
  almacenId: string;
  observaciones?: string;
}

/** Crea un pedido en borrador. El vendedor es el del cliente; la sucursal, la del almacén. */
export async function crearPedido(tx: Db, u: Usuario, d: DatosPedido): Promise<string> {
  const { rows: cli } = await tx.query<{ estado: string; vendedor_id: string | null; vendedor_usuario: string | null }>(
    `select c.estado, c.vendedor_id, v.usuario_id as vendedor_usuario
       from cliente c left join vendedor v on v.id = c.vendedor_id where c.tercero_id = $1`, [d.clienteId]);
  if (!cli[0]) throw new ErrorMaestro('Seleccione el cliente.');
  if (cli[0].estado !== 'activo') throw new ErrorMaestro('Solo se vende a clientes activos: este cliente está pendiente de aprobación, inactivo o bloqueado.');
  if (soloSuCartera(u) && cli[0].vendedor_usuario !== u.id) throw new ErrorMaestro('Ese cliente no está en su cartera.');

  const { rows: alm } = await tx.query<{ sucursal_id: string; activo: boolean; permite_venta: boolean }>(
    'select sucursal_id, activo, permite_venta from almacen where id = $1', [d.almacenId]);
  if (!alm[0]) throw new ErrorMaestro('Seleccione el almacén.');
  if (!alm[0].activo || !alm[0].permite_venta) throw new ErrorMaestro('Ese almacén no está habilitado para vender.');

  const { rows } = await tx.query<{ id: string }>(
    `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, vendedor_id, observaciones, created_by)
     values ('pedido', $1, $2, $3, $4, $5, $6) returning id`,
    [alm[0].sucursal_id, d.almacenId, d.clienteId, cli[0].vendedor_id, d.observaciones?.trim() || null, u.id]);
  return rows[0].id;
}

async function exigirBorrador(tx: Db, u: Usuario, id: string): Promise<Documento> {
  const doc = await documento(tx, id, 'pedido');
  exigirPropio(u, doc);
  if (doc.estado !== 'borrador') throw new ErrorMaestro('Solo se edita un pedido en borrador.');
  return doc;
}

export async function actualizarObservaciones(tx: Db, u: Usuario, id: string, observaciones: string): Promise<void> {
  await exigirBorrador(tx, u, id);
  await tx.query('update documento_venta set observaciones = $2 where id = $1', [id, observaciones.trim() || null]);
}

/**
 * Motivo con que queda una línea según su descuento: sin descuento no lleva motivo; el descuento pactado con el cliente
 * lleva el motivo del sistema; cualquier otro descuento exige que quien vende elija el motivo (catálogo de Gerencia).
 */
async function motivoDeDescuento(tx: Db, pct: Decimal, descuentoCliente: string, motivoId?: string): Promise<string | null> {
  if (pct.isZero()) return null;
  if (pct.equals(descuentoCliente)) return motivoSistema(tx, 'descuento', 'DESCUENTO_CLIENTE');
  if (!motivoId) throw new ErrorMaestro('Indique el motivo del descuento: es distinto del que tiene pactado el cliente.');
  return motivoId;
}

/**
 * Precio, descuento y promoción con que queda una línea cuando nadie escribió un descuento a mano: parte del descuento pactado
 * con el cliente y lo cambia por la mejor promoción vigente si esta deja un precio neto menor (no se acumulan; §6.2).
 */
async function precioAutomatico(
  tx: Db, d: { productoId: string; clienteId: string; cantidad: string; precioLista: string; descuentoCliente: string },
): Promise<{ precioUnitario: string; descuentoPct: string; promocionId: string | null }> {
  const { rows } = await tx.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`);
  const promo = await promocionParaLinea(tx, { productoId: d.productoId, clienteId: d.clienteId, fecha: rows[0].hoy, cantidad: d.cantidad, precioLista: d.precioLista });
  const netoCliente = new Decimal(d.precioLista).times(new Decimal(100).minus(d.descuentoCliente)).div(100);
  if (promo && new Decimal(promo.precioNeto).lt(netoCliente)) {
    return { precioUnitario: promo.precioUnitario, descuentoPct: promo.descuentoPct, promocionId: promo.promocionId };
  }
  return { precioUnitario: d.precioLista, descuentoPct: d.descuentoCliente, promocionId: null };
}

/** Motivo de una línea con promoción: el del sistema si hay descuento; sin descuento (precio especial) no lleva motivo. */
const motivoDePromocion = (tx: Db, descuentoPct: string) =>
  new Decimal(descuentoPct).isZero() ? Promise.resolve(null) : motivoSistema(tx, 'descuento', 'PROMOCION');

/**
 * Agrega un producto. El precio sale de la lista del nivel del cliente vigente hoy; no se escribe a mano.
 * El descuento por defecto es el del cliente, o el de la mejor promoción vigente si deja un precio menor.
 */
export async function agregarLinea(
  tx: Db, u: Usuario, pedidoId: string, d: { productoId: string; cantidad: string; descuentoPct?: string; motivoDescuentoId?: string },
): Promise<void> {
  const doc = await exigirBorrador(tx, u, pedidoId);
  const cantidad = d.cantidad.trim();
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser mayor que cero, con hasta 4 decimales.');
  if (d.descuentoPct !== undefined && d.descuentoPct.trim() !== '' &&
      (!PORCENTAJE.test(d.descuentoPct.trim()) || new Decimal(d.descuentoPct).gt(100))) {
    throw new ErrorMaestro('El descuento debe ser un porcentaje entre 0 y 100.');
  }
  const { rows: prod } = await tx.query<{
    descripcion: string; estado: string; alicuota_iva_id: string; producto_base_id: string | null; inventariable: boolean;
    nivel: string; descuento_cliente: string; precio: string | null;
  }>(
    `select p.descripcion, p.estado, p.alicuota_iva_id, p.producto_base_id, p.inventariable,
            c.nivel_precio as nivel, c.descuento_pct as descuento_cliente,
            fn_precio(p.id, c.nivel_precio, (now() at time zone 'America/Caracas')::date)::text as precio
       from producto p, cliente c where p.id = $1 and c.tercero_id = $2`, [d.productoId, doc.cliente_id]);
  const p = prod[0];
  if (!p) throw new ErrorMaestro('El producto no existe.');
  if (p.estado !== 'activo') throw new ErrorMaestro('El producto está inactivo.');
  if (p.precio === null) throw new ErrorMaestro(`El producto no tiene precio vigente en la lista ${p.nivel} del cliente.`);
  const { rows: previa } = await tx.query('select 1 from documento_venta_linea where documento_id = $1 and producto_id = $2', [pedidoId, d.productoId]);
  if (previa.length) throw new ErrorMaestro('Ese producto ya está en el pedido: cambie su cantidad.');

  // Un descuento escrito a mano manda: sin promoción. Si no, se aplica la mejor promoción vigente.
  const manual = d.descuentoPct?.trim() ? d.descuentoPct.trim() : null;
  const auto = manual
    ? { precioUnitario: p.precio, descuentoPct: manual, promocionId: null as string | null }
    : await precioAutomatico(tx, { productoId: d.productoId, clienteId: doc.cliente_id, cantidad, precioLista: p.precio, descuentoCliente: p.descuento_cliente });
  const motivo = auto.promocionId
    ? await motivoDePromocion(tx, auto.descuentoPct)
    : await motivoDeDescuento(tx, new Decimal(auto.descuentoPct), p.descuento_cliente, d.motivoDescuentoId);
  await tx.query(
    `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, descuento_pct,
                                        alicuota_iva_id, producto_base_id, lista_precio, precio_lista, motivo_descuento_id, promocion_id)
     values ($1, (select coalesce(max(linea), 0) + 1 from documento_venta_linea where documento_id = $1),
             $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [pedidoId, d.productoId, p.descripcion, cantidad, auto.precioUnitario, auto.descuentoPct,
     p.alicuota_iva_id, p.producto_base_id, p.nivel, p.precio, motivo, auto.promocionId]);
  await tx.query('select fn_venta_calcular($1)', [pedidoId]);
}

export async function cambiarLinea(
  tx: Db, u: Usuario, pedidoId: string, lineaId: string, d: { cantidad: string; descuentoPct?: string; motivoDescuentoId?: string },
): Promise<void> {
  const doc = await exigirBorrador(tx, u, pedidoId);
  const cantidad = d.cantidad.trim();
  if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser mayor que cero, con hasta 4 decimales.');
  const descuento = d.descuentoPct?.trim();
  if (descuento && (!PORCENTAJE.test(descuento) || new Decimal(descuento).gt(100))) throw new ErrorMaestro('El descuento debe ser un porcentaje entre 0 y 100.');
  const { rows: actual } = await tx.query<{
    descuento_pct: string; motivo_descuento_id: string | null; descuento_cliente: string; producto_id: string;
    precio_lista: string; precio_unitario: string; promocion_id: string | null;
  }>(
    `select l.descuento_pct::text, l.motivo_descuento_id, c.descuento_pct::text as descuento_cliente, l.producto_id,
            l.precio_lista::text, l.precio_unitario::text, l.promocion_id
       from documento_venta_linea l join cliente c on c.tercero_id = $3 where l.id = $2 and l.documento_id = $1`, [pedidoId, lineaId, doc.cliente_id]);
  const a = actual[0];
  if (!a) throw new ErrorMaestro('La línea no existe.');
  // Si el descuento no cambia, conserva su motivo; si cambia, el nuevo descuento necesita el suyo y deja de ser de una promoción.
  let pct = a.descuento_pct;
  let precio = a.precio_unitario;
  let motivo = a.motivo_descuento_id;
  let promocionId = a.promocion_id;
  if (descuento && !new Decimal(descuento).equals(pct)) {
    pct = new Decimal(descuento).toFixed(2);
    precio = a.precio_lista;
    promocionId = null;
    motivo = await motivoDeDescuento(tx, new Decimal(pct), a.descuento_cliente, d.motivoDescuentoId);
  } else if (a.promocion_id || new Decimal(a.descuento_pct).equals(a.descuento_cliente)) {
    // La línea no tiene un descuento escrito a mano: con la nueva cantidad se vuelve a buscar la mejor promoción.
    const auto = await precioAutomatico(tx, { productoId: a.producto_id, clienteId: doc.cliente_id, cantidad, precioLista: a.precio_lista, descuentoCliente: a.descuento_cliente });
    precio = auto.precioUnitario;
    pct = auto.descuentoPct;
    promocionId = auto.promocionId;
    motivo = auto.promocionId
      ? await motivoDePromocion(tx, pct)
      : await motivoDeDescuento(tx, new Decimal(pct), a.descuento_cliente);
  }
  await tx.query(
    `update documento_venta_linea set cantidad = $3, precio_unitario = $4, descuento_pct = $5, motivo_descuento_id = $6, promocion_id = $7
      where id = $2 and documento_id = $1`,
    [pedidoId, lineaId, cantidad, precio, pct, motivo, promocionId]);
  await tx.query('select fn_venta_calcular($1)', [pedidoId]);
}

export async function quitarLinea(tx: Db, u: Usuario, pedidoId: string, lineaId: string): Promise<void> {
  await exigirBorrador(tx, u, pedidoId);
  await tx.query('delete from documento_venta_linea where id = $2 and documento_id = $1', [pedidoId, lineaId]);
  await tx.query('select fn_venta_calcular($1)', [pedidoId]);
}

export async function eliminarBorrador(tx: Db, u: Usuario, pedidoId: string): Promise<void> {
  await exigirBorrador(tx, u, pedidoId);
  await tx.query('delete from documento_venta where id = $1', [pedidoId]);
}

// ---------------------------------------------------------------------
// Emisión, crédito y reserva
// ---------------------------------------------------------------------

export type SituacionEmision = 'aprobado' | 'retenido_credito';

/**
 * Emite el pedido: guarda número, tasa BCV del día y totales. Si el cliente tiene crédito y el pedido lo excede,
 * queda retenido hasta que Gerencia lo apruebe; si no, se aprueba y reserva la existencia disponible.
 */
export async function emitirPedido(tx: Db, u: Usuario, id: string): Promise<{ situacion: SituacionEmision; motivo?: string }> {
  await exigirBorrador(tx, u, id);
  await tx.query('select fn_venta_calcular($1)', [id]);
  const { rows: cli } = await tx.query<{ estado: string; dias: number | null; limite: string; exposicion: string; total: string }>(
    `select c.estado, cp.dias, c.limite_credito_usd::text as limite, fn_exposicion_credito_usd(c.tercero_id)::text as exposicion,
            d.total_usd::text as total
       from documento_venta d
       join cliente c on c.tercero_id = d.cliente_id
       left join condicion_pago cp on cp.id = c.condicion_pago_id
      where d.id = $1`, [id]);
  const c = cli[0];
  if (c.estado !== 'activo') throw new ErrorMaestro('El cliente ya no está activo: no se puede emitir el pedido.');

  // La condición de contado no usa crédito: el pedido se cobra al entregar. Con plazo, se valida el límite.
  const total = new Decimal(c.total);
  const comprometido = new Decimal(c.exposicion).plus(total);
  const excede = (c.dias ?? 0) > 0 && comprometido.gt(c.limite);

  await tx.query(`update documento_venta set estado = 'emitido' where id = $1`, [id]);
  if (excede) {
    await tx.query(`update documento_venta set situacion = 'retenido_credito' where id = $1`, [id]);
    await solicitarAprobacion(tx, {
      tipo: 'pedido_credito', objetoId: id, solicitanteId: u.id,
      contexto: { total_usd: total.toNumber(), exceso_usd: comprometido.minus(c.limite).toNumber() },
    });
    return {
      situacion: 'retenido_credito',
      motivo: `Con este pedido el cliente comprometería US$ ${comprometido.toFixed(2)} y su límite es US$ ${new Decimal(c.limite).toFixed(2)}.`,
    };
  }
  await aprobarYReservar(tx, id, null);
  return { situacion: 'aprobado' };
}

/** Marca el pedido como aprobado y reserva lo disponible. El faltante se registra como demanda no atendida. */
async function aprobarYReservar(tx: Db, id: string, aprobador: string | null): Promise<void> {
  await tx.query(
    `update documento_venta set situacion = 'aprobado', aprobado_por = $2, aprobado_at = case when $2::uuid is null then null else now() end
      where id = $1`, [id, aprobador]);
  await reservarExistencia(tx, id);
}

/**
 * Reserva la existencia disponible para lo que falta de cada línea del pedido (puede ser parcial).
 * Devuelve lo que no se pudo reservar. La demanda no atendida (§6.1) se registra solo la primera vez
 * que el pedido se reserva, cuando se constata que no había.
 */
export async function reservarExistencia(
  tx: Db, id: string, opciones: { registrarDemanda?: boolean } = {},
): Promise<{ faltante: number }> {
  const registrar = opciones.registrarDemanda ?? true;
  const { rows: ped } = await tx.query<{ cliente_id: string; almacen_id: string }>(
    `select cliente_id, almacen_id from documento_venta where id = $1 and tipo = 'pedido' and estado = 'emitido' and situacion = 'aprobado'`, [id]);
  if (!ped[0]) throw new ErrorMaestro('Solo se reserva existencia para un pedido aprobado.');
  const { rows: lineas } = await tx.query<{ id: string; producto_id: string; pendiente: string; disponible: string; inventariable: boolean }>(
    `select l.id, l.producto_id, p.inventariable,
            (l.cantidad - coalesce((select sum(r.cantidad) from reserva_inventario r
                                     where r.pedido_linea_id = l.id and r.estado in ('activa', 'en_nota', 'consumida')), 0))::text as pendiente,
            coalesce((select e.cantidad - e.reservado from existencia e where e.producto_id = l.producto_id and e.almacen_id = $2), 0)::text as disponible
       from documento_venta_linea l join producto p on p.id = l.producto_id
      where l.documento_id = $1 order by l.linea`, [id, ped[0].almacen_id]);
  let faltante = new Decimal(0);
  for (const l of lineas) {
    if (!l.inventariable) continue;
    const pendiente = new Decimal(l.pendiente);
    if (pendiente.lte(0)) continue;
    const reservar = Decimal.min(pendiente, Decimal.max(new Decimal(l.disponible), 0));
    if (reservar.gt(0)) {
      await tx.query(
        `insert into reserva_inventario (pedido_id, pedido_linea_id, producto_id, almacen_id, cantidad) values ($1, $2, $3, $4, $5)`,
        [id, l.id, l.producto_id, ped[0].almacen_id, reservar.toString()]);
    }
    const falta = pendiente.minus(reservar);
    if (falta.gt(0)) {
      faltante = faltante.plus(falta);
      if (registrar) {
        await tx.query(
          `insert into demanda_no_atendida (producto_id, almacen_id, cliente_id, documento_id, linea_id, cantidad, motivo_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [l.producto_id, ped[0].almacen_id, ped[0].cliente_id, id, l.id, falta.toString(), await motivoSistema(tx, 'venta_perdida', 'SIN_EXISTENCIA')]);
      }
    }
  }
  return { faltante: faltante.toNumber() };
}

/** Gerencia aprueba un pedido retenido por crédito (lo llama el motor de flujo). */
export async function aprobarPedidoCredito(tx: Db, id: string, aprobador: string): Promise<void> {
  const doc = await documento(tx, id, 'pedido');
  if (doc.estado !== 'emitido' || doc.situacion !== 'retenido_credito') throw new ErrorMaestro('El pedido no está retenido por crédito.');
  await aprobarYReservar(tx, id, aprobador);
}

/** Gerencia rechaza un pedido retenido por crédito: se anula con su motivo (lo llama el motor de flujo). */
export async function rechazarPedidoCredito(tx: Db, id: string, usuario: string, motivo: string): Promise<void> {
  const doc = await documento(tx, id, 'pedido');
  if (doc.estado !== 'emitido' || doc.situacion !== 'retenido_credito') throw new ErrorMaestro('El pedido no está retenido por crédito.');
  await tx.query(
    `update documento_venta set estado = 'anulado', anulado_por = $2, anulado_motivo = $3, anulado_motivo_id = $4 where id = $1`,
    [id, usuario, `Rechazado por crédito: ${motivo.trim()}`, await motivoSistema(tx, 'anulacion', 'CREDITO_RECHAZADO')]);
}

// ---------------------------------------------------------------------
// Anulación
// ---------------------------------------------------------------------

/** Anula un pedido emitido que aún no tiene notas de entrega vigentes. Libera sus reservas. */
export async function anularPedido(tx: Db, u: Usuario, id: string, motivo: MotivoDocumento): Promise<void> {
  const doc = await documento(tx, id, 'pedido');
  exigirPropio(u, doc);
  if (doc.estado !== 'emitido') throw new ErrorMaestro('Solo se anula un pedido emitido.');
  const texto = await textoDeAnulacion(tx, motivo);
  const { rows } = await tx.query(
    `select 1 from documento_venta where documento_origen_id = $1 and tipo = 'nota_entrega' and estado = 'emitido'`, [id]);
  if (rows.length) throw new ErrorMaestro('El pedido tiene notas de entrega vigentes: anúlelas primero.');
  await tx.query(`update reserva_inventario set estado = 'liberada' where pedido_id = $1 and estado = 'activa'`, [id]);
  await tx.query(`update documento_venta set estado = 'anulado', anulado_por = $2, anulado_motivo = $3, anulado_motivo_id = $4 where id = $1`,
    [id, u.id, texto, motivo.motivoId]);
  await cancelarSolicitud(tx, 'pedido_credito', id);
}

// ---------------------------------------------------------------------
// Nota de entrega
// ---------------------------------------------------------------------

export interface ReservaPorNota { id: string; pedido_linea_id: string; cantidad: string }

/**
 * Crea y emite una nota de entrega con las reservas indicadas (activas de un mismo pedido) y crea su orden de picking si
 * el almacén lo usa. Mantiene el precio, el descuento y el IVA del pedido; la nota toma su propia tasa del día.
 */
export async function crearNotaDesdeReservas(
  tx: Db, u: Usuario, pedidoId: string, reservas: ReservaPorNota[], opciones: { prioridad?: number; crearPicking?: boolean } = {},
): Promise<string> {
  const { rows: nota } = await tx.query<{ id: string }>(
    `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, vendedor_id, documento_origen_id, observaciones, created_by)
     select 'nota_entrega', sucursal_id, almacen_id, cliente_id, vendedor_id, id, observaciones, $2 from documento_venta where id = $1
     returning id`, [pedidoId, u.id]);
  const notaId = nota[0].id;

  // Una línea de nota por línea de pedido, con la suma de sus reservas.
  const porLinea = new Map<string, Decimal>();
  for (const r of reservas) porLinea.set(r.pedido_linea_id, (porLinea.get(r.pedido_linea_id) ?? new Decimal(0)).plus(r.cantidad));
  const lineaDeNota = new Map<string, string>();
  for (const [lineaPedido, cantidad] of porLinea) {
    const { rows } = await tx.query<{ id: string }>(
      `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, descuento_pct,
                                          alicuota_iva_id, producto_base_id, lista_precio, precio_lista, linea_origen_id, motivo_descuento_id, promocion_id)
       select $1, (select coalesce(max(linea), 0) + 1 from documento_venta_linea where documento_id = $1),
              producto_id, descripcion, $3, precio_unitario, descuento_pct, alicuota_iva_id, producto_base_id, lista_precio, precio_lista, id,
              motivo_descuento_id, promocion_id
         from documento_venta_linea where id = $2 returning id`, [notaId, lineaPedido, cantidad.toString()]);
    lineaDeNota.set(lineaPedido, rows[0].id);
  }
  await tx.query('select fn_venta_calcular($1)', [notaId]);
  await tx.query(`update documento_venta set estado = 'emitido' where id = $1`, [notaId]);
  for (const r of reservas) {
    await tx.query(`update reserva_inventario set estado = 'en_nota', nota_id = $2, nota_linea_id = $3 where id = $1`,
      [r.id, notaId, lineaDeNota.get(r.pedido_linea_id)]);
  }
  const { rows: alm } = await tx.query<{ usa_picking: boolean }>(
    `select a.usa_picking from documento_venta d join almacen a on a.id = d.almacen_id where d.id = $1`, [notaId]);
  if (alm[0].usa_picking && (opciones.crearPicking ?? true)) await crearOrdenPicking(tx, u, notaId, opciones.prioridad);
  return notaId;
}

/** Genera una nota de entrega con lo que hay reservado y todavía no figura en otra nota. */
export async function generarNotaEntrega(tx: Db, u: Usuario, pedidoId: string, opciones: { prioridad?: number } = {}): Promise<string> {
  const doc = await documento(tx, pedidoId, 'pedido');
  exigirPropio(u, doc);
  if (doc.estado !== 'emitido' || doc.situacion !== 'aprobado') throw new ErrorMaestro('Solo se entrega un pedido aprobado.');
  const { rows: reservas } = await tx.query<ReservaPorNota>(
    `select r.id, r.pedido_linea_id, r.cantidad::text from reserva_inventario r join documento_venta_linea l on l.id = r.pedido_linea_id
      where r.pedido_id = $1 and r.estado = 'activa' order by l.linea, r.created_at, r.id`, [pedidoId]);
  if (!reservas.length) throw new ErrorMaestro('El pedido no tiene existencia reservada para entregar.');
  return crearNotaDesdeReservas(tx, u, pedidoId, reservas, { prioridad: opciones.prioridad });
}

/** Anula una nota de entrega vigente: la mercancía vuelve a estar reservada para el pedido y su picking se cancela. */
export async function anularNotaEntrega(tx: Db, u: Usuario, notaId: string, motivo: MotivoDocumento): Promise<void> {
  const doc = await documento(tx, notaId, 'nota_entrega');
  if (doc.estado !== 'emitido') throw new ErrorMaestro('Solo se anula una nota de entrega emitida.');
  const texto = await textoDeAnulacion(tx, motivo);
  const { rows } = await tx.query(`select 1 from documento_venta where id = $1 and salida_at is not null`, [notaId]);
  if (rows.length) throw new ErrorMaestro('La mercancía de esta nota ya salió del almacén: no se anula, se corrige con una devolución.');
  await cancelarOrdenDeNota(tx, notaId);
  await tx.query(`update reserva_inventario set estado = 'activa', nota_id = null, nota_linea_id = null where nota_id = $1 and estado = 'en_nota'`, [notaId]);
  await tx.query(`update documento_venta set estado = 'anulado', anulado_por = $2, anulado_motivo = $3, anulado_motivo_id = $4 where id = $1`,
    [notaId, u.id, texto, motivo.motivoId]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaDocumento {
  id: string; numero: string | null; estado: string; situacion: string | null; fecha: string | null;
  cliente_codigo: string; cliente: string; vendedor: string | null; almacen: string; total_usd: string; total_ves: string;
  origen_numero: string | null;
}

/** Documentos de venta de un tipo, con la seguridad por fila: quien solo vende ve los suyos. */
export async function buscarDocumentos(
  db: Db, u: Usuario, tipo: 'pedido' | 'nota_entrega', filtro: { estado?: string; texto?: string }, limite = 100,
): Promise<FilaDocumento[]> {
  if (!verTodosLosDocumentos(u) && !u.roles.includes('ventas')) return [];
  const texto = (filtro.texto ?? '').trim();
  const { rows } = await db.query<FilaDocumento>(
    `select d.id, d.numero::text, d.estado,
            case when d.factura_id is not null then 'facturada' when d.salida_at is not null then 'despachada' else d.situacion end as situacion, to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha,
            c.codigo as cliente_codigo, t.razon_social as cliente, v.nombre as vendedor, a.codigo as almacen,
            d.total_usd::text, d.total_ves::text, o.numero::text as origen_numero
       from documento_venta d
       join cliente c on c.tercero_id = d.cliente_id
       join tercero t on t.id = c.tercero_id
       join almacen a on a.id = d.almacen_id
       left join vendedor v on v.id = d.vendedor_id
       left join documento_venta o on o.id = d.documento_origen_id
      where d.tipo = $1
        and ($2 or v.usuario_id = $3)
        and ($4 = '' or d.estado = $4 or d.situacion = $4)
        and ($5 = '' or d.numero::text = $5 or c.codigo ilike '%' || $5 || '%'
                     or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($5) || '%')
      order by d.created_at desc
      limit $6`,
    [tipo, verTodosLosDocumentos(u), u.id, filtro.estado ?? '', texto, limite]);
  return rows;
}

export interface LineaDocumento {
  id: string; linea: number; producto_id: string; codigo: string; descripcion: string; cantidad: string; precio_unitario: string;
  descuento_pct: string; alicuota_pct: string; base: string; iva: string; total: string;
  reservado: string; entregado: string; disponible: string | null;
}

export interface DetalleDocumento {
  id: string; tipo: string; numero: string | null; estado: string; situacion: string | null; fecha: string | null;
  salida: string | null; picking_id: string | null; picking_estado: string | null; picking_empacado: boolean | null; usa_picking: boolean;
  cliente_id: string; cliente_codigo: string; cliente: string; rif: string; vendedor: string | null; vendedor_usuario: string | null;
  almacen_id: string; almacen: string; origen_id: string | null; origen_numero: string | null;
  tasa: string | null; subtotal: string; descuento: string; base_imponible: string; exento: string; iva: string; total: string;
  total_ves: string; observaciones: string | null; creado_por: string; anulado_motivo: string | null;
  nivel_precio: string; limite_credito: string; condicion_dias: number | null; exposicion: string;
  lineas: LineaDocumento[];
  notas: { id: string; numero: string; estado: string; total_usd: string }[];
}

/** Un documento con sus líneas. No aplica la seguridad por fila: quien llama usa `puedeTrabajarDocumento`. */
export async function detalleDocumento(db: Db, id: string): Promise<DetalleDocumento | null> {
  const { rows } = await db.query<Omit<DetalleDocumento, 'lineas' | 'notas'>>(
    `select d.id, d.tipo, d.numero::text, d.estado,
            case when d.factura_id is not null then 'facturada' when d.salida_at is not null then 'despachada' else d.situacion end as situacion,
            to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha,
            to_char(d.salida_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as salida,
            (select o.id from orden_picking o where o.nota_entrega_id = d.id and o.estado <> 'cancelada') as picking_id,
            (select o.estado from orden_picking o where o.nota_entrega_id = d.id and o.estado <> 'cancelada') as picking_estado,
            (select (o.empacada_at is not null) from orden_picking o where o.nota_entrega_id = d.id and o.estado <> 'cancelada') as picking_empacado,
            a.usa_picking,
            d.cliente_id, c.codigo as cliente_codigo, t.razon_social as cliente, t.rif, v.nombre as vendedor, v.usuario_id as vendedor_usuario,
            d.almacen_id, a.codigo || ' · ' || a.nombre as almacen, d.documento_origen_id as origen_id, o.numero::text as origen_numero,
            d.tasa::text, d.subtotal::text, d.descuento::text, d.base_imponible::text, d.exento::text, d.iva::text, d.total::text,
            d.total_ves::text, d.observaciones, u.nombre as creado_por, d.anulado_motivo,
            c.nivel_precio, c.limite_credito_usd::text as limite_credito, cp.dias as condicion_dias,
            fn_exposicion_credito_usd(c.tercero_id)::text as exposicion
       from documento_venta d
       join cliente c on c.tercero_id = d.cliente_id
       join tercero t on t.id = c.tercero_id
       join almacen a on a.id = d.almacen_id
       join usuario u on u.id = d.created_by
       left join vendedor v on v.id = d.vendedor_id
       left join condicion_pago cp on cp.id = c.condicion_pago_id
       left join documento_venta o on o.id = d.documento_origen_id
      where d.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: lineas } = await db.query<LineaDocumento>(
    `select l.id, l.linea, l.producto_id, p.codigo, l.descripcion, l.cantidad::text, l.precio_unitario::text, l.descuento_pct::text,
            l.alicuota_pct::text, l.base::text, l.iva::text, l.total::text,
            coalesce((select sum(r.cantidad) from reserva_inventario r where r.pedido_linea_id = l.id and r.estado in ('activa', 'en_nota')), 0)::numeric(14,4)::text as reservado,
            coalesce((select sum(r.cantidad) from reserva_inventario r where r.pedido_linea_id = l.id and r.estado = 'consumida'), 0)::numeric(14,4)::text as entregado,
            (select (e.cantidad - e.reservado)::text from existencia e where e.producto_id = l.producto_id and e.almacen_id = $2) as disponible
       from documento_venta_linea l join producto p on p.id = l.producto_id
      where l.documento_id = $1 order by l.linea`, [id, rows[0].almacen_id]);
  const { rows: notas } = await db.query<{ id: string; numero: string; estado: string; total_usd: string }>(
    `select id, numero::text, estado, total_usd::text from documento_venta
      where documento_origen_id = $1 and tipo = 'nota_entrega' order by numero`, [id]);
  return { ...rows[0], lineas, notas };
}

/** Id del producto con ese código (sin importar mayúsculas ni espacios); falla si no existe. */
export async function productoPorCodigo(db: Db, codigo: string): Promise<string> {
  const limpio = codigo.trim().toUpperCase().replace(/\s+/g, '');
  if (!limpio) throw new ErrorMaestro('Indique el código del producto.');
  const { rows } = await db.query<{ id: string }>('select id from producto where upper(codigo) = $1', [limpio]);
  if (!rows[0]) throw new ErrorMaestro(`No existe un producto con el código ${limpio}.`);
  return rows[0].id;
}
