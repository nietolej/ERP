'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ROLES_EMITEN_COMPROBANTES, emitirPeriodo } from '@/lib/fiscal/comprobantes';

export async function emitirComprobantesAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_EMITEN_COMPROBANTES);
    const m = /^(\d{4})-(\d{2})$/.exec(texto(fd, 'periodo'));
    if (!m) return { error: 'Indique el mes.' };
    const r = await conUsuario(u.id, (tx) => emitirPeriodo(tx, u, Number(m[1]), Number(m[2])));
    revalidatePath('/fiscal/comprobantes');
    return { ok: `${r.emitidos} comprobantes emitidos (IVA ${r.porImpuesto.iva}, ISLR ${r.porImpuesto.islr}).` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
