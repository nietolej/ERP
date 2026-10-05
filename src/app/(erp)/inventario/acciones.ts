'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import {
  ROLES_AJUSTAN, crearAjuste, eliminarBorrador, enviarAjuste, guardarLinea, quitarLinea,
} from '@/lib/inventario/ajustes';
import { productoPorCodigo } from '@/lib/ventas/pedidos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(id: string) {
  revalidatePath('/inventario/ajustes');
  revalidatePath(`/inventario/ajustes/${id}`);
  revalidatePath('/inventario/existencias');
}

export async function crearAjusteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_AJUSTAN);
    const almacenId = texto(fd, 'almacen_id');
    const contado = texto(fd, 'contado_por');
    if (!UUID.test(almacenId)) return { error: 'Seleccione el almacén.' };
    id = await conUsuario(u.id, (tx) => crearAjuste(tx, u, {
      almacenId, observaciones: texto(fd, 'observaciones'), contadoPorId: UUID.test(contado) ? contado : undefined,
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/inventario/ajustes');
  redirect(`/inventario/ajustes/${id}`);
}

export async function guardarLineaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_AJUSTAN);
    const id = texto(fd, 'id');
    const motivo = texto(fd, 'motivo_id');
    if (!UUID.test(id)) return { error: 'Ajuste inválido.' };
    await conUsuario(u.id, async (tx) => {
      const productoId = await productoPorCodigo(tx, texto(fd, 'codigo'));
      await guardarLinea(tx, u, id, {
        productoId, cantidadContada: texto(fd, 'contada'), motivoId: UUID.test(motivo) ? motivo : undefined,
        costoUnitario: texto(fd, 'costo') || undefined,
      });
    });
    recargar(id);
    return { ok: 'Conteo registrado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function quitarLineaAjusteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_AJUSTAN);
    const id = texto(fd, 'id');
    const linea = texto(fd, 'linea_id');
    if (!UUID.test(id) || !UUID.test(linea)) return { error: 'Línea inválida.' };
    await conUsuario(u.id, (tx) => quitarLinea(tx, u, id, linea));
    recargar(id);
    return { ok: 'Línea quitada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function enviarAjusteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_AJUSTAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Ajuste inválido.' };
    await conUsuario(u.id, (tx) => enviarAjuste(tx, u, id));
    recargar(id);
    return { ok: 'Ajuste enviado a aprobación de Gerencia.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function eliminarAjusteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_AJUSTAN);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Ajuste inválido.' };
    await conUsuario(u.id, (tx) => eliminarBorrador(tx, u, id));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/inventario/ajustes');
  redirect('/inventario/ajustes');
}

export async function aprobarAjusteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Ajuste inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Ajuste aprobado: la existencia y la contabilidad ya reflejan las diferencias.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarAjusteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Ajuste inválido.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Ajuste rechazado. No se movió nada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
