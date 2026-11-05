'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import {
  ROLES_APERTURA_BANCO, ROLES_APERTURA_CXC, ROLES_APERTURA_CXP, cerrarApertura, fijarFechaArranque, registrarBanco, registrarCxc, registrarCxp,
} from '@/lib/apertura/apertura';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar() {
  revalidatePath('/configuracion/apertura');
  revalidatePath('/compras/cuentas-por-pagar');
  revalidatePath('/tesoreria/cuentas');
  revalidatePath('/cobranzas/cuentas');
}

export async function fijarFechaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    await conUsuario(u.id, (tx) => fijarFechaArranque(tx, u, texto(fd, 'fecha')));
    recargar();
    return { ok: 'Fecha de arranque fijada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function registrarBancoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_APERTURA_BANCO);
    const r = await conUsuario(u.id, (tx) => registrarBanco(tx, u, { cuentaBancariaId: texto(fd, 'cuenta_bancaria_id'), saldo: texto(fd, 'saldo'), referencia: texto(fd, 'referencia') }));
    recargar();
    return { ok: `Saldo inicial ${r.numero} registrado: queda pendiente de Gerencia.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function registrarCxcAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_APERTURA_CXC);
    const r = await conUsuario(u.id, (tx) => registrarCxc(tx, u, {
      clienteId: texto(fd, 'cliente_id'), sucursalId: texto(fd, 'sucursal_id'), numeroOriginal: texto(fd, 'numero_original'), numeroControl: texto(fd, 'numero_control'),
      fechaOriginal: texto(fd, 'fecha_original'), vencimiento: texto(fd, 'vencimiento'), saldo: texto(fd, 'saldo'), tasa: texto(fd, 'tasa'),
    }));
    recargar();
    return { ok: `Factura pendiente ${r.numero} registrada: queda pendiente de Gerencia.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function registrarCxpAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_APERTURA_CXP);
    const r = await conUsuario(u.id, (tx) => registrarCxp(tx, u, {
      proveedorId: texto(fd, 'proveedor_id'), numeroDocumento: texto(fd, 'numero_documento'), numeroControl: texto(fd, 'numero_control'),
      fechaOriginal: texto(fd, 'fecha_original'), vencimiento: texto(fd, 'vencimiento'), moneda: texto(fd, 'moneda'), saldo: texto(fd, 'saldo'), tasaUsd: texto(fd, 'tasa_usd'),
    }));
    recargar();
    return { ok: `Factura pendiente ${r.numero} registrada: queda pendiente de Gerencia.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** Gerencia aprueba o rechaza un documento de apertura (la base exige que no sea quien lo registró). */
export async function decidirAperturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const tipo = texto(fd, 'tipo');
    const id = texto(fd, 'id');
    if (!['apertura_banco', 'apertura_cxc', 'apertura_cxp'].includes(tipo) || !UUID.test(id)) return { error: 'Documento inválido.' };
    const aprobar = texto(fd, 'decision') === 'aprobar';
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, tipo, id, u.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? {} : { comentario: texto(fd, 'motivo') || 'Rechazado por Gerencia' }));
    recargar();
    return { ok: aprobar ? 'Aprobado y contabilizado.' : 'Rechazado. No se movió nada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cerrarAperturaAccion(): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    await conUsuario(u.id, (tx) => cerrarApertura(tx, u));
    recargar();
    return { ok: 'Apertura cerrada. Ya no se aceptan documentos de apertura.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
