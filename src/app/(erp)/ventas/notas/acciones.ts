'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario, getDb } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { productoPorCodigo } from '@/lib/ventas/pedidos';
import {
  CLASES_NC, CLASES_ND, ROLES_CREAN_NOTAS, ROLES_EMITEN_NOTAS, asignarControlNota, crearNotaCredito, crearNotaDebito, eliminarNota, emitirNota,
  enviarAprobacion, type ClaseNC, type ClaseND,
} from '@/lib/ventas/notas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (fd: FormData, campo: string) => (UUID.test(texto(fd, campo)) ? texto(fd, campo) : null);

function recargar(notaId: string, facturaId?: string) {
  revalidatePath('/ventas/notas');
  revalidatePath(`/ventas/notas/${notaId}`);
  if (facturaId) revalidatePath(`/ventas/facturas/${facturaId}`);
  revalidatePath('/cobranzas/cuentas');
}

export async function crearNotaCreditoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let nueva: string;
  try {
    const u = await autorizar(...ROLES_CREAN_NOTAS);
    const facturaId = id(fd, 'factura_id');
    const clase = texto(fd, 'clase');
    if (!facturaId) return { error: 'Factura inválida.' };
    if (!(CLASES_NC as readonly string[]).includes(clase)) return { error: 'Seleccione la clase de nota de crédito.' };
    const lineas: { lineaId: string; cantidad: string }[] = [];
    const lineaIds: string[] = [];
    for (const [clave, valor] of fd.entries()) {
      if (typeof valor !== 'string') continue;
      if (clave.startsWith('dev_') && valor.trim() && UUID.test(clave.slice(4))) lineas.push({ lineaId: clave.slice(4), cantidad: valor });
      if (clave.startsWith('sel_') && UUID.test(clave.slice(4))) lineaIds.push(clave.slice(4));
    }
    nueva = await conUsuario(u.id, (tx) => crearNotaCredito(tx, u, {
      facturaId, clase: clase as ClaseNC, motivoId: id(fd, 'motivo_id') ?? undefined, observaciones: texto(fd, 'observaciones'),
      lineas: clase === 'devolucion' ? lineas : undefined, porcentaje: texto(fd, 'porcentaje'), lineaIds: clase === 'devolucion' || !lineaIds.length ? undefined : lineaIds,
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/ventas/notas');
  redirect(`/ventas/notas/${nueva}`);
}

export async function crearNotaDebitoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let nueva: string;
  try {
    const u = await autorizar(...ROLES_CREAN_NOTAS);
    const facturaId = id(fd, 'factura_id');
    const motivo = texto(fd, 'motivo');
    if (!facturaId) return { error: 'Factura inválida.' };
    if (!(CLASES_ND as readonly string[]).includes(motivo)) return { error: 'Seleccione el motivo de la nota de débito.' };
    const db = await getDb();
    const lineas: { productoId: string; descripcion?: string; cantidad: string; precio: string }[] = [];
    for (const n of [1, 2, 3]) {
      const codigo = texto(fd, `c${n}_codigo`);
      if (!codigo && !texto(fd, `c${n}_precio`)) continue;
      lineas.push({ productoId: await productoPorCodigo(db, codigo), descripcion: texto(fd, `c${n}_descripcion`), cantidad: texto(fd, `c${n}_cantidad`) || '1', precio: texto(fd, `c${n}_precio`) });
    }
    nueva = await conUsuario(u.id, (tx) => crearNotaDebito(tx, u, {
      facturaId, motivo: motivo as ClaseND, observaciones: texto(fd, 'observaciones'), vencimiento: texto(fd, 'vencimiento') || undefined, lineas,
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/ventas/notas');
  redirect(`/ventas/notas/${nueva}`);
}

async function conNota(fd: FormData, roles: readonly string[] | null, ok: string, fn: (tx: Parameters<Parameters<typeof conUsuario>[1]>[0], u: { id: string; roles: string[] }, notaId: string) => Promise<string | void>): Promise<EstadoAccion> {
  try {
    const u = roles ? await autorizar(...(roles as never[])) : await autorizarSesion();
    const notaId = id(fd, 'id');
    if (!notaId) return { error: 'Nota inválida.' };
    const detalle = await conUsuario(u.id, (tx) => fn(tx, u, notaId));
    recargar(notaId, id(fd, 'factura_id') ?? undefined);
    return { ok: detalle || ok };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function enviarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return conNota(fd, ROLES_CREAN_NOTAS, 'Nota enviada al Supervisor de ventas para su aprobación.', (tx, u, nota) => enviarAprobacion(tx, u, nota));
}

export async function eliminarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let eliminada = false;
  const r = await conNota(fd, ROLES_CREAN_NOTAS, 'Nota eliminada.', async (tx, u, nota) => { await eliminarNota(tx, u, nota); eliminada = true; });
  if (eliminada) {
    revalidatePath('/ventas/notas');
    redirect('/ventas/notas');
  }
  return r;
}

/** Quién decide lo establece el motor de aprobaciones (§4.5): el Supervisor de ventas, distinto de quien creó la nota. */
export async function aprobarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return conNota(fd, null, 'Nota aprobada: Facturación ya puede emitirla.', async (tx, u, nota) => {
    const tipo = texto(fd, 'tipo');
    if (tipo !== 'nota_credito' && tipo !== 'nota_debito') throw new ErrorMaestro('Tipo de nota inválido.');
    await resolverAprobacion(tx, tipo, nota, u.id, 'aprobada');
  });
}

export async function rechazarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return conNota(fd, null, 'Nota rechazada.', async (tx, u, nota) => {
    const tipo = texto(fd, 'tipo');
    if (tipo !== 'nota_credito' && tipo !== 'nota_debito') throw new ErrorMaestro('Tipo de nota inválido.');
    await resolverAprobacion(tx, tipo, nota, u.id, 'rechazada', { comentario: texto(fd, 'motivo') });
  });
}

export async function emitirNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return conNota(fd, ROLES_EMITEN_NOTAS, 'Nota emitida.', async (tx, u, nota) => {
    const r = await emitirNota(tx, u, nota);
    return `Nota ${r.numero} emitida (asiento ${r.asiento}${r.asientoInventario ? `, reingreso al inventario ${r.asientoInventario}` : ''})${r.contingencia ? ', en contingencia: falta el número de control' : ''}.`;
  });
}

export async function asignarControlNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return conNota(fd, ROLES_EMITEN_NOTAS, 'Número de control asignado.', async (tx, _u, nota) => `Número de control ${await asignarControlNota(tx, nota)} asignado.`);
}
