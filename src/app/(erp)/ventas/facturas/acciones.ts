'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ROLES_FACTURAN, anularFactura, asignarControlPendiente, facturarNotas } from '@/lib/ventas/facturas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id?: string) {
  revalidatePath('/ventas/facturas');
  revalidatePath('/ventas/facturas/nueva');
  revalidatePath('/ventas/notas-entrega');
  if (id) revalidatePath(`/ventas/facturas/${id}`);
}

export async function facturarAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_FACTURAN);
    const notas = fd.getAll('notas').map(String).filter((v) => UUID.test(v));
    if (!notas.length) return { error: 'Seleccione al menos una nota de entrega.' };
    id = (await conUsuario(u.id, (tx) => facturarNotas(tx, u, notas))).facturaId;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar(id);
  redirect(`/ventas/facturas/${id}`);
}

export async function asignarControlAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_FACTURAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura inválida.' };
    const control = await conUsuario(u.id, (tx) => asignarControlPendiente(tx, u, id));
    recargar(id);
    return { ok: `Número de control asignado: ${control}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularFacturaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_FACTURAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Factura inválida.' };
    await conUsuario(u.id, (tx) => anularFactura(tx, u, id, { motivoId: texto(fd, 'motivo_id'), detalle: texto(fd, 'detalle') }));
    recargar(id);
    return { ok: 'Factura anulada. Sus notas de entrega quedaron libres para facturarse de nuevo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
