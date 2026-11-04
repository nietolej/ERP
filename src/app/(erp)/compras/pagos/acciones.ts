'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { aplicarAnticipoPago, anularPago, ROLES_PAGAN, solicitarPago, type AplicacionPagoEntrada } from '@/lib/compras/pagos';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id?: string) {
  revalidatePath('/compras/pagos');
  revalidatePath('/compras/cuentas-por-pagar');
  revalidatePath('/tesoreria/cuentas');
  if (id) revalidatePath(`/compras/pagos/${id}`);
}

/** Las facturas marcadas en el formulario: `partida` (una por factura) y `monto_<id>` con lo que se aplica a cada una. */
function aplicacionesDe(fd: FormData): AplicacionPagoEntrada[] {
  return fd.getAll('partida').map(String).filter((id) => UUID.test(id)).map((partidaId) => ({
    partidaId, monto: texto(fd, `monto_${partidaId}`), liquida: texto(fd, `liquida_${partidaId}`) === '1',
  }));
}

export async function solicitarPagoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_PAGAN);
    const proveedorId = texto(fd, 'proveedor_id');
    if (!UUID.test(proveedorId)) return { error: 'Seleccione el proveedor.' };
    const cuentaBancariaId = texto(fd, 'cuenta_bancaria_id');
    const instrumentoId = texto(fd, 'instrumento_id');
    if (!UUID.test(cuentaBancariaId)) return { error: 'Seleccione la cuenta de donde sale el pago.' };
    if (!UUID.test(instrumentoId)) return { error: 'Seleccione el instrumento de pago.' };
    const r = await conUsuario(u.id, (tx) => solicitarPago(tx, u, {
      proveedorId, fecha: texto(fd, 'fecha'), instrumentoId, cuentaBancariaId, referencia: texto(fd, 'referencia') || undefined,
      monto: texto(fd, 'monto'), observaciones: texto(fd, 'observaciones') || undefined, aplicaciones: aplicacionesDe(fd),
    }));
    id = r.id;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/compras/pagos/${id}`);
}

export async function aprobarPagoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pago inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'pago_proveedor', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Pago aprobado: se aplicó a las facturas, salió del banco y quedó contabilizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarPagoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pago inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'pago_proveedor', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Pago rechazado. No se movió nada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function aplicarAnticipoPagoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PAGAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Pago inválido.' };
    const r = await conUsuario(u.id, (tx) => aplicarAnticipoPago(tx, u, id, { aplicaciones: aplicacionesDe(fd) }));
    recargar(id);
    return { ok: `Anticipo aplicado (asiento ${r.asiento}). Queda por aplicar: ${r.anticipo}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularPagoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia', 'tesoreria');
    const id = texto(fd, 'id');
    const motivoId = texto(fd, 'motivo_id');
    if (!UUID.test(id) || !UUID.test(motivoId)) return { error: 'Seleccione el motivo de la anulación.' };
    await conUsuario(u.id, (tx) => anularPago(tx, u, id, { motivoId, detalle: texto(fd, 'detalle') }));
    recargar(id);
    return { ok: 'Pago anulado: se revirtió el asiento y las facturas recuperaron su saldo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
