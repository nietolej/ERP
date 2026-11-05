'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import {
  ROLES_LIQUIDAN, ROLES_PAGAN_COMISIONES, ROLES_PLANES, asignarPlan, crearPlan, enviarPlan, generarLiquidaciones, pagarLiquidacion, type ReglaEntrada,
} from '@/lib/comisiones/comisiones';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar() {
  revalidatePath('/comisiones', 'layout');
  revalidatePath('/aprobaciones');
}

/** El formulario trae filas `grupo_N`, `marca_N` y `pct_N`; una fila sin porcentaje se ignora. */
function reglasDe(fd: FormData): ReglaEntrada[] {
  const out: ReglaEntrada[] = [];
  for (let i = 1; i <= 8; i++) {
    const pct = texto(fd, `pct_${i}`);
    if (!pct) continue;
    out.push({ grupoId: texto(fd, `grupo_${i}`) || undefined, marcaId: texto(fd, `marca_${i}`) || undefined, porcentaje: pct });
  }
  return out;
}

export async function crearPlanAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_PLANES);
    id = await conUsuario(u.id, (tx) => crearPlan(tx, u, { nombre: texto(fd, 'nombre'), reglas: reglasDe(fd) }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/comisiones/planes/${id}`);
}

export async function enviarPlanAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PLANES);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Plan inválido.' };
    await conUsuario(u.id, (tx) => enviarPlan(tx, u, id));
    recargar();
    return { ok: 'Plan enviado a Gerencia para su aprobación.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function decidirPlanAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();      // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Plan inválido.' };
    const aprobar = texto(fd, 'decision') === 'aprobada';
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'plan_comision', id, u.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? undefined : { comentario: texto(fd, 'motivo') }));
    recargar();
    return { ok: aprobar ? 'Plan aprobado: ya se puede asignar a los vendedores.' : 'Plan rechazado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function asignarPlanAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PLANES);
    await conUsuario(u.id, (tx) => asignarPlan(tx, u, { vendedorId: texto(fd, 'vendedor_id'), planId: texto(fd, 'plan_id'), desde: texto(fd, 'desde') }));
    recargar();
    return { ok: 'Plan asignado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function generarLiquidacionesAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_LIQUIDAN);
    const r = await conUsuario(u.id, (tx) => generarLiquidaciones(tx, u, texto(fd, 'periodo')));
    recargar();
    const partes = [r.creadas.length ? `Se armaron ${r.creadas.length} liquidaciones y se enviaron a Gerencia.` : 'No había comisiones por liquidar con saldo a favor del vendedor.'];
    for (const a of r.arrastres) partes.push(`${a.vendedor}: saldo US$ ${a.netoUsd} que espera a la próxima liquidación${a.alerta ? ` — ALERTA: lleva ${a.meses} meses arrastrándose` : ''}.`);
    return { ok: partes.join('\n') };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function decidirLiquidacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Liquidación inválida.' };
    const aprobar = texto(fd, 'decision') === 'aprobada';
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'liquidacion_comision', id, u.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? undefined : { comentario: texto(fd, 'motivo') }));
    recargar();
    return { ok: aprobar ? 'Liquidación aprobada: Tesorería ya puede pagarla.' : 'Liquidación rechazada: sus movimientos quedaron libres para armarse de nuevo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function pagarLiquidacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PAGAN_COMISIONES);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Liquidación inválida.' };
    const r = await conUsuario(u.id, (tx) => pagarLiquidacion(tx, u, id, { cuentaBancariaId: texto(fd, 'cuenta_bancaria_id'), fecha: texto(fd, 'fecha'), referencia: texto(fd, 'referencia') || undefined }));
    recargar();
    return { ok: `Pagada. Asiento ${r.asiento}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
