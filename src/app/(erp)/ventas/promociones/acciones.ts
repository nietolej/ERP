'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import type { Usuario } from '@/lib/ventas/pedidos';
import {
  ROLES_CREAN_PROMOCIONES, TIPOS_ALCANCE, TIPOS_PROMOCION, agregarAlcancePorCodigo, anularPromocion, crearPromocion, editarPromocion,
  enviarAprobacion, quitarAlcance, type DatosPromocion, type TipoAlcance, type TipoPromocion,
} from '@/lib/ventas/promociones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (fd: FormData, campo = 'id') => (UUID.test(texto(fd, campo)) ? texto(fd, campo) : null);

function leer(fd: FormData): DatosPromocion {
  const tipo = texto(fd, 'tipo');
  return {
    nombre: texto(fd, 'nombre'),
    descripcion: texto(fd, 'descripcion'),
    tipo: ((TIPOS_PROMOCION as readonly string[]).includes(tipo) ? tipo : '') as TipoPromocion,
    descuentoPct: texto(fd, 'descuento_pct'),
    cantidadMinima: texto(fd, 'cantidad_minima'),
    vigenteDesde: texto(fd, 'vigente_desde'),
    vigenteHasta: texto(fd, 'vigente_hasta'),
  };
}

function recargar(promocionId: string) {
  revalidatePath('/ventas/promociones');
  revalidatePath(`/ventas/promociones/${promocionId}`);
}

/** Operación sobre la promoción del formulario (campo `id`) por quien puede crear promociones. */
async function operar(fd: FormData, ok: string, fn: (tx: Db, u: Usuario, promocionId: string) => Promise<unknown>): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CREAN_PROMOCIONES);
    const promocionId = id(fd);
    if (!promocionId) return { error: 'Promoción inválida.' };
    await conUsuario(u.id, (tx) => fn(tx, u, promocionId));
    recargar(promocionId);
    return { ok };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function crearPromocionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let nueva: string;
  try {
    const u = await autorizar(...ROLES_CREAN_PROMOCIONES);
    ({ id: nueva } = await conUsuario(u.id, (tx) => crearPromocion(tx, u, leer(fd))));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/ventas/promociones');
  redirect(`/ventas/promociones/${nueva}`);
}

export async function editarPromocionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Promoción actualizada.', (tx, _u, pid) => editarPromocion(tx, pid, leer(fd)));
}

export async function agregarAlcanceAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Agregado al alcance de la promoción.', (tx, _u, pid) => {
    const tipo = texto(fd, 'tipo');
    if (!(TIPOS_ALCANCE as readonly string[]).includes(tipo)) throw new ErrorMaestro('Seleccione a qué aplica la promoción.');
    return agregarAlcancePorCodigo(tx, pid, { tipo: tipo as TipoAlcance, codigo: texto(fd, 'codigo'), precioEspecialUsd: texto(fd, 'precio_especial_usd') });
  });
}

export async function quitarAlcanceAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Retirado del alcance.', (tx) => {
    const a = id(fd, 'alcance_id');
    if (!a) throw new ErrorMaestro('Elemento inválido.');
    return quitarAlcance(tx, a);
  });
}

export async function enviarAprobacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Promoción enviada a Gerencia para su aprobación.', (tx, u, pid) => enviarAprobacion(tx, u, pid));
}

export async function anularPromocionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Promoción anulada.', (tx, _u, pid) => anularPromocion(tx, pid, texto(fd, 'motivo')));
}

/** Quién decide lo establece el motor de aprobaciones (§4.5): Gerencia, distinta de quien la creó. */
export async function aprobarPromocionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const pid = id(fd);
    if (!pid) return { error: 'Promoción inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'promocion', pid, u.id, 'aprobada'));
    recargar(pid);
    return { ok: 'Promoción aprobada: ya se aplica en los pedidos.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarPromocionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const pid = id(fd);
    if (!pid) return { error: 'Promoción inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'promocion', pid, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(pid);
    return { ok: 'Promoción rechazada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
