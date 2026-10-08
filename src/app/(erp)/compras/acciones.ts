'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import {
  ROLES_COMPRAN, actualizarOrden, anularOrden, crearOrden, eliminarBorrador, enviarOrden, guardarLinea, quitarLinea,
  type DatosOrden,
} from '@/lib/compras/ordenes';
import { ROLES_RECIBEN, recibirMercancia } from '@/lib/compras/recepciones';
import {
  ROLES_REGISTRAN_FACTURA, crearFactura, eliminarBorrador as eliminarFacturaBorrador, guardarLinea as guardarLineaFactura,
  quitarLinea as quitarLineaFactura, registrarFactura,
} from '@/lib/compras/facturas';
import {
  actualizarGasto, crearGasto, eliminarGasto, registrarGasto, type DatosGasto,
} from '@/lib/compras/gastos-importacion';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { productoPorCodigo } from '@/lib/ventas/pedidos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id: string) {
  revalidatePath('/compras/ordenes');
  revalidatePath(`/compras/ordenes/${id}`);
  revalidatePath('/compras/recepciones');
  revalidatePath('/inventario/existencias');
}

const datos = (fd: FormData): DatosOrden => ({
  proveedorId: texto(fd, 'proveedor_id'),
  almacenId: texto(fd, 'almacen_id'),
  moneda: texto(fd, 'moneda').toUpperCase(),
  criterioReparto: texto(fd, 'criterio_reparto'),
  fechaPrometida: texto(fd, 'fecha_prometida'),
  observaciones: texto(fd, 'observaciones'),
});

export async function crearOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    id = await conUsuario(u.id, (tx) => crearOrden(tx, u, datos(fd)));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/compras/ordenes');
  redirect(`/compras/ordenes/${id}`);
}

export async function actualizarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => actualizarOrden(tx, id, datos(fd)));
    recargar(id);
    return { ok: 'Orden actualizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function guardarLineaOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, async (tx) => {
      const productoId = await productoPorCodigo(tx, texto(fd, 'codigo'));
      await guardarLinea(tx, id, { productoId, cantidad: texto(fd, 'cantidad'), precio: texto(fd, 'precio') });
    });
    recargar(id);
    return { ok: 'Producto agregado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarLineaOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const id = texto(fd, 'id');
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(id) || !UUID.test(linea)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => quitarLinea(tx, id, linea));
    recargar(id);
    return { ok: 'Línea quitada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function enviarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => enviarOrden(tx, u, id));
    recargar(id);
    return { ok: 'Orden enviada a aprobación de Gerencia.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => eliminarBorrador(tx, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/compras/ordenes');
  redirect('/compras/ordenes');
}

export async function anularOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => anularOrden(tx, u, id, texto(fd, 'motivo')));
    recargar(id);
    return { ok: 'Orden anulada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function aprobarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'orden_compra', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Orden aprobada: ya se puede recibir la mercancía.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'orden_compra', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Orden rechazada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** Los campos `cant_<id de la línea>` traen lo recibido de cada producto. */
export async function recibirMercanciaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_RECIBEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    const lineas = [...fd.keys()].filter((k) => k.startsWith('cant_') && UUID.test(k.slice(5)))
      .map((k) => ({ lineaId: k.slice(5), cantidad: texto(fd, k) }));
    const r = await conUsuario(u.id, (tx) => recibirMercancia(tx, u, id, lineas, texto(fd, 'observaciones')));
    recargar(id);
    return { ok: `Recepción ${r.numero} registrada por US$ ${r.costoUsd}. El inventario y la contabilidad ya la reflejan.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------
// Facturas de compra
// ---------------------------------------------------------------------

function recargarFactura(id?: string) {
  revalidatePath('/compras/facturas');
  revalidatePath('/compras/cuentas-por-pagar');
  revalidatePath('/inventario/existencias');
  if (id) revalidatePath(`/compras/facturas/${id}`);
}

export async function crearFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const ordenId = texto(fd, 'orden_id');
    if (!UUID.test(ordenId)) return { error: 'Seleccione la orden de compra.' };
    id = await conUsuario(u.id, (tx) => crearFactura(tx, u, {
      ordenId, numeroFactura: texto(fd, 'numero_factura'), numeroControl: texto(fd, 'numero_control'),
      fechaFactura: texto(fd, 'fecha_factura'), fechaVencimiento: texto(fd, 'fecha_vencimiento') || undefined,
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargarFactura();
  redirect(`/compras/facturas/${id}`);
}

export async function guardarLineaFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    const ordenLineaId = texto(fd, 'orden_linea_id');
    if (!UUID.test(id) || !UUID.test(ordenLineaId)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => guardarLineaFactura(tx, id, { ordenLineaId, cantidad: texto(fd, 'cantidad'), precio: texto(fd, 'precio') }));
    recargarFactura(id);
    return { ok: 'Línea agregada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarLineaFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(id) || !UUID.test(linea)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => quitarLineaFactura(tx, id, linea));
    recargarFactura(id);
    return { ok: 'Línea quitada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura inválida.' };
    await conUsuario(u.id, (tx) => eliminarFacturaBorrador(tx, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargarFactura();
  redirect('/compras/facturas');
}

export async function registrarFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura inválida.' };
    const r = await conUsuario(u.id, (tx) => registrarFactura(tx, u, id));
    recargarFactura(id);
    return r.estado === 'contabilizada'
      ? { ok: `Factura registrada (${r.numero}) y contabilizada: ya figura en cuentas por pagar.` }
      : { ok: `Factura registrada (${r.numero}) pero retenida: ${r.motivo}. Gerencia debe revisarla antes de poder pagarla.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function aprobarFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'factura_compra', id, u.id, 'aprobada'));
    recargarFactura(id);
    return { ok: 'Factura aprobada y contabilizada: ya figura en cuentas por pagar.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'factura_compra', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargarFactura(id);
    return { ok: 'Factura rechazada. No se abrió cuenta por pagar.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------
// Gastos de importación
// ---------------------------------------------------------------------

function recargarGasto(id?: string) {
  revalidatePath('/compras/gastos');
  revalidatePath('/compras/cuentas-por-pagar');
  revalidatePath('/inventario/existencias');
  if (id) revalidatePath(`/compras/gastos/${id}`);
}

const datosGasto = (fd: FormData): DatosGasto => ({
  proveedorId: texto(fd, 'proveedor_id'),
  concepto: texto(fd, 'concepto'),
  descripcion: texto(fd, 'descripcion'),
  numeroFactura: texto(fd, 'numero_factura'),
  numeroControl: texto(fd, 'numero_control'),
  fechaFactura: texto(fd, 'fecha_factura'),
  fechaVencimiento: texto(fd, 'fecha_vencimiento') || undefined,
  moneda: texto(fd, 'moneda').toUpperCase(),
  criterioReparto: texto(fd, 'criterio_reparto') || undefined,
  base: texto(fd, 'base'),
  alicuotaIvaId: texto(fd, 'alicuota_iva_id'),
  recepcionIds: fd.getAll('recepcion_id').map(String).filter((v) => UUID.test(v)),
});

export async function crearGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    id = await conUsuario(u.id, (tx) => crearGasto(tx, u, datosGasto(fd)));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargarGasto();
  redirect(`/compras/gastos/${id}`);
}

export async function actualizarGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Gasto inválido.' };
    await conUsuario(u.id, (tx) => actualizarGasto(tx, id, datosGasto(fd)));
    recargarGasto(id);
    return { ok: 'Datos guardados. Revise el reparto antes de registrar.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Gasto inválido.' };
    await conUsuario(u.id, (tx) => eliminarGasto(tx, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargarGasto();
  redirect('/compras/gastos');
}

export async function registrarGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_FACTURA);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Gasto inválido.' };
    const r = await conUsuario(u.id, (tx) => registrarGasto(tx, u, id));
    recargarGasto(id);
    return { ok: `Gasto registrado (${r.numero}) y repartido entre los productos${Number(r.costoVentas) > 0 ? '; la parte que corresponde a mercancía ya vendida fue al costo de ventas' : ''}. Ya figura en cuentas por pagar.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
