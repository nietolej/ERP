'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_SALIDA, confirmarSalida, despacharParcial } from '@/lib/ventas/despacho';
import {
  ROLES_DECIDEN_FALTANTE, ROLES_PICKING, cambiarPrioridad, empacarOrden, esperarFaltante, finalizarOrden, iniciarOrden,
  registrarRecogida, tomarOrden,
} from '@/lib/ventas/picking';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(orden: string, nota?: string | null) {
  revalidatePath('/almacen/picking');
  revalidatePath(`/almacen/picking/${orden}`);
  revalidatePath('/ventas/notas-entrega');
  if (nota) revalidatePath(`/ventas/notas-entrega/${nota}`);
}

type Operacion = (u: { id: string; roles: string[] }, id: string, fd: FormData) => Promise<string | void>;

/** Ejecuta una operación sobre una orden de picking con el rol y el manejo de errores comunes. */
async function sobreOrden(roles: readonly string[], fd: FormData, operacion: Operacion): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...(roles as Parameters<typeof autorizar>));
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Orden inválida.' };
    const mensaje = await operacion(u, id, fd);
    recargar(id);
    return { ok: mensaje || 'Listo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function tomarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_PICKING, fd, async (u, id) => {
    await conUsuario(u.id, (tx) => tomarOrden(tx, u, id));
    return 'Orden asignada a usted.';
  });
}

export async function iniciarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_PICKING, fd, async (u, id) => {
    await conUsuario(u.id, (tx) => iniciarOrden(tx, u, id));
    return 'Picking iniciado.';
  });
}

export async function cambiarPrioridadAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_PICKING, fd, async (u, id) => {
    await conUsuario(u.id, (tx) => cambiarPrioridad(tx, u, id, Number(texto(fd, 'prioridad'))));
    return 'Prioridad actualizada.';
  });
}

export async function registrarRecogidaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_PICKING, fd, async (u, id) => {
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(linea)) throw new ErrorMaestro('Línea inválida.');
    await conUsuario(u.id, (tx) => registrarRecogida(tx, u, id, linea, { cantidad: texto(fd, 'cantidad'), motivoFaltante: texto(fd, 'motivo') }));
    return 'Recogida registrada.';
  });
}

export async function finalizarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_PICKING, fd, async (u, id) => {
    const estado = await conUsuario(u.id, (tx) => finalizarOrden(tx, u, id));
    return estado === 'completa' ? 'Picking completo. Falta el empaque.' : 'Picking con faltante: Gerencia o el supervisor deben decidir cómo seguir.';
  });
}

export async function empacarOrdenAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_PICKING, fd, async (u, id) => {
    await conUsuario(u.id, (tx) => empacarOrden(tx, u, id));
    return 'Empaque registrado. Ya se puede confirmar la salida.';
  });
}

export async function esperarFaltanteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_DECIDEN_FALTANTE, fd, async (u, id) => {
    await conUsuario(u.id, (tx) => esperarFaltante(tx, id));
    return 'La orden vuelve a estar en proceso.';
  });
}

export async function despacharParcialAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  return sobreOrden(ROLES_DECIDEN_FALTANTE, fd, async (u, id) => {
    const r = await conUsuario(u.id, (tx) => despacharParcial(tx, u, id));
    return r.notaNuevaId
      ? 'Se emitió una nota de entrega nueva con lo recogido; la anterior quedó anulada.'
      : 'No se recogió nada: la nota se anuló y la orden se canceló.';
  });
}

export async function confirmarSalidaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_SALIDA);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Nota inválida.' };
    const r = await conUsuario(u.id, (tx) => confirmarSalida(tx, u, id));
    revalidatePath('/almacen/picking');
    revalidatePath('/ventas/notas-entrega');
    revalidatePath(`/ventas/notas-entrega/${id}`);
    return { ok: `Salida confirmada. Costo de la venta US$ ${r.costoUsd}${r.asiento ? `, asiento ${r.asiento}` : ''}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
