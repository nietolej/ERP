'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ErrorMaestro } from '@/lib/maestros/terceros';

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

/**
 * Bloquear un periodo cerrado (definitivo, con confirmación explícita) y abrir o cerrar el periodo 13 del ejercicio. Los meses de enero a diciembre se
 * cierran y se reabren desde el cierre mensual (checklist y foto), no cambiando su estado.
 */
export async function cambiarEstadoPeriodo(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad', 'jefe_contabilidad', 'gerencia');
    const id = texto(fd, 'id');
    const estado = texto(fd, 'estado');
    if (!['abierto', 'cerrado', 'bloqueado'].includes(estado)) return { error: 'Estado inválido.' };
    if (estado === 'bloqueado' && fd.get('confirmo') !== 'on') {
      return { error: 'Para bloquear marque la confirmación: un periodo bloqueado no se puede reabrir.' };
    }
    await conUsuario(u.id, async (tx) => {
      const { rows } = await tx.query<{ mes: number }>('select mes from periodo_contable where id = $1', [id]);
      if (!rows[0]) throw new ErrorMaestro('El periodo no existe.');
      if (rows[0].mes <= 12 && estado !== 'bloqueado') throw new ErrorMaestro('Un mes se cierra y se reabre desde Contabilidad → Cierre mensual.');
      await tx.query('update periodo_contable set estado = $2 where id = $1', [id, estado]);
    });
    revalidatePath('/contabilidad/periodos');
    return { ok: `Periodo ${estado}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
