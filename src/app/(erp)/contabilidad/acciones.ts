'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';

export async function crearPeriodosDelAnio(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const anio = Number(texto(fd, 'anio'));
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return { error: 'Año inválido.' };
    const creados = await conUsuario(u.id, async (tx) =>
      (await tx.query<{ n: number }>('select fn_crear_periodos($1) as n', [anio])).rows[0].n);
    revalidatePath('/contabilidad/periodos');
    revalidatePath('/');
    return { ok: Number(creados) > 0 ? `Periodos de ${anio} creados (${creados}).` : `Los periodos de ${anio} ya existían.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** abierto ↔ cerrado; bloqueado es definitivo y requiere confirmación explícita. */
export async function cambiarEstadoPeriodo(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const id = texto(fd, 'id');
    const estado = texto(fd, 'estado');
    if (!['abierto', 'cerrado', 'bloqueado'].includes(estado)) return { error: 'Estado inválido.' };
    if (estado === 'bloqueado' && fd.get('confirmo') !== 'on') {
      return { error: 'Para bloquear marque la confirmación: un periodo bloqueado no se puede reabrir.' };
    }
    await conUsuario(u.id, (tx) => tx.query('update periodo_contable set estado = $2 where id = $1', [id, estado]));
    revalidatePath('/contabilidad/periodos');
    return { ok: `Periodo ${estado}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
