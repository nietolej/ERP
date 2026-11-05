'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { CargaRevertida, MAX_BYTES_CARGA, ROLES_CARGAN_PRODUCTOS, cargarProductos, type ResultadoCarga } from '@/lib/maestros/carga-productos';

function informe(r: ResultadoCarga, aplicar: boolean): EstadoAccion {
  if (r.errores.length) {
    const lista = r.errores.slice(0, 40).map((e) => `Fila ${e.fila}${e.codigo ? ` (${e.codigo})` : ''}: ${e.mensaje}`).join('\n');
    const mas = r.errores.length > 40 ? `\n… y ${r.errores.length - 40} errores más.` : '';
    return { error: `Se rechaza la carga completa: ${r.errores.length} de ${r.filas} filas tienen errores. No se creó nada.\n${lista}${mas}` };
  }
  return aplicar
    ? { ok: `${r.creados} productos creados.` }
    : { ok: `Las ${r.filas} filas están bien: se crearían ${r.creados} productos. Todavía no se guardó nada; use «Cargar» para crearlos.` };
}

/** Valida o carga el CSV (campo `modo`: «validar» o «cargar»). Todo o nada: con un error no se crea nada. */
export async function cargarProductosAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_CARGAN_PRODUCTOS);
    const archivo = fd.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) return { error: 'Seleccione el archivo CSV con el formato de la plantilla.' };
    if (archivo.size > MAX_BYTES_CARGA) return { error: 'El archivo no puede pasar de 5 MB.' };
    const contenido = new TextDecoder('utf-8').decode(new Uint8Array(await archivo.arrayBuffer()));
    const aplicar = texto(fd, 'modo') === 'cargar';
    try {
      const r = await conUsuario(u.id, (tx) => cargarProductos(tx, u, contenido, aplicar, hoyCaracas()));
      revalidatePath('/maestros/productos');
      return informe(r, aplicar);
    } catch (e) {
      if (e instanceof CargaRevertida) return informe(e.resultado, aplicar);
      throw e;
    }
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
