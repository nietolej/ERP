'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ROLES_DECLARAN, declarar, reabrir, type TipoDeclaracion } from '@/lib/fiscal/declaraciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPOS: TipoDeclaracion[] = ['iva', 'retenciones_iva', 'retenciones_islr'];

export async function declararAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_DECLARAN);
    const tipo = texto(fd, 'tipo') as TipoDeclaracion;
    const m = /^(\d{4})-(\d{2})$/.exec(texto(fd, 'periodo'));
    if (!TIPOS.includes(tipo) || !m) return { error: 'Seleccione la declaración y el mes.' };
    const q = Number(texto(fd, 'quincena'));
    id = await conUsuario(u.id, (tx) => declarar(tx, u, { tipo, anio: Number(m[1]), mes: Number(m[2]), quincena: q === 1 || q === 2 ? q : null }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/fiscal/declaraciones');
  redirect(`/fiscal/declaraciones/${id}`);
}

export async function reabrirAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Declaración inválida.' };
    await conUsuario(u.id, (tx) => reabrir(tx, u, id, texto(fd, 'motivo')));
    revalidatePath('/fiscal/declaraciones');
    revalidatePath(`/fiscal/declaraciones/${id}`);
    return { ok: 'Periodo reabierto. Ya se pueden registrar documentos de ese periodo y declararlo de nuevo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
