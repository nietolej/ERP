'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { ROLES_GESTIONAN_ACTIVOS, confirmarVidaUtil, depreciarMes, registrarActivoApertura, solicitarBaja } from '@/lib/contabilidad/activos';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar() {
  revalidatePath('/contabilidad/activos', 'layout');
  revalidatePath('/contabilidad/cierre');
  revalidatePath('/aprobaciones');
}

export async function registrarActivoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_GESTIONAN_ACTIVOS);
    id = await conUsuario(u.id, (tx) => registrarActivoApertura(tx, u, {
      descripcion: texto(fd, 'descripcion'), categoriaId: texto(fd, 'categoria_id'), fechaAdquisicion: texto(fd, 'fecha_adquisicion'),
      ubicacion: texto(fd, 'ubicacion'), responsable: texto(fd, 'responsable'), costoVes: texto(fd, 'costo_ves'), costoUsd: texto(fd, 'costo_usd'),
      residualVes: texto(fd, 'residual_ves'), residualUsd: texto(fd, 'residual_usd'), mesesDepreciados: Number(texto(fd, 'meses') || 0),
      depAperturaVes: texto(fd, 'dep_ves'), depAperturaUsd: texto(fd, 'dep_usd'),
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/contabilidad/activos/${id}`);
}

export async function confirmarVidaUtilAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_ACTIVOS);
    await conUsuario(u.id, (tx) => confirmarVidaUtil(tx, u, texto(fd, 'id'), Number(texto(fd, 'vida'))));
    recargar();
    return { ok: 'Vida útil confirmada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function depreciarMesAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_ACTIVOS);
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(texto(fd, 'periodo'));
    if (!m) return { error: 'Indique un mes válido.' };
    const r = await conUsuario(u.id, (tx) => depreciarMes(tx, u, Number(m[1]), Number(m[2])));
    recargar();
    return { ok: `Depreciados ${r.activos} activos: Bs ${r.totalVes} (US$ ${r.totalUsd}). Asiento ${r.asiento}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function solicitarBajaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_ACTIVOS);
    await conUsuario(u.id, (tx) => solicitarBaja(tx, u, { activoId: texto(fd, 'activo_id'), fecha: texto(fd, 'fecha'), motivo: texto(fd, 'motivo') }));
    recargar();
    return { ok: 'Baja solicitada: queda pendiente de Gerencia.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function decidirActivoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();      // quién decide lo determina el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    const tipo = texto(fd, 'tipo') === 'baja' ? 'baja_activo_fijo' : 'activo_fijo';
    if (!UUID.test(id)) return { error: 'Documento inválido.' };
    const aprobar = texto(fd, 'decision') === 'aprobada';
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, tipo, id, u.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? undefined : { comentario: texto(fd, 'motivo') }));
    recargar();
    return { ok: aprobar ? 'Aprobado y contabilizado.' : 'Rechazado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
