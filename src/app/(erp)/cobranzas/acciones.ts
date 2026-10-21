'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_COBRAN, anularCobro, aplicarAnticipo, registrarCobro, type AplicacionEntrada } from '@/lib/ventas/cobros';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (fd: FormData, campo: string) => (UUID.test(texto(fd, campo)) ? texto(fd, campo) : null);

/** Los campos `ap_<id de la partida>` traen lo que se aplica a cada factura y `liq_<id>` marca las que se liquidan. */
function leerAplicaciones(fd: FormData): AplicacionEntrada[] {
  const lista: AplicacionEntrada[] = [];
  for (const [clave, valor] of fd.entries()) {
    if (!clave.startsWith('ap_') || typeof valor !== 'string' || !valor.trim()) continue;
    const partidaId = clave.slice(3);
    if (!UUID.test(partidaId)) throw new ErrorMaestro('Factura inválida.');
    lista.push({ partidaId, monto: valor, liquida: fd.get(`liq_${partidaId}`) === 'on' });
  }
  return lista;
}

export async function registrarCobroAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let nuevo: string;
  try {
    const u = await autorizar(...ROLES_COBRAN);
    const clienteId = id(fd, 'cliente_id');
    const instrumentoId = id(fd, 'instrumento_id');
    const cuentaBancariaId = id(fd, 'cuenta_bancaria_id');
    if (!clienteId) return { error: 'Seleccione el cliente.' };
    if (!instrumentoId) return { error: 'Seleccione el instrumento de pago.' };
    if (!cuentaBancariaId) return { error: 'Seleccione la cuenta donde entró el cobro.' };
    ({ id: nuevo } = await conUsuario(u.id, (tx) => registrarCobro(tx, u, {
      clienteId, instrumentoId, cuentaBancariaId, fecha: texto(fd, 'fecha'), referencia: texto(fd, 'referencia'), monto: texto(fd, 'monto'),
      observaciones: texto(fd, 'observaciones'), aplicaciones: leerAplicaciones(fd),
    })));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/cobranzas/cobros');
  revalidatePath('/cobranzas/cuentas');
  redirect(`/cobranzas/cobros/${nuevo}`);
}

function recargar(cobroId: string) {
  revalidatePath('/cobranzas/cobros');
  revalidatePath(`/cobranzas/cobros/${cobroId}`);
  revalidatePath('/cobranzas/cuentas');
}

export async function aplicarAnticipoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COBRAN);
    const cobroId = id(fd, 'id');
    if (!cobroId) return { error: 'Cobro inválido.' };
    const r = await conUsuario(u.id, (tx) => aplicarAnticipo(tx, u, cobroId, { fecha: texto(fd, 'fecha') || undefined, aplicaciones: leerAplicaciones(fd) }));
    recargar(cobroId);
    return { ok: `Anticipo aplicado (asiento ${r.asiento}). Queda por aplicar: ${r.anticipo}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularCobroAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_COBRAN);
    const cobroId = id(fd, 'id');
    const motivoId = id(fd, 'motivo_id');
    if (!cobroId) return { error: 'Cobro inválido.' };
    if (!motivoId) return { error: 'Seleccione el motivo de la anulación.' };
    await conUsuario(u.id, (tx) => anularCobro(tx, u, cobroId, { motivoId, detalle: texto(fd, 'detalle') }));
    recargar(cobroId);
    return { ok: 'Cobro anulado: las facturas recuperaron su saldo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
