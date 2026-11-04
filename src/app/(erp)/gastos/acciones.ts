'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import {
  actualizarCategoria, cambiarEstadoCategoria, crearCategoria, crearGastoProveedor, ROLES_CATEGORIAS, ROLES_REGISTRAN_GASTO,
} from '@/lib/gastos/gastos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id?: string) {
  revalidatePath('/gastos');
  revalidatePath('/compras/cuentas-por-pagar');
  if (id) revalidatePath(`/gastos/${id}`);
}

export async function crearGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_REGISTRAN_GASTO);
    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Adjunte el soporte de la factura (PDF, PNG, JPG o WebP).' };
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const r = await conUsuario(u.id, (tx) => crearGastoProveedor(tx, u, {
      proveedorId: texto(fd, 'proveedor_id'), categoriaId: texto(fd, 'categoria_id'), descripcion: texto(fd, 'descripcion'),
      numeroFactura: texto(fd, 'numero_factura'), numeroControl: texto(fd, 'numero_control'), fechaFactura: texto(fd, 'fecha_factura'),
      fechaVencimiento: texto(fd, 'fecha_vencimiento') || undefined, moneda: texto(fd, 'moneda'), base: texto(fd, 'base'),
      alicuotaIvaId: texto(fd, 'alicuota_iva_id'), retencionIvaTotal: texto(fd, 'retencion_iva_total') === '1',
    }, { almacen: almacenEnDisco(), nombre: archivo.name, bytes }));
    id = r.id;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/gastos/${id}`);
}

export async function aprobarGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura de gasto inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'gasto_proveedor', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Gasto aprobado y contabilizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarGastoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura de gasto inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'gasto_proveedor', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Gasto rechazado. No se movió nada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------

export async function crearCategoriaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CATEGORIAS);
    await conUsuario(u.id, (tx) => crearCategoria(tx, u, {
      codigo: texto(fd, 'codigo'), nombre: texto(fd, 'nombre'), cuentaId: texto(fd, 'cuenta_id'),
      centroCostoId: texto(fd, 'centro_costo_id') || undefined, ivaDeducible: texto(fd, 'iva_deducible') === '1',
    }));
    revalidatePath('/gastos/categorias');
    return { ok: 'Categoría creada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarCategoriaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CATEGORIAS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Categoría inválida.' };
    await conUsuario(u.id, (tx) => actualizarCategoria(tx, u, id, {
      nombre: texto(fd, 'nombre'), cuentaId: texto(fd, 'cuenta_id'), centroCostoId: texto(fd, 'centro_costo_id') || undefined, ivaDeducible: texto(fd, 'iva_deducible') === '1',
    }));
    revalidatePath('/gastos/categorias');
    return { ok: 'Categoría actualizada. Aplica a los gastos que se registren desde ahora.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function estadoCategoriaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CATEGORIAS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Categoría inválida.' };
    await conUsuario(u.id, (tx) => cambiarEstadoCategoria(tx, u, id, texto(fd, 'activa') === '1'));
    revalidatePath('/gastos/categorias');
    return { ok: 'Categoría actualizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
