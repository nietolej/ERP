'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { actualizarAlmacen, asignarUsuarios, crearAlmacen, type DatosAlmacen } from '@/lib/maestros/almacenes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const leer = (fd: FormData): DatosAlmacen => ({
  nombre: texto(fd, 'nombre'),
  sucursalId: UUID.test(texto(fd, 'sucursal_id')) ? texto(fd, 'sucursal_id') : '',
  esComercial: fd.get('es_comercial') === 'on',
  permiteVenta: fd.get('permite_venta') === 'on',
});

export async function crearAlmacenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar('gerencia');
    id = await conUsuario(u.id, (tx) => crearAlmacen(tx, texto(fd, 'codigo'), leer(fd)));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/maestros/almacenes');
  redirect(`/maestros/almacenes/${id}`);
}

export async function actualizarAlmacenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Almacén inválido.' };
    await conUsuario(u.id, (tx) => actualizarAlmacen(tx, id, { ...leer(fd), activo: fd.get('activo') === 'on' }));
    revalidatePath('/maestros/almacenes');
    revalidatePath(`/maestros/almacenes/${id}`);
    return { ok: 'Almacén actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function asignarUsuariosAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Almacén inválido.' };
    const usuarios = fd.getAll('usuarios').map(String).filter((v) => UUID.test(v));
    await conUsuario(u.id, (tx) => asignarUsuarios(tx, id, usuarios));
    revalidatePath(`/maestros/almacenes/${id}`);
    return { ok: 'Usuarios asignados.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
