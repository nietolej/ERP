'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ROLES_PARAMETROS, actualizarParametro } from '@/lib/maestros/parametros-reportes';

export async function actualizarParametroAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PARAMETROS);
    const codigo = texto(fd, 'codigo');
    await conUsuario(u.id, (tx) => actualizarParametro(tx, texto(fd, 'tabla'), codigo, texto(fd, 'valor')));
    revalidatePath('/configuracion/parametros-reportes');
    revalidatePath('/reportes', 'layout');
    return { ok: `${codigo} actualizado.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
