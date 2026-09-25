'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { actualizarBanco, crearBanco, ROLES_ADMIN_BANCOS, type DatosBanco } from '@/lib/maestros/bancos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const leer = (fd: FormData): DatosBanco => ({ nombre: texto(fd, 'nombre'), pais: texto(fd, 'pais') });

export async function crearBancoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_ADMIN_BANCOS);
    id = await conUsuario(u.id, (tx) => crearBanco(tx, texto(fd, 'codigo'), leer(fd)));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/maestros/bancos');
  redirect(`/maestros/bancos/${id}`);
}

export async function actualizarBancoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_ADMIN_BANCOS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Banco inválido.' };
    await conUsuario(u.id, (tx) => actualizarBanco(tx, id, { ...leer(fd), activo: fd.get('activo') === 'on' }));
    revalidatePath('/maestros/bancos');
    revalidatePath(`/maestros/bancos/${id}`);
    return { ok: 'Banco actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
