'use server';

import { revalidatePath } from 'next/cache';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import {
  anularAdjunto, guardarAdjunto, MAX_BYTES_ADJUNTO, puedeAgregarAdjuntos, puedeVerAdjuntos, TIPOS_ADJUNTABLES, type TipoAdjuntable,
} from '@/lib/adjuntos/adjuntos';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { ErrorPermiso, obtenerUsuario } from '@/lib/auth/dal';
import { conUsuario, getDb } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUTA: Record<Exclude<TipoAdjuntable, 'transporte_parada'>, string> = { cliente: 'clientes', proveedor: 'proveedores', producto: 'productos' };

/** Página que muestra el adjunto: la del registro, o el transporte al que pertenece la parada. */
async function rutaDe(tipo: TipoAdjuntable, entidadId: string): Promise<string> {
  if (tipo !== 'transporte_parada') return `/maestros/${RUTA[tipo]}/${entidadId}`;
  const { rows } = await (await getDb()).query<{ transporte_id: string }>('select transporte_id from transporte_parada where id = $1', [entidadId]);
  return `/ventas/transportes/${rows[0]?.transporte_id ?? ''}`;
}

async function sesion() {
  const u = await obtenerUsuario();
  if (!u || u.debeCambiarPassword) throw new ErrorPermiso('Su sesión venció. Vuelva a iniciar sesión.');
  return u;
}

const tipoDe = (fd: FormData) => {
  const t = texto(fd, 'tipo');
  return (TIPOS_ADJUNTABLES as readonly string[]).includes(t) ? (t as TipoAdjuntable) : null;
};

export async function subirAdjuntoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await sesion();
    const tipo = tipoDe(fd);
    const entidadId = texto(fd, 'entidad_id');
    if (!tipo || !UUID.test(entidadId)) return { error: 'Registro inválido.' };
    if (!(await puedeAgregarAdjuntos(await getDb(), u, tipo, entidadId))) throw new ErrorPermiso('No tiene permiso para adjuntar archivos aquí.');

    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Seleccione el archivo (PDF, PNG, JPG o WebP).' };
    if (archivo.size > MAX_BYTES_ADJUNTO) return { error: `El archivo no puede pasar de ${MAX_BYTES_ADJUNTO / 1024 / 1024} MB.` };

    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const almacen = almacenEnDisco();
    await conUsuario(u.id, (tx) => guardarAdjunto(tx, almacen, u.id, { tipo, entidadId, nombre: archivo.name, bytes, descripcion: texto(fd, 'descripcion') }));
    revalidatePath(await rutaDe(tipo, entidadId));
    return { ok: 'Archivo adjuntado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularAdjuntoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await sesion();
    const tipo = tipoDe(fd);
    const entidadId = texto(fd, 'entidad_id');
    const id = texto(fd, 'id');
    if (!tipo || !UUID.test(entidadId) || !UUID.test(id)) return { error: 'Adjunto inválido.' };
    if (!(await puedeVerAdjuntos(await getDb(), u, tipo, entidadId))) throw new ErrorPermiso('No tiene permiso para esta operación.');
    await conUsuario(u.id, (tx) => anularAdjunto(tx, id, u.id, texto(fd, 'motivo')));
    revalidatePath(await rutaDe(tipo, entidadId));
    return { ok: 'Adjunto anulado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
