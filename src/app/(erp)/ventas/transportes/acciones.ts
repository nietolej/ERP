'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import type { Usuario } from '@/lib/ventas/pedidos';
import {
  ROLES_TRANSPORTE, agregarParada, anularTransporte, cambiarDireccionParada, cargarTransporte, cerrarTransporte, crearTransporte,
  editarTransporte, moverParada, quitarParada, registrarEntrega, registrarLlegada, registrarNoEntrega, salirARuta,
} from '@/lib/ventas/transportes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (fd: FormData, campo: string) => (UUID.test(texto(fd, campo)) ? texto(fd, campo) : null);

/** Ejecuta una operación sobre el transporte del formulario (campo `transporte_id`) y refresca sus pantallas. */
async function operar(
  fd: FormData, ok: string, fn: (tx: Db, u: Usuario, transporteId: string) => Promise<string | void>,
): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_TRANSPORTE);
    const transporteId = id(fd, 'transporte_id');
    if (!transporteId) return { error: 'Transporte inválido.' };
    const detalle = await conUsuario(u.id, (tx) => fn(tx, u, transporteId));
    revalidatePath('/ventas/transportes');
    revalidatePath(`/ventas/transportes/${transporteId}`);
    return { ok: detalle || ok };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function crearTransporteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let nuevo: string;
  try {
    const u = await autorizar(...ROLES_TRANSPORTE);
    const almacenId = id(fd, 'almacen_id');
    const transportistaId = id(fd, 'transportista_id');
    if (!almacenId) return { error: 'Seleccione el almacén de salida.' };
    if (!transportistaId) return { error: 'Seleccione el transportista.' };
    nuevo = await conUsuario(u.id, (tx) => crearTransporte(tx, u, {
      almacenId, transportistaId, vehiculoId: id(fd, 'vehiculo_id') ?? undefined, chofer: texto(fd, 'chofer'),
      fechaProgramada: texto(fd, 'fecha_programada'), observaciones: texto(fd, 'observaciones'),
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/ventas/transportes');
  redirect(`/ventas/transportes/${nuevo}`);
}

export async function editarTransporteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Transporte actualizado.', async (tx, u, tid) => {
    const transportistaId = id(fd, 'transportista_id');
    if (!transportistaId) throw new ErrorMaestro('Seleccione el transportista.');
    await editarTransporte(tx, u, tid, {
      transportistaId, vehiculoId: id(fd, 'vehiculo_id') ?? undefined, chofer: texto(fd, 'chofer'),
      fechaProgramada: texto(fd, 'fecha_programada'), observaciones: texto(fd, 'observaciones'),
    });
  });
}

export async function agregarParadaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Parada agregada.', async (tx, u, tid) => {
    const notaId = id(fd, 'nota_id');
    if (!notaId) throw new ErrorMaestro('Seleccione la nota de entrega.');
    await agregarParada(tx, u, tid, { notaId, direccionId: id(fd, 'direccion_id') ?? undefined });
  });
}

export async function quitarParadaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Parada retirada.', async (tx, u) => {
    const p = id(fd, 'parada_id');
    if (!p) throw new ErrorMaestro('Parada inválida.');
    await quitarParada(tx, u, p);
  });
}

export async function moverParadaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Orden actualizado.', async (tx, u) => {
    const p = id(fd, 'parada_id');
    if (!p) throw new ErrorMaestro('Parada inválida.');
    await moverParada(tx, u, p, texto(fd, 'sentido') === 'bajar' ? 'bajar' : 'subir');
  });
}

export async function cambiarDireccionParadaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Dirección actualizada.', async (tx, u) => {
    const p = id(fd, 'parada_id');
    const d = id(fd, 'direccion_id');
    if (!p || !d) throw new ErrorMaestro('Seleccione la dirección.');
    await cambiarDireccionParada(tx, u, p, d);
  });
}

export async function cargarTransporteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Transporte cargado.', async (tx, u, tid) => {
    const r = await cargarTransporte(tx, u, tid);
    return r.notasDespachadas > 0
      ? `Transporte cargado. Salió la mercancía de ${r.notasDespachadas} nota${r.notasDespachadas === 1 ? '' : 's'} de entrega.`
      : 'Transporte cargado.';
  });
}

export async function salirARutaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'El transporte salió a ruta.', (tx, u, tid) => salirARuta(tx, u, tid));
}

export async function registrarLlegadaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Llegada registrada.', async (tx, u) => {
    const p = id(fd, 'parada_id');
    if (!p) throw new ErrorMaestro('Parada inválida.');
    await registrarLlegada(tx, u, p);
  });
}

export async function registrarEntregaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Entrega registrada.', async (tx, u) => {
    const p = id(fd, 'parada_id');
    if (!p) throw new ErrorMaestro('Parada inválida.');
    await registrarEntrega(tx, u, p, { recibidoPor: texto(fd, 'recibido_por'), incidencia: texto(fd, 'incidencia') });
  });
}

export async function registrarNoEntregaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'No entrega registrada.', async (tx, u) => {
    const p = id(fd, 'parada_id');
    if (!p) throw new ErrorMaestro('Parada inválida.');
    await registrarNoEntrega(tx, u, p, texto(fd, 'incidencia'));
  });
}

export async function cerrarTransporteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Transporte cerrado.', (tx, u, tid) => cerrarTransporte(tx, u, tid, texto(fd, 'flete_usd')));
}

export async function anularTransporteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return operar(fd, 'Transporte anulado.', (tx, u, tid) => anularTransporte(tx, u, tid, texto(fd, 'motivo')));
}
