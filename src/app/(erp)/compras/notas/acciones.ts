'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar, autorizarSesion } from '@/lib/auth/dal';
import { ROLES_REGISTRAN_NOTA_PROVEEDOR, crearNota, type ClaseNota, type TipoNota } from '@/lib/compras/notas-proveedor';
import { conUsuario } from '@/lib/db';
import { resolverAprobacion } from '@/lib/flujo/objetos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPOS: Record<string, { tipo: TipoNota; clase: ClaseNota }> = {
  'nota_credito:devolucion': { tipo: 'nota_credito', clase: 'devolucion' },
  'nota_credito:ajuste_precio': { tipo: 'nota_credito', clase: 'ajuste_precio' },
  'nota_debito:ajuste_precio': { tipo: 'nota_debito', clase: 'ajuste_precio' },
};

function recargar(id?: string) {
  revalidatePath('/compras/notas');
  revalidatePath('/compras/cuentas-por-pagar');
  revalidatePath('/compras/facturas');
  revalidatePath('/inventario/existencias');
  if (id) revalidatePath(`/compras/notas/${id}`);
}

export async function crearNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_REGISTRAN_NOTA_PROVEEDOR);
    const facturaId = texto(fd, 'factura_id');
    if (!UUID.test(facturaId)) return { error: 'Seleccione la factura.' };
    const t = TIPOS[texto(fd, 'tipo_clase')];
    if (!t) return { error: 'Seleccione el tipo de nota.' };
    const lineas = fd.getAll('linea').map(String).filter((l) => UUID.test(l)).map((facturaLineaId) => {
      const valor = texto(fd, `valor_${facturaLineaId}`);
      return t.clase === 'devolucion' ? { facturaLineaId, cantidad: valor } : { facturaLineaId, monto: valor };
    });
    const r = await conUsuario(u.id, (tx) => crearNota(tx, u, {
      facturaId, ...t, numeroDocumento: texto(fd, 'numero_documento'), numeroControl: texto(fd, 'numero_control'), fecha: texto(fd, 'fecha'),
      motivo: texto(fd, 'motivo'), lineas,
    }));
    id = r.id;
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  recargar();
  redirect(`/compras/notas/${id}`);
}

export async function aprobarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion(); // quién aprueba lo decide el motor de aprobaciones (§4.5)
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Nota inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'nota_proveedor', id, u.id, 'aprobada'));
    recargar(id);
    return { ok: 'Nota aprobada y contabilizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function rechazarNotaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizarSesion();
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Nota inválida.' };
    await conUsuario(u.id, (tx) => resolverAprobacion(tx, 'nota_proveedor', id, u.id, 'rechazada', { comentario: texto(fd, 'motivo') }));
    recargar(id);
    return { ok: 'Nota rechazada. No se movió nada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
