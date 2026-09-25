'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { agregarPaso, cambiarActivoFlujo, quitarPaso } from '@/lib/flujo/flujo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Los flujos los define Gerencia (§4.5). Un cambio aplica a las solicitudes nuevas; las abiertas conservan sus pasos. */
export async function agregarPasoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'definicion_id');
    if (!UUID.test(id)) return { error: 'Flujo inválido.' };
    await conUsuario(u.id, (tx) => agregarPaso(tx, id, {
      rol: texto(fd, 'rol'),
      distintoDelCreador: fd.get('distinto_del_creador') === 'on',
      condicionCampo: texto(fd, 'condicion_campo'),
      condicionOperador: texto(fd, 'condicion_operador'),
      condicionValor: texto(fd, 'condicion_valor'),
      horasParaEscalar: texto(fd, 'horas_para_escalar'),
      escalarARol: texto(fd, 'escalar_a_rol'),
    }));
    revalidatePath('/configuracion/flujos');
    return { ok: 'Paso agregado. Aplica a las solicitudes nuevas.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarPasoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Paso inválido.' };
    await conUsuario(u.id, (tx) => quitarPaso(tx, id));
    revalidatePath('/configuracion/flujos');
    return { ok: 'Paso retirado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cambiarActivoFlujoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Flujo inválido.' };
    await conUsuario(u.id, (tx) => cambiarActivoFlujo(tx, id, fd.get('activo') === '1'));
    revalidatePath('/configuracion/flujos');
    return { ok: 'Flujo actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
