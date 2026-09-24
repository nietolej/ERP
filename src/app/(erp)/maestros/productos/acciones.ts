'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario, getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import {
  ROLES_PRECIOS, ROLES_VEN_PRODUCTOS, actualizarProducto, agregarReferencia, buscarProductos, cambiarEstadoProducto,
  crearCatalogo, crearProducto, fijarPrecio, quitarReferencia, type DatosProducto, type FilaProducto,
} from '@/lib/maestros/productos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (fd: FormData, c: string) => (UUID.test(texto(fd, c)) ? texto(fd, c) : null);

function leer(fd: FormData): DatosProducto {
  return {
    descripcion: texto(fd, 'descripcion'),
    grupoId: uuid(fd, 'grupo_id'),
    marcaId: uuid(fd, 'marca_id'),
    familia: texto(fd, 'familia'),
    unidad: texto(fd, 'unidad'),
    alicuotaIvaId: uuid(fd, 'alicuota_iva_id') ?? '',
    inventariable: fd.get('inventariable') === 'on',
    codigoAlterno: texto(fd, 'codigo_alterno'),
    pesoKg: texto(fd, 'peso_kg'),
  };
}

function refrescar(id?: string) {
  revalidatePath('/maestros/productos');
  if (id) revalidatePath(`/maestros/productos/${id}`);
}

export async function crearProductoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar('almacen');
    id = await conUsuario(u.id, (tx) => crearProducto(tx, u.id, texto(fd, 'codigo'), leer(fd)));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  refrescar();
  redirect(`/maestros/productos/${id}`);
}

export async function actualizarProductoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Producto inválido.' };
    await conUsuario(u.id, (tx) => actualizarProducto(tx, id, leer(fd)));
    refrescar(id);
    return { ok: 'Producto actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cambiarEstadoProductoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Producto inválido.' };
    const estado = texto(fd, 'estado') as 'activo' | 'inactivo';
    await conUsuario(u.id, (tx) => cambiarEstadoProducto(tx, id, estado));
    refrescar(id);
    return { ok: estado === 'activo' ? 'Producto reactivado.' : 'Producto inactivado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function agregarReferenciaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Producto inválido.' };
    await conUsuario(u.id, (tx) => agregarReferencia(tx, id, {
      tipo: texto(fd, 'tipo') as 'oem' | 'alterna', fabricante: texto(fd, 'fabricante'), referencia: texto(fd, 'referencia'),
    }));
    refrescar(id);
    return { ok: 'Referencia agregada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarReferenciaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'id');
    const ref = uuid(fd, 'referencia_id');
    if (!id || !ref) return { error: 'Referencia inválida.' };
    await conUsuario(u.id, (tx) => quitarReferencia(tx, id, ref));
    refrescar(id);
    return { ok: 'Referencia eliminada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function fijarPrecioAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PRECIOS);
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Producto inválido.' };
    const lista = texto(fd, 'lista');
    await conUsuario(u.id, (tx) => fijarPrecio(tx, id, lista, texto(fd, 'precio'), texto(fd, 'vigente_desde')));
    refrescar(id);
    return { ok: `Precio de la lista ${lista} registrado.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function crearCatalogoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const tabla = texto(fd, 'tabla') === 'marca' ? 'marca' : 'grupo_producto';
    await conUsuario(u.id, (tx) => crearCatalogo(tx, tabla, texto(fd, 'codigo'), texto(fd, 'nombre')));
    revalidatePath('/maestros/productos/catalogos');
    return { ok: tabla === 'marca' ? 'Marca registrada.' : 'Grupo registrado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function buscarProductosAccion(
  textoBuscado: string, estado: string,
): Promise<{ filas: FilaProducto[] } | { error: string }> {
  try {
    await autorizar(...ROLES_VEN_PRODUCTOS);
    const e = estado === 'activo' || estado === 'inactivo' ? estado : '';
    return { filas: await buscarProductos(await getDb(), { texto: String(textoBuscado).slice(0, 60), estado: e }, hoyCaracas()) };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
