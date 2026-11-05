'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizarSesion } from '@/lib/auth/dal';
import { cerrarMes, confirmarCierre, reabrirMes, retirarConfirmacionCierre, type CodigoCierre } from '@/lib/contabilidad/cierre';
import { conUsuario } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mesDe(fd: FormData): { anio: number; mes: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(texto(fd, 'periodo'));
  if (!m) return null;
  const mes = Number(m[2]);
  return mes >= 1 && mes <= 12 ? { anio: Number(m[1]), mes } : null;
}

function refrescar() {
  revalidatePath('/contabilidad/cierre');
  revalidatePath('/contabilidad/periodos');
  revalidatePath('/');
}

export async function confirmarCierreAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const p = mesDe(fd);
    if (!p) return { error: 'Indique un mes válido.' };
    await conUsuario(u.id, (tx) => confirmarCierre(tx, u, p.anio, p.mes, texto(fd, 'codigo') as CodigoCierre, texto(fd, 'nota')));
    refrescar();
    return { ok: 'Confirmación registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function retirarCierreAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Confirmación inválida.' };
    await conUsuario(u.id, (tx) => retirarConfirmacionCierre(tx, u, id, texto(fd, 'motivo')));
    refrescar();
    return { ok: 'Confirmación retirada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cerrarMesAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const p = mesDe(fd);
    if (!p) return { error: 'Indique un mes válido.' };
    await conUsuario(u.id, (tx) => cerrarMes(tx, u, p.anio, p.mes));
    refrescar();
    return { ok: 'Periodo cerrado. Ya no admite asientos nuevos, solo reversos.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function reabrirMesAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const p = mesDe(fd);
    if (!p) return { error: 'Indique un mes válido.' };
    await conUsuario(u.id, (tx) => reabrirMes(tx, u, p.anio, p.mes, texto(fd, 'motivo')));
    refrescar();
    return { ok: 'Periodo reabierto. Queda en el historial con su motivo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
