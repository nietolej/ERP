import { ErrorPermiso } from '@/lib/auth/dal';
import { ErrorContable } from '@/lib/contabilidad/motor';
import { ErrorMaestro } from '@/lib/maestros/clientes';

/** Resultado que las acciones de servidor devuelven a los formularios. */
export type EstadoAccion = { ok?: string; error?: string; confirmar?: boolean } | undefined;

/**
 * Traduce un error a un mensaje para el usuario.
 * - Las reglas de la base (RAISE EXCEPTION, código P0001) ya vienen redactadas en español.
 * - Errores desconocidos: mensaje genérico; el detalle va al registro del servidor, no a la pantalla.
 */
export function mensajeDeError(e: unknown): string {
  if (e instanceof ErrorPermiso || e instanceof ErrorContable || e instanceof ErrorMaestro) return e.message;
  const err = e as { code?: string; message?: string };
  if (err?.code === 'P0001' && err.message) return err.message;
  if (err?.code === '23505') return 'Ya existe un registro con esos datos.';
  if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') {
    return 'Algún dato no tiene el formato correcto.';
  }
  console.error(e);
  return 'No se pudo completar la operación. Intente de nuevo o avise al administrador.';
}

/** Texto de un campo de formulario, recortado ('' si no viene). */
export function texto(fd: FormData, nombre: string): string {
  const v = fd.get(nombre);
  return typeof v === 'string' ? v.trim() : '';
}
