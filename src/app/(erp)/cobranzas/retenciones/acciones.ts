'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import { anularRetencion, registrarRetencion, ROLES_REGISTRAN_RETENCIONES, type Impuesto } from '@/lib/ventas/retenciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recargar() {
  revalidatePath('/cobranzas/retenciones');
  revalidatePath('/cobranzas/cuentas');
  revalidatePath('/fiscal/declaraciones');
}

export async function registrarRetencionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_RETENCIONES);
    const documentoId = texto(fd, 'documento_id');
    if (!UUID.test(documentoId)) return { error: 'Seleccione la factura o nota de débito retenida.' };
    const r = await conUsuario(u.id, (tx) => registrarRetencion(tx, u, {
      documentoId, impuesto: texto(fd, 'impuesto') as Impuesto, numeroComprobante: texto(fd, 'comprobante'),
      fechaComprobante: texto(fd, 'fecha'), base: texto(fd, 'base') || undefined, porcentaje: texto(fd, 'porcentaje'),
      monto: texto(fd, 'monto') || undefined, observaciones: texto(fd, 'observaciones'),
    }));
    recargar();
    return { ok: `Retención N° ${r.numero} registrada por Bs. ${r.monto}: la cuenta por cobrar del documento bajó en ese monto.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function anularRetencionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_REGISTRAN_RETENCIONES);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'La retención no existe.' };
    await conUsuario(u.id, (tx) => anularRetencion(tx, u, id, texto(fd, 'motivo')));
    recargar();
    return { ok: 'Retención anulada: el documento recuperó su saldo por cobrar.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
