'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import {
  ROLES_VENDEN, agregarLinea, anularNotaEntrega, anularPedido, cambiarLinea, crearPedido, eliminarBorrador, emitirPedido,
  generarNotaEntrega, productoPorCodigo, quitarLinea, reservarExistencia,
} from '@/lib/ventas/pedidos';
import { registrarVentaPerdida } from '@/lib/ventas/perdidas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id: string) {
  revalidatePath('/ventas/pedidos');
  revalidatePath(`/ventas/pedidos/${id}`);
  revalidatePath('/ventas/notas-entrega');
}

export async function crearPedidoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const clienteId = texto(fd, 'cliente_id');
    const almacenId = texto(fd, 'almacen_id');
    if (!UUID.test(clienteId)) return { error: 'Seleccione el cliente.' };
    if (!UUID.test(almacenId)) return { error: 'Seleccione el almacén.' };
    id = await conUsuario(u.id, (tx) => crearPedido(tx, u, { clienteId, almacenId, observaciones: texto(fd, 'observaciones') }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/ventas/pedidos');
  redirect(`/ventas/pedidos/${id}`);
}

export async function agregarLineaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    await conUsuario(u.id, async (tx) => {
      const productoId = await productoPorCodigo(tx, texto(fd, 'codigo'));
      await agregarLinea(tx, u, id, { productoId, cantidad: texto(fd, 'cantidad'), descuentoPct: texto(fd, 'descuento'), motivoDescuentoId: texto(fd, 'motivo_descuento_id') || undefined });
    });
    recargar(id);
    return { ok: 'Producto agregado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cambiarLineaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(id) || !UUID.test(linea)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => cambiarLinea(tx, u, id, linea, { cantidad: texto(fd, 'cantidad'), descuentoPct: texto(fd, 'descuento'), motivoDescuentoId: texto(fd, 'motivo_descuento_id') || undefined }));
    recargar(id);
    return { ok: 'Línea actualizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarLineaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(id) || !UUID.test(linea)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => quitarLinea(tx, u, id, linea));
    recargar(id);
    return { ok: 'Producto quitado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarBorradorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    await conUsuario(u.id, (tx) => eliminarBorrador(tx, u, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/ventas/pedidos');
  redirect('/ventas/pedidos');
}

export async function emitirPedidoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    const r = await conUsuario(u.id, (tx) => emitirPedido(tx, u, id));
    recargar(id);
    return { ok: r.situacion === 'aprobado' ? 'Pedido emitido y aprobado.' : `Pedido emitido y retenido por crédito. ${r.motivo ?? ''} Gerencia debe aprobarlo.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularPedidoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    await conUsuario(u.id, (tx) => anularPedido(tx, u, id, { motivoId: texto(fd, 'motivo_id'), detalle: texto(fd, 'detalle') }));
    recargar(id);
    return { ok: 'Pedido anulado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function reservarAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    const r = await conUsuario(u.id, (tx) => reservarExistencia(tx, id, { registrarDemanda: false }));
    recargar(id);
    return { ok: r.faltante > 0 ? `Se reservó lo disponible. Todavía faltan ${r.faltante} unidades por falta de existencia.` : 'Se reservó todo lo pendiente del pedido.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function generarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let notaId: string;
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    notaId = await conUsuario(u.id, (tx) => generarNotaEntrega(tx, u, id));
    recargar(id);
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  redirect(`/ventas/notas-entrega/${notaId}`);
}

export async function anularNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Nota inválida.' };
    await conUsuario(u.id, (tx) => anularNotaEntrega(tx, u, id, { motivoId: texto(fd, 'motivo_id'), detalle: texto(fd, 'detalle') }));
    revalidatePath('/ventas/notas-entrega');
    revalidatePath(`/ventas/notas-entrega/${id}`);
    revalidatePath('/ventas/pedidos');
    return { ok: 'Nota de entrega anulada. La mercancía vuelve a estar reservada para el pedido.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function aprobarCreditoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'pedido_credito', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Pedido aprobado. Se reservó la existencia disponible.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarCreditoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pedido inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'pedido_credito', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Pedido rechazado y anulado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function registrarVentaPerdidaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_VENDEN);
    const clienteId = texto(fd, 'cliente_id');
    const almacenId = texto(fd, 'almacen_id');
    const motivoId = texto(fd, 'motivo_id');
    if (!UUID.test(clienteId)) return { error: 'Seleccione el cliente.' };
    if (!UUID.test(almacenId)) return { error: 'Seleccione el almacén.' };
    if (!UUID.test(motivoId)) return { error: 'Seleccione el motivo.' };
    await conUsuario(u.id, async (tx) => {
      const productoId = await productoPorCodigo(tx, texto(fd, 'codigo'));
      await registrarVentaPerdida(tx, u, { clienteId, productoId, almacenId, cantidad: texto(fd, 'cantidad'), motivoId, observacion: texto(fd, 'observacion') });
    });
    revalidatePath('/ventas/perdidas');
    return { ok: 'Venta perdida registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
