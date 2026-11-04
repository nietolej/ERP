'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM = /^\d{1,8}([.,]\d{1,4})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: string) => v.replace(',', '.');

/** Tarifa de ISLR de un concepto (Decreto 1.808, art. 9), con vigencia. La carga Contabilidad: la normativa no se precarga. */
export async function crearTarifaIslr(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const conceptoId = texto(fd, 'concepto_id');
    const tipo = texto(fd, 'tipo_persona');
    const pct = texto(fd, 'porcentaje');
    const minimo = texto(fd, 'base_minima_ut') || '0';
    const sustraendo = texto(fd, 'sustraendo_ut') || '0';
    const desde = texto(fd, 'vigente_desde');
    if (!UUID.test(conceptoId)) return { error: 'Seleccione el concepto.' };
    if (tipo !== 'N' && tipo !== 'J') return { error: 'Seleccione el tipo de persona.' };
    if (!NUM.test(pct) || Number(num(pct)) <= 0 || Number(num(pct)) > 100) return { error: 'El porcentaje debe ser mayor que cero y no pasar de 100.' };
    if (!NUM.test(minimo) || !NUM.test(sustraendo)) return { error: 'El mínimo y el sustraendo se escriben en Unidades Tributarias, con hasta 4 decimales.' };
    if (!FECHA.test(desde)) return { error: 'Indique desde cuándo rige la tarifa.' };
    await conUsuario(u.id, (tx) => tx.query(
      `insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, base_minima_ut, sustraendo_ut, vigente_desde, fuente_normativa)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
      [conceptoId, tipo, texto(fd, 'domiciliado') === '1', num(pct), num(minimo), num(sustraendo), desde, texto(fd, 'fuente_normativa') || null]));
    revalidatePath('/configuracion/conceptos-islr');
    return { ok: 'Tarifa registrada. Queda pendiente de validación del contador.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cerrarTarifaIslr(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const id = texto(fd, 'id');
    const hasta = texto(fd, 'vigente_hasta');
    if (!UUID.test(id)) return { error: 'Tarifa inválida.' };
    if (!FECHA.test(hasta)) return { error: 'Indique hasta cuándo rige la tarifa.' };
    await conUsuario(u.id, (tx) => tx.query('update concepto_islr_tarifa set vigente_hasta = $2::date where id = $1', [id, hasta]));
    revalidatePath('/configuracion/conceptos-islr');
    return { ok: 'Vigencia cerrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function validarTarifaIslr(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Tarifa inválida.' };
    await conUsuario(u.id, (tx) => tx.query('update concepto_islr_tarifa set validado_por_contador = true where id = $1', [id]));
    revalidatePath('/configuracion/conceptos-islr');
    return { ok: 'Tarifa validada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
