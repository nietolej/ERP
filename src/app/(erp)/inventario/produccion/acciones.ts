'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import {
  ROLES_PRODUCEN, actualizarOrden, anularOrden, crearOrden, eliminarBorrador, enviarOrden, guardarComponente, iniciarOrden, quitarComponente, terminarOrden,
} from '@/lib/produccion/ordenes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id?: string) {
  revalidatePath('/inventario/produccion');
  revalidatePath('/inventario/existencias');
  if (id) revalidatePath(`/inventario/produccion/${id}`);
}

export async function crearOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_PRODUCEN);
    const r = await conUsuario(u.id, (tx) => crearOrden(tx, u, {
      productoId: texto(fd, 'producto_id'), cantidad: texto(fd, 'cantidad'), almacenId: texto(fd, 'almacen_id'), observaciones: texto(fd, 'observaciones'),
    }));
    id = r.id;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/inventario/produccion/${id}`);
}

type Operacion = (tx: Parameters<Parameters<typeof conUsuario<unknown>>[1]>[0], u: Awaited<ReturnType<typeof autorizar>>, id: string, fd: FormData) => Promise<unknown>;

/** Acciones de una orden existente: validan el id, ejecutan y recargan. */
function sobreOrden(operacion: Operacion, ok: string) {
  return async (_: EstadoAccion, fd: FormData): Promise<EstadoAccion> => {
    try {
      const u = await autorizar(...ROLES_PRODUCEN);
      const id = texto(fd, 'id');
      if (!UUID.test(id)) return { error: 'Orden inválida.' };
      await conUsuario(u.id, (tx) => operacion(tx, u, id, fd));
      recargar(id);
      return { ok };
    } catch (e) {
      return { error: mensajeDeError(e) };
    }
  };
}

export const actualizarOrdenAccion = sobreOrden((tx, u, id, fd) => actualizarOrden(tx, u, id, {
  productoId: texto(fd, 'producto_id'), cantidad: texto(fd, 'cantidad'), almacenId: texto(fd, 'almacen_id'), observaciones: texto(fd, 'observaciones'),
}), 'Orden actualizada.');
export const guardarComponenteAccion = sobreOrden((tx, u, id, fd) => guardarComponente(tx, u, id, { productoId: texto(fd, 'producto_id'), cantidad: texto(fd, 'cantidad') }), 'Componente guardado.');
export const quitarComponenteAccion = sobreOrden((tx, u, id, fd) => quitarComponente(tx, u, id, texto(fd, 'componente_id')), 'Componente quitado.');
export const enviarOrdenAccion = sobreOrden((tx, u, id) => enviarOrden(tx, u, id), 'Orden enviada a Gerencia.');
export const iniciarOrdenAccion = sobreOrden((tx, u, id) => iniciarOrden(tx, u, id), 'Orden en proceso.');
export const anularOrdenAccion = sobreOrden((tx, u, id, fd) => anularOrden(tx, u, id, texto(fd, 'motivo')), 'Orden anulada.');

export async function terminarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PRODUCEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    const r = await conUsuario(u.id, (tx) => terminarOrden(tx, u, id));
    recargar(id);
    return { ok: `Orden terminada. El producto entró al costo de US$ ${r.costoUnitarioUsd} por unidad (US$ ${r.costoTotalUsd} en total).` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarBorradorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PRODUCEN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => eliminarBorrador(tx, u, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect('/inventario/produccion');
}

export async function aprobarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién libera lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'orden_produccion', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Orden liberada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'orden_produccion', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Orden rechazada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
