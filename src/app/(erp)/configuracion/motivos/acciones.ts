'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ROLES_MOTIVOS, cambiarEstadoMotivo, crearMotivo } from '@/lib/maestros/motivos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function crearMotivoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_MOTIVOS);
    await conUsuario(u.id, (tx) => crearMotivo(tx, texto(fd, 'tipo'), texto(fd, 'codigo'), texto(fd, 'nombre')));
    revalidatePath('/configuracion/motivos');
    return { ok: 'Motivo agregado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cambiarEstadoMotivoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_MOTIVOS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Motivo inválido.' };
    const activo = texto(fd, 'activo') === 'true';
    await conUsuario(u.id, (tx) => cambiarEstadoMotivo(tx, id, activo));
    revalidatePath('/configuracion/motivos');
    return { ok: activo ? 'Motivo reactivado.' : 'Motivo inactivado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
