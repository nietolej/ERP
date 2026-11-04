'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import {
  ROLES_CIERRAN, ROLES_CONCILIAN, actualizarSaldosExtracto, agregarLinea, cerrarExtracto, conciliar, conciliarPares, crearExtracto, desconciliar, eliminarLinea, importarCsv,
} from '@/lib/tesoreria/conciliacion';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_LINEA = /^\d{1,18}$/;

function recargar(id?: string) {
  revalidatePath('/tesoreria/conciliacion');
  revalidatePath('/cobranzas/cobros');
  if (id) revalidatePath(`/tesoreria/conciliacion/${id}`);
}

export async function crearExtractoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const [anio, mes] = texto(fd, 'periodo').split('-').map(Number);
    id = await conUsuario(u.id, (tx) => crearExtracto(tx, u, {
      cuentaId: texto(fd, 'cuenta_id'), anio, mes, saldoInicial: texto(fd, 'saldo_inicial'), saldoFinal: texto(fd, 'saldo_final'),
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/tesoreria/conciliacion/${id}`);
}

export async function saldosExtractoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Extracto inválido.' };
    await conUsuario(u.id, (tx) => actualizarSaldosExtracto(tx, u, id, texto(fd, 'saldo_inicial'), texto(fd, 'saldo_final')));
    recargar(id);
    return { ok: 'Saldos del banco actualizados.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function importarCsvAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Extracto inválido.' };
    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Seleccione el archivo CSV del banco.' };
    if (archivo.size > 2 * 1024 * 1024) return { error: 'El archivo no puede pasar de 2 MB.' };
    const contenido = new TextDecoder('utf-8').decode(new Uint8Array(await archivo.arrayBuffer()));
    const n = await conUsuario(u.id, (tx) => importarCsv(tx, u, id, contenido));
    recargar(id);
    return { ok: `${n} movimientos cargados.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function agregarLineaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Extracto inválido.' };
    await conUsuario(u.id, (tx) => agregarLinea(tx, u, id, {
      fecha: texto(fd, 'fecha'), descripcion: texto(fd, 'descripcion'), referencia: texto(fd, 'referencia'), monto: texto(fd, 'monto').replace(',', '.'),
    }));
    recargar(id);
    return { ok: 'Movimiento agregado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarLineaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(linea)) return { error: 'Movimiento inválido.' };
    await conUsuario(u.id, (tx) => eliminarLinea(tx, u, linea));
    recargar(texto(fd, 'id'));
    return { ok: 'Movimiento eliminado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** Confirma los pares marcados (cada uno «línea:asiento_linea»). */
export async function confirmarParesAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const pares = fd.getAll('par').map(String).map((p) => p.split(':')).filter(([l, a]) => UUID.test(l ?? '') && ID_LINEA.test(a ?? ''))
      .map(([lineaId, asientoLineaId]) => ({ lineaId, asientoLineaId }));
    if (!pares.length) return { error: 'Marque al menos un par para confirmar.' };
    const n = await conUsuario(u.id, (tx) => conciliarPares(tx, u, pares));
    recargar(texto(fd, 'id'));
    return { ok: `${n} pares conciliados.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function emparejarAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const linea = texto(fd, 'linea_id');
    const asiento = texto(fd, 'asiento_linea_id');
    if (!UUID.test(linea) || !ID_LINEA.test(asiento)) return { error: 'Par inválido.' };
    await conUsuario(u.id, (tx) => conciliar(tx, u, linea, asiento));
    recargar(texto(fd, 'id'));
    return { ok: 'Conciliado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function desconciliarAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CONCILIAN);
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(linea)) return { error: 'Movimiento inválido.' };
    await conUsuario(u.id, (tx) => desconciliar(tx, u, linea));
    recargar(texto(fd, 'id'));
    return { ok: 'Conciliación deshecha.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cerrarExtractoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CIERRAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Extracto inválido.' };
    await conUsuario(u.id, (tx) => cerrarExtracto(tx, u, id));
    recargar(id);
    return { ok: 'Mes conciliado y cerrado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
