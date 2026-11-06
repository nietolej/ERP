'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { ROLES_PROPONEN_REVALUACION, proponerRevaluacion } from '@/lib/contabilidad/revaluacion';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mesDe(fd: FormData): { anio: number; mes: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(texto(fd, 'periodo'));
  const mes = m ? Number(m[2]) : 0;
  return m && mes >= 1 && mes <= 12 ? { anio: Number(m[1]), mes } : null;
}

function recargar() {
  revalidatePath('/contabilidad/revaluacion');
  revalidatePath('/contabilidad/cierre');
  revalidatePath('/aprobaciones');
}

export async function proponerRevaluacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_PROPONEN_REVALUACION);
    const p = mesDe(fd);
    if (!p) return { error: 'Indique un mes válido.' };
    await conUsuario(u.id, (tx) => proponerRevaluacion(tx, u, p.anio, p.mes));
    recargar();
    return { ok: 'Revaluación propuesta: queda pendiente del Jefe de contabilidad.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function decidirRevaluacionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();       // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Revaluación inválida.' };
    const aprobar = texto(fd, 'decision') === 'aprobada';
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'revaluacion_cambiaria', id, u.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? undefined : { comentario: texto(fd, 'motivo') }));
    recargar();
    return { ok: aprobar ? 'Revaluación aprobada: quedó contabilizada con su reverso del primer día del mes siguiente.' : 'Revaluación rechazada: se puede proponer de nuevo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
