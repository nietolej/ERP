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
