'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { aprobarAsiento, eliminarBorrador, guardarBorrador, type LineaManual } from '@/lib/contabilidad/manual';
import { conUsuario } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leerLineas(fd: FormData): LineaManual[] {
  try {
    const crudas = JSON.parse(String(fd.get('lineas') ?? '[]')) as unknown;
    if (!Array.isArray(crudas)) return [];
    return crudas.map((l: Record<string, unknown>) => ({
      cuentaId: typeof l.cuentaId === 'string' && UUID.test(l.cuentaId) ? l.cuentaId : '',
      debe: typeof l.debe === 'string' ? l.debe : '',
      haber: typeof l.haber === 'string' ? l.haber : '',
      glosa: typeof l.glosa === 'string' ? l.glosa : '',
    }));
  } catch {
    return [];
  }
}

/** Crea un borrador o corrige uno propio (si llega `id`). */
export async function guardarAsiento(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar('contabilidad');
    const previo = texto(fd, 'id');
    if (previo && !UUID.test(previo)) return { error: 'Asiento inválido.' };
    id = await conUsuario(u.id, (tx) =>
      guardarBorrador(tx, u.id, {
        fecha: texto(fd, 'fecha'),
        descripcion: texto(fd, 'descripcion'),
        moneda: texto(fd, 'moneda'),
        lineas: leerLineas(fd),
      }, previo || undefined));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/contabilidad/asientos');
  redirect(`/contabilidad/asientos/${id}`);
}

export async function eliminarAsiento(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Asiento inválido.' };
    await conUsuario(u.id, (tx) => eliminarBorrador(tx, id, u.id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/contabilidad/asientos');
  redirect('/contabilidad/asientos');
}

export async function aprobarAsientoManual(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('jefe_contabilidad');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Asiento inválido.' };
    const numero = await conUsuario(u.id, (tx) => aprobarAsiento(tx, id, u.id, texto(fd, 'huella')));
    revalidatePath('/contabilidad/asientos');
    revalidatePath(`/contabilidad/asientos/${id}`);
    revalidatePath('/contabilidad/balance');
    return { ok: `Asiento aprobado y contabilizado con el N° ${numero}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
