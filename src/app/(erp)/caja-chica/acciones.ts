'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { anularVale, cambiarEstadoFondo, crearFondo, registrarVale, solicitarConstitucion, solicitarReposicion } from '@/lib/gastos/caja-chica';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar(fondoId?: string, reposicionId?: string) {
  revalidatePath('/caja-chica');
  revalidatePath('/tesoreria/cuentas');
  if (fondoId) revalidatePath(`/caja-chica/${fondoId}`);
  if (reposicionId) revalidatePath(`/caja-chica/reposiciones/${reposicionId}`);
}

export async function crearFondoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar('gerencia');
    const r = await conUsuario(u.id, (tx) => crearFondo(tx, u, {
      nombre: texto(fd, 'nombre'), custodioId: texto(fd, 'custodio_id'), cuentaBancariaId: texto(fd, 'cuenta_bancaria_id'),
      montoFijo: texto(fd, 'monto_fijo'), topeVale: texto(fd, 'tope_vale'),
    }));
    id = r.id;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/caja-chica/${id}`);
}

export async function estadoFondoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Fondo inválido.' };
    await conUsuario(u.id, (tx) => cambiarEstadoFondo(tx, u, id, texto(fd, 'activo') === '1'));
    recargar(id);
    return { ok: 'Fondo actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function solicitarConstitucionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let destino: string;
  try {
    const u = await autorizarSesion();
    const fondoId = texto(fd, 'fondo_id');
    if (!UUID.test(fondoId)) return { error: 'Fondo inválido.' };
    const r = await conUsuario(u.id, (tx) => solicitarConstitucion(tx, u, fondoId, texto(fd, 'cuenta_origen_id'), texto(fd, 'referencia')));
    recargar(fondoId);
    destino = `/caja-chica/reposiciones/${r.id}`;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  redirect(destino);
}

export async function solicitarReposicionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let destino: string;
  try {
    const u = await autorizarSesion();
    const fondoId = texto(fd, 'fondo_id');
    if (!UUID.test(fondoId)) return { error: 'Fondo inválido.' };
    const r = await conUsuario(u.id, (tx) => solicitarReposicion(tx, u, fondoId, texto(fd, 'cuenta_origen_id'), texto(fd, 'referencia')));
    recargar(fondoId);
    destino = `/caja-chica/reposiciones/${r.id}`;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  redirect(destino);
}

export async function registrarValeAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const fondoId = texto(fd, 'fondo_id');
    if (!UUID.test(fondoId)) return { error: 'Fondo inválido.' };
    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Adjunte el soporte del vale (PDF, PNG, JPG o WebP).' };
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const r = await conUsuario(u.id, (tx) => registrarVale(tx, u, {
      fondoId, fecha: texto(fd, 'fecha'), categoriaId: texto(fd, 'categoria_id'), beneficiario: texto(fd, 'beneficiario'), descripcion: texto(fd, 'descripcion'),
      comprobante: texto(fd, 'comprobante'), control: texto(fd, 'control'), base: texto(fd, 'base'), alicuotaIvaId: texto(fd, 'alicuota_iva_id'),
    }, { almacen: almacenEnDisco(), nombre: archivo.name, bytes }));
    recargar(fondoId);
    return { ok: `Vale ${r.numero} registrado. Asiento ${r.asiento}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularValeAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    const fondoId = texto(fd, 'fondo_id');
    if (!UUID.test(id) || !UUID.test(fondoId)) return { error: 'Vale inválido.' };
    await conUsuario(u.id, (tx) => anularVale(tx, u, id, texto(fd, 'motivo')));
    recargar(fondoId);
    return { ok: 'Vale anulado. El fondo recuperó el efectivo.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function aprobarReposicionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Solicitud inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'reposicion_caja', id, u.id, 'aprobada'));
    recargar(texto(fd, 'fondo_id'), id);
    return { ok: 'Aprobada y contabilizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarReposicionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Solicitud inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'reposicion_caja', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(texto(fd, 'fondo_id'), id);
    return { ok: 'Rechazada. No se movió nada y los vales vuelven a estar por reponer.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
