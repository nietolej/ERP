'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ErrorConfirmable } from '@/lib/maestros/terceros';
import {
  TIPOS_VENDEDOR, actualizarVendedor, cambiarEstadoVendedor, crearVendedor, type DatosVendedor, type TipoVendedor,
} from '@/lib/maestros/vendedores';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMINISTRAN = ['gerencia', 'supervisor_ventas'] as const;

function leer(fd: FormData): DatosVendedor {
  const tipo = texto(fd, 'tipo');
  const id = (c: string) => (UUID.test(texto(fd, c)) ? texto(fd, c) : null);
  return {
    nombre: texto(fd, 'nombre'),
    tipo: ((TIPOS_VENDEDOR as readonly string[]).includes(tipo) ? tipo : '') as TipoVendedor,
    sucursalId: id('sucursal_id'),
    usuarioId: id('usuario_id'),
    rif: tipo === 'externo' ? texto(fd, 'rif') : undefined,
    confirmarNombreParecido: fd.get('confirmar_nombre') === 'on',
  };
}

const error = (e: unknown): EstadoAccion => ({ error: mensajeDeError(e), confirmar: e instanceof ErrorConfirmable });

export async function crearVendedorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ADMINISTRAN);
    await conUsuario(u.id, (tx) => crearVendedor(tx, u.id, leer(fd)));
  } catch (e) {
    return error(e);
  }
  revalidatePath('/maestros/vendedores');
  redirect('/maestros/vendedores');
}

export async function actualizarVendedorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ADMINISTRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Vendedor inválido.' };
    await conUsuario(u.id, (tx) => actualizarVendedor(tx, u.id, id, leer(fd)));
  } catch (e) {
    return error(e);
  }
  revalidatePath('/maestros/vendedores');
  redirect('/maestros/vendedores');
}

export async function cambiarEstadoVendedorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ADMINISTRAN);
    const id = texto(fd, 'id');
    const estado = texto(fd, 'estado');
    if (!UUID.test(id)) return { error: 'Vendedor inválido.' };
    await conUsuario(u.id, (tx) => cambiarEstadoVendedor(tx, id, estado as 'activo' | 'inactivo'));
    revalidatePath('/maestros/vendedores');
    revalidatePath(`/maestros/vendedores/${id}`);
    return { ok: estado === 'activo' ? 'Vendedor reactivado.' : 'Vendedor inactivado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
