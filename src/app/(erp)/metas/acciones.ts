'use server';

import { revalidatePath } from 'next/cache';
import { readSheet } from 'read-excel-file/node';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import {
  aprobarLoteMetas, crearLoteMetas, leerFilasExcel, parsearMonto, rechazarLoteMetas, ROLES_APRUEBAN_METAS, ROLES_CARGAN_METAS,
  TIPOS_META, type FilaMeta, type TipoMeta,
} from '@/lib/maestros/metas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2 * 1024 * 1024;
const FILAS_NUEVAS = 10;

const resumen = (r: { version: number; filas: number }) =>
  `Lote v${r.version} creado con ${r.filas} ${r.filas === 1 ? 'meta' : 'metas'}. Queda pendiente de la aprobación de Gerencia.`;

export async function cargarExcelAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CARGAN_METAS);
    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Seleccione el archivo de Excel (.xlsx).' };
    if (!archivo.name.toLowerCase().endsWith('.xlsx')) return { error: 'El archivo debe ser de Excel (.xlsx).' };
    if (archivo.size > MAX_BYTES) return { error: 'El archivo no puede pasar de 2 MB.' };

    let datos: unknown[][];
    try {
      datos = (await readSheet(Buffer.from(await archivo.arrayBuffer()))) as unknown[][];
    } catch {
      return { error: 'No se pudo leer el archivo. Verifique que sea un .xlsx válido y no esté protegido con clave.' };
    }
    const filas = leerFilasExcel(datos);
    const r = await conUsuario(u.id, (tx) => crearLoteMetas(tx, u.id, 'excel', filas, archivo.name));
    revalidatePath('/metas');
    return { ok: resumen(r) };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** Captura manual: las metas vigentes cuyo monto cambió y las filas nuevas forman un lote pendiente. */
export async function guardarManualAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CARGAN_METAS);
    const filas: FilaMeta[] = [];

    const n = Math.min(Number(texto(fd, 'e_n')) || 0, 500);
    for (let i = 0; i < n; i++) {
      const [tipo, entidadId, anio, mes] = texto(fd, `e_clave_${i}`).split('|');
      const nuevo = texto(fd, `e_monto_${i}`);
      if (nuevo === '' || !(TIPOS_META as readonly string[]).includes(tipo)) continue;
      const original = parsearMonto(texto(fd, `e_orig_${i}`));
      if (parsearMonto(nuevo) === original) continue;
      filas.push({
        fila: i + 1, tipo: tipo as TipoMeta, entidadId: UUID.test(entidadId) ? entidadId : undefined,
        anio: Number(anio), mes: mes ? Number(mes) : null, monto: nuevo,
      });
    }

    for (let i = 0; i < FILAS_NUEVAS; i++) {
      const codigo = texto(fd, `n_codigo_${i}`);
      const monto = texto(fd, `n_monto_${i}`);
      const tipo = texto(fd, `n_tipo_${i}`);
      // Una fila sin código ni monto se toma como vacía (salvo la global, que no lleva código).
      if (monto === '' && codigo === '') continue;
      if (!(TIPOS_META as readonly string[]).includes(tipo)) return { error: `Fila nueva ${i + 1}: seleccione el tipo de meta.` };
      const mes = texto(fd, `n_mes_${i}`);
      filas.push({
        fila: n + i + 1, tipo: tipo as TipoMeta, referencia: codigo,
        anio: Number(texto(fd, `n_anio_${i}`)), mes: mes === '' ? null : Number(mes), monto,
      });
    }

    if (filas.length === 0) return { error: 'No hay cambios: modifique un monto o llene una fila nueva.' };
    const r = await conUsuario(u.id, (tx) => crearLoteMetas(tx, u.id, 'manual', filas));
    revalidatePath('/metas');
    return { ok: resumen(r) };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function aprobarLoteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_APRUEBAN_METAS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Lote inválido.' };
    await conUsuario(u.id, (tx) => aprobarLoteMetas(tx, id, u.id));
    revalidatePath('/metas');
    revalidatePath(`/metas/lote/${id}`);
    return { ok: 'Lote aprobado. Sus metas ya son las vigentes.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarLoteAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_APRUEBAN_METAS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Lote inválido.' };
    await conUsuario(u.id, (tx) => rechazarLoteMetas(tx, id, u.id, texto(fd, 'motivo')));
    revalidatePath('/metas');
    revalidatePath(`/metas/lote/${id}`);
    return { ok: 'Lote rechazado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
