'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { ROLES_COMPRAN } from '@/lib/compras/ordenes';
import { conUsuario } from '@/lib/db';
import { crearOrdenDesdeSugerido } from '@/lib/reportes/inventario';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Crea un borrador de orden de compra con las líneas marcadas del sugerido (cada una con su cantidad editada). */
export async function crearOrdenDesdeSugeridoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let id: string;
  try {
    const u = await autorizar(...ROLES_COMPRAN);
    const lineas = fd.getAll('producto').map(String).filter((p) => UUID.test(p)).map((p) => ({ productoId: p, cantidad: texto(fd, `cantidad_${p}`) }));
    id = await conUsuario(u.id, (tx) => crearOrdenDesdeSugerido(tx, u, {
      proveedorId: texto(fd, 'proveedor_id'), almacenId: texto(fd, 'almacen_id'), lineas,
    }));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/compras/ordenes');
  redirect(`/compras/ordenes/${id}`);
}
