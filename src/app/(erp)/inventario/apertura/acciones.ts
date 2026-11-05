'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { ROLES_CUENTAN, ROLES_FIJAN_COSTO, crearConteo, eliminarConteo, enviarConteo, fijarCostos, guardarLineaConteo, quitarLineaConteo } from '@/lib/apertura/inventario';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id?: string) {
  revalidatePath('/inventario/apertura');
  revalidatePath('/configuracion/apertura');
  revalidatePath('/inventario/existencias');
  if (id) revalidatePath(`/inventario/apertura/${id}`);
}

export async function crearConteoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_CUENTAN);
    const r = await conUsuario(u.id, (tx) => crearConteo(tx, u, { almacenId: texto(fd, 'almacen_id'), observaciones: texto(fd, 'observaciones') }));
    id = r.id;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/inventario/apertura/${id}`);
}

export async function guardarLineaConteoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CUENTAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Conteo inválido.' };
    await conUsuario(u.id, (tx) => guardarLineaConteo(tx, u, id, { productoId: texto(fd, 'producto_id'), cantidad: texto(fd, 'cantidad') }));
    recargar(id);
    return { ok: 'Línea guardada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarLineaConteoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CUENTAN);
    const id = texto(fd, 'id');
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(id) || !UUID.test(linea)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => quitarLineaConteo(tx, u, id, linea));
    recargar(id);
    return { ok: 'Línea quitada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** El formulario trae un campo `costo_<lineaId>` por línea; las vacías no se tocan. */
export async function fijarCostosAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_FIJAN_COSTO);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Conteo inválido.' };
    const costos: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('costo_') && UUID.test(k.slice(6))) costos[k.slice(6)] = String(v);
    const n = await conUsuario(u.id, (tx) => fijarCostos(tx, u, id, costos));
    recargar(id);
    return { ok: `${n} costos guardados.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function enviarConteoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CUENTAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Conteo inválido.' };
    await conUsuario(u.id, (tx) => enviarConteo(tx, u, id));
    recargar(id);
    return { ok: 'Conteo enviado a Gerencia.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarConteoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CUENTAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Conteo inválido.' };
    await conUsuario(u.id, (tx) => eliminarConteo(tx, u, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect('/inventario/apertura');
}

export async function decidirConteoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Conteo inválido.' };
    const aprobar = texto(fd, 'decision') === 'aprobar';
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'apertura_inventario', id, u.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? {} : { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: aprobar ? 'Conteo aprobado: el inventario inicial quedó registrado y contabilizado.' : 'Conteo rechazado. No se movió nada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
