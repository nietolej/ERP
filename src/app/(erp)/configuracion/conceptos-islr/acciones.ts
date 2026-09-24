'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function crearConceptoIslr(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const codigo = texto(fd, 'codigo').toUpperCase();
    const descripcion = texto(fd, 'descripcion');
    if (!/^[A-Z0-9.\-]{1,10}$/.test(codigo)) return { error: 'El código admite hasta 10 letras, números, puntos o guiones.' };
    if (descripcion.length < 3) return { error: 'Indique la descripción del concepto.' };
    await conUsuario(u.id, (tx) => tx.query('insert into concepto_islr (codigo, descripcion) values ($1, $2)', [codigo, descripcion]));
    revalidatePath('/configuracion/conceptos-islr');
    return { ok: `Concepto ${codigo} registrado.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cambiarEstadoConceptoIslr(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Concepto inválido.' };
    await conUsuario(u.id, (tx) => tx.query('update concepto_islr set activo = not activo where id = $1', [id]));
    revalidatePath('/configuracion/conceptos-islr');
    return { ok: 'Concepto actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
