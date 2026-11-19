'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';

export async function guardarProntoPagoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('gerencia');
    const id = texto(fd, 'id');
    const porcentaje = texto(fd, 'porcentaje').replace(',', '.');
    const dias = texto(fd, 'dias');
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return { error: 'Condición de pago inválida.' };
    if (porcentaje || dias) {
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(porcentaje) || Number(porcentaje) <= 0 || Number(porcentaje) > 100) {
        return { error: 'Indique un porcentaje entre 0,01 y 100.' };
      }
      if (!/^\d{1,3}$/.test(dias) || Number(dias) > 365) return { error: 'Indique un plazo entre 0 y 365 días.' };
    }
    const { rows } = await conUsuario(u.id, (tx) => tx.query(
      `update condicion_pago set descuento_pronto_pago_pct = $2, dias_pronto_pago = $3
        where id = $1 and activa returning id`, [id, porcentaje || null, dias || null]));
    if (!rows.length) return { error: 'La condición de pago ya no está activa.' };
    revalidatePath('/configuracion/pronto-pago');
    return { ok: 'Configuración guardada para las próximas facturas.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
