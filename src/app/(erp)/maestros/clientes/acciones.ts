'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { conUsuario, getDb } from '@/lib/db';
import {
  ErrorConfirmable, ROLES_VEN_CLIENTES, actualizarCredito, actualizarDatosCliente, buscarClientes,
  cambiarEstadoCliente, crearCliente, type DatosCredito, type DatosTercero, type FilaCliente,
} from '@/lib/maestros/clientes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOpcional = (fd: FormData, campo: string) => {
  const v = texto(fd, campo);
  return UUID.test(v) ? v : null;
};

function leerTercero(fd: FormData): DatosTercero {
  return {
    razonSocial: texto(fd, 'razon_social'),
    nombreComercial: texto(fd, 'nombre_comercial'),
    domiciliado: fd.get('domiciliado') === 'on',
    contribuyenteEspecial: fd.get('contribuyente_especial') === 'on',
    agenteRetencionIva: fd.get('agente_retencion_iva') === 'on',
    direccionFiscal: texto(fd, 'direccion_fiscal'),
    telefono: texto(fd, 'telefono'),
    email: texto(fd, 'email'),
  };
}

function leerCredito(fd: FormData): DatosCredito {
  const nivel = texto(fd, 'nivel_precio');
  return {
    condicionPagoId: idOpcional(fd, 'condicion_pago_id') ?? '',
    limiteCreditoUsd: texto(fd, 'limite_credito_usd'),
    nivelPrecio: (['A', 'B', 'D'].includes(nivel) ? nivel : '') as DatosCredito['nivelPrecio'],
    descuentoPct: texto(fd, 'descuento_pct') || '0',
  };
}

const comercial = (fd: FormData) => ({
  sucursalId: idOpcional(fd, 'sucursal_id'),
  vendedorId: idOpcional(fd, 'vendedor_id'),
  zona: texto(fd, 'zona'),
});

function errorDeFormulario(e: unknown): EstadoAccion {
  return { error: mensajeDeError(e), confirmar: e instanceof ErrorConfirmable };
}

export async function crearClienteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar('facturacion');
    ({ id } = await conUsuario(u.id, (tx) => crearCliente(tx, u.id, {
      rif: texto(fd, 'rif'), tercero: leerTercero(fd), comercial: comercial(fd),
      confirmarNombreParecido: fd.get('confirmar_nombre') === 'on',
    })));
  } catch (e) {
    return errorDeFormulario(e);
  }
  revalidatePath('/maestros/clientes');
  redirect(`/maestros/clientes/${id}`);
}

export async function actualizarClienteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  const id = texto(fd, 'id');
  try {
    const u = await autorizar('facturacion', 'gerencia');
    if (!UUID.test(id)) return { error: 'Cliente inválido.' };
    await conUsuario(u.id, (tx) => actualizarDatosCliente(tx, id, {
      tercero: leerTercero(fd), comercial: comercial(fd),
      confirmarNombreParecido: fd.get('confirmar_nombre') === 'on',
    }));
  } catch (e) {
    return errorDeFormulario(e);
  }
  revalidatePath('/maestros/clientes');
  redirect(`/maestros/clientes/${id}`);
}

export async function aprobarClienteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién puede aprobar lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Cliente inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'cliente', id, u.id, 'aprobada', { datos: { ...leerCredito(fd) } }));
    revalidatePath('/maestros/clientes');
    revalidatePath(`/maestros/clientes/${id}`);
    return { ok: 'Cliente aprobado: ya está activo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarCreditoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Cliente inválido.' };
    await conUsuario(u.id, (tx) => actualizarCredito(tx, id, leerCredito(fd)));
    revalidatePath(`/maestros/clientes/${id}`);
    return { ok: 'Condiciones de crédito actualizadas.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cambiarEstadoClienteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    const estado = texto(fd, 'estado') as 'activo' | 'inactivo' | 'bloqueado';
    if (!UUID.test(id)) return { error: 'Cliente inválido.' };
    await conUsuario(u.id, (tx) => cambiarEstadoCliente(tx, id, estado));
    revalidatePath('/maestros/clientes');
    revalidatePath(`/maestros/clientes/${id}`);
    return { ok: `Cliente ${estado}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** Búsqueda desde la lista. Va por acción de servidor para no poner RIF ni nombres en la URL (AGENTS.md §6). */
export async function buscarClientesAccion(
  textoBuscado: string, estado: string,
): Promise<{ filas: FilaCliente[] } | { error: string }> {
  try {
    const u = await autorizar(...ROLES_VEN_CLIENTES);
    const e = ['pendiente', 'activo', 'inactivo', 'bloqueado'].includes(estado) ? estado : '';
    return { filas: await buscarClientes(await getDb(), u, { texto: String(textoBuscado).slice(0, 100), estado: e }) };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
