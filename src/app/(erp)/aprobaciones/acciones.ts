'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { crearDelegacion, quitarDelegacion } from '@/lib/flujo/flujo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cada usuario delega solo sus propias aprobaciones. */
export async function crearDelegacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const sustituto = texto(fd, 'sustituto_id');
    await conUsuario(u.id, (tx) => crearDelegacion(tx, u.id, UUID.test(sustituto) ? sustituto : '', texto(fd, 'desde'), texto(fd, 'hasta')));
    revalidatePath('/aprobaciones');
    return { ok: 'Delegación registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarDelegacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Delegación inválida.' };
    await conUsuario(u.id, (tx) => quitarDelegacion(tx, u.id, id));
    revalidatePath('/aprobaciones');
    return { ok: 'Delegación retirada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
