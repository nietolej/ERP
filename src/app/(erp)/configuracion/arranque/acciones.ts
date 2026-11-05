'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizarSesion } from '@/lib/auth/dal';
import { ROLES_CONFIRMAN, confirmar, retirarConfirmacion, type CodigoConfirmacion } from '@/lib/apertura/checklist';
import { conUsuario } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function confirmarAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const codigo = texto(fd, 'codigo') as CodigoConfirmacion;
    if (!(codigo in ROLES_CONFIRMAN)) return { error: 'Confirmación desconocida.' };
    await conUsuario(u.id, (tx) => confirmar(tx, u, codigo, texto(fd, 'nota')));
    revalidatePath('/configuracion/arranque');
    return { ok: 'Confirmación registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function retirarAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Confirmación inválida.' };
    await conUsuario(u.id, (tx) => retirarConfirmacion(tx, u, id, texto(fd, 'motivo')));
    revalidatePath('/configuracion/arranque');
    return { ok: 'Confirmación retirada. Si había firmas, también se retiraron.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
