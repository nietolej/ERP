'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario, getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import type { Db } from '@/lib/db/tipos';
import {
  ROLES_PRECIOS, ROLES_VEN_PRODUCTOS, actualizarProducto, actualizarProductoBase, agregarAplicacion, agregarReferencia,
  buscarProductos, cambiarEstadoProducto, crearCatalogo, crearCategoria, crearProducto, fijarPrecio, quitarAplicacion,
  quitarReferencia, resolverProductoBase, type DatosProducto, type FilaProducto,
} from '@/lib/maestros/productos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (fd: FormData, c: string) => (UUID.test(texto(fd, c)) ? texto(fd, c) : null);

/** Lee el producto y resuelve su código común (lo crea si es nuevo, con su descripción genérica y categoría). */
async function leer(tx: Db, fd: FormData): Promise<DatosProducto> {
  const base = await resolverProductoBase(tx, texto(fd, 'codigo_comun'), {
    descripcion: texto(fd, 'base_descripcion'), categoriaId: uuid(fd, 'base_categoria_id'),
  });
  return {
    descripcion: texto(fd, 'descripcion'),
    productoBaseId: base.id,
    grupoId: uuid(fd, 'grupo_id'),
    marcaId: uuid(fd, 'marca_id'),
    unidad: texto(fd, 'unidad'),
    alicuotaIvaId: uuid(fd, 'alicuota_iva_id') ?? '',
    inventariable: fd.get('inventariable') === 'on',
    codigoAlterno: texto(fd, 'codigo_alterno'),
    pesoKg: texto(fd, 'peso_kg'),
    lineaCalidad: texto(fd, 'linea_calidad') || null,
    paisOrigen: texto(fd, 'pais_origen').toUpperCase() || null,
    empaqueUnidad: texto(fd, 'empaque_unidad'),
    unidadesPorEmpaque: texto(fd, 'unidades_por_empaque'),
    empaquePesoKg: texto(fd, 'empaque_peso_kg'),
    empaqueLargoCm: texto(fd, 'empaque_largo_cm'),
    empaqueAnchoCm: texto(fd, 'empaque_ancho_cm'),
    empaqueAltoCm: texto(fd, 'empaque_alto_cm'),
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
    id = await conUsuario(u.id, async (tx) => crearProducto(tx, u.id, texto(fd, 'codigo'), await leer(tx, fd)));
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
    await conUsuario(u.id, async (tx) => actualizarProducto(tx, id, await leer(tx, fd)));
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

export async function crearCategoriaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    await conUsuario(u.id, (tx) => crearCategoria(tx, texto(fd, 'codigo'), texto(fd, 'nombre'), uuid(fd, 'padre_id')));
    revalidatePath('/maestros/productos/catalogos');
    return { ok: 'Categoría registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarProductoBaseAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'base_id');
    if (!id) return { error: 'Código común inválido.' };
    await conUsuario(u.id, (tx) => actualizarProductoBase(tx, id, { descripcion: texto(fd, 'descripcion'), categoriaId: uuid(fd, 'categoria_id') }));
    revalidatePath(`/maestros/productos/comun/${id}`);
    revalidatePath('/maestros/productos');
    return { ok: 'Código común actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function agregarAplicacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'base_id');
    if (!id) return { error: 'Código común inválido.' };
    await conUsuario(u.id, (tx) => agregarAplicacion(tx, id, {
      grupoId: uuid(fd, 'grupo_id') ?? '', anioDesde: texto(fd, 'anio_desde'), anioHasta: texto(fd, 'anio_hasta'), motor: texto(fd, 'motor'),
    }));
    revalidatePath(`/maestros/productos/comun/${id}`);
    return { ok: 'Aplicación agregada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarAplicacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('almacen');
    const id = uuid(fd, 'base_id');
    const apl = uuid(fd, 'aplicacion_id');
    if (!id || !apl) return { error: 'Aplicación inválida.' };
    await conUsuario(u.id, (tx) => quitarAplicacion(tx, id, apl));
    revalidatePath(`/maestros/productos/comun/${id}`);
    return { ok: 'Aplicación eliminada.' };
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
