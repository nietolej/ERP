'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario, getDb } from '@/lib/db';
import {
  ROLES_VEN_PROVEEDORES, TIPOS_PROVEEDOR, actualizarContacto, aprobarCambio, aprobarProveedor, buscarProveedores,
  cambiarCondicionProveedor, cambiarEstadoProveedor, corregirPendiente, crearProveedor, rechazarCambio, solicitarCambio,
  type DatosContacto, type DatosSensibles, type FilaProveedor, type TipoProveedor,
} from '@/lib/maestros/proveedores';
import { ErrorConfirmable } from '@/lib/maestros/terceros';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (fd: FormData, c: string) => (UUID.test(texto(fd, c)) ? texto(fd, c) : null);

function sensibles(fd: FormData): DatosSensibles {
  const tipo = texto(fd, 'tipo');
  return {
    razonSocial: texto(fd, 'razon_social'),
    domiciliado: fd.get('domiciliado') === 'on',
    contribuyenteEspecial: fd.get('contribuyente_especial') === 'on',
    agenteRetencionIva: fd.get('agente_retencion_iva') === 'on',
    tipo: ((TIPOS_PROVEEDOR as readonly string[]).includes(tipo) ? tipo : '') as TipoProveedor,
    pais: texto(fd, 'pais').toUpperCase(),
    conceptoIslrId: uuid(fd, 'concepto_islr_id'),
  };
}

const contacto = (fd: FormData): DatosContacto => ({
  nombreComercial: texto(fd, 'nombre_comercial'),
  direccionFiscal: texto(fd, 'direccion_fiscal'),
  telefono: texto(fd, 'telefono'),
  email: texto(fd, 'email'),
});

const error = (e: unknown): EstadoAccion => ({ error: mensajeDeError(e), confirmar: e instanceof ErrorConfirmable });
const confirmado = (fd: FormData) => fd.get('confirmar_nombre') === 'on';

function refrescar(id?: string) {
  revalidatePath('/maestros/proveedores');
  if (id) revalidatePath(`/maestros/proveedores/${id}`);
}

export async function crearProveedorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar('compras');
    ({ id } = await conUsuario(u.id, (tx) => crearProveedor(tx, u.id, {
      rif: texto(fd, 'rif'), sensibles: sensibles(fd), contacto: contacto(fd), confirmarNombreParecido: confirmado(fd),
    })));
  } catch (e) {
    return error(e);
  }
  refrescar();
  redirect(`/maestros/proveedores/${id}`);
}

export async function corregirPendienteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('compras');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Proveedor inválido.' };
    await conUsuario(u.id, (tx) => corregirPendiente(tx, id, {
      sensibles: sensibles(fd), contacto: contacto(fd), confirmarNombreParecido: confirmado(fd),
    }));
    refrescar(id);
    return { ok: 'Datos corregidos.' };
  } catch (e) {
    return error(e);
  }
}

export async function actualizarContactoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('compras');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Proveedor inválido.' };
    await conUsuario(u.id, (tx) => actualizarContacto(tx, id, contacto(fd)));
    refrescar(id);
    return { ok: 'Datos de contacto actualizados.' };
  } catch (e) {
    return error(e);
  }
}

export async function solicitarCambioAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('compras', 'gerencia');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Proveedor inválido.' };
    await conUsuario(u.id, (tx) => solicitarCambio(tx, id, u.id, sensibles(fd)));
    refrescar(id);
    return { ok: 'Solicitud de cambio registrada: queda pendiente de aprobación de Gerencia.' };
  } catch (e) {
    return error(e);
  }
}

export async function aprobarProveedorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Proveedor inválido.' };
    await conUsuario(u.id, (tx) => aprobarProveedor(tx, id, u.id, uuid(fd, 'condicion_pago_id') ?? ''));
    refrescar(id);
    return { ok: 'Proveedor aprobado: ya está activo.' };
  } catch (e) {
    return error(e);
  }
}

export async function cambiarCondicionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Proveedor inválido.' };
    await conUsuario(u.id, (tx) => cambiarCondicionProveedor(tx, id, uuid(fd, 'condicion_pago_id') ?? ''));
    refrescar(id);
    return { ok: 'Condición de pago actualizada.' };
  } catch (e) {
    return error(e);
  }
}

export async function cambiarEstadoProveedorAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = uuid(fd, 'id');
    if (!id) return { error: 'Proveedor inválido.' };
    const estado = texto(fd, 'estado') as 'activo' | 'inactivo' | 'bloqueado';
    await conUsuario(u.id, (tx) => cambiarEstadoProveedor(tx, id, estado));
    refrescar(id);
    return { ok: `Proveedor ${estado}.` };
  } catch (e) {
    return error(e);
  }
}

export async function resolverCambioAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = uuid(fd, 'id');
    const cambio = uuid(fd, 'cambio_id');
    if (!id || !cambio) return { error: 'Solicitud inválida.' };
    const decision = texto(fd, 'decision');
    await conUsuario(u.id, (tx) => decision === 'aprobar'
      ? aprobarCambio(tx, cambio, u.id)
      : rechazarCambio(tx, cambio, u.id, texto(fd, 'motivo')));
    refrescar(id);
    return { ok: decision === 'aprobar' ? 'Cambio aprobado y aplicado.' : 'Cambio rechazado.' };
  } catch (e) {
    return error(e);
  }
}

/** Búsqueda desde la lista, por acción de servidor para no poner RIF ni nombres en la URL. */
export async function buscarProveedoresAccion(
  textoBuscado: string, estado: string,
): Promise<{ filas: FilaProveedor[] } | { error: string }> {
  try {
    await autorizar(...ROLES_VEN_PROVEEDORES);
    const e = ['pendiente', 'activo', 'inactivo', 'bloqueado'].includes(estado) ? estado : '';
    return { filas: await buscarProveedores(await getDb(), { texto: String(textoBuscado).slice(0, 100), estado: e }) };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
