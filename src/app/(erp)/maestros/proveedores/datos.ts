import 'server-only';
import type { Db } from '@/lib/db';
import { NOMBRE_TIPO_PROVEEDOR, TIPOS_PROVEEDOR } from '@/lib/maestros/proveedores';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TIPOS = TIPOS_PROVEEDOR.map((t) => ({ valor: t, nombre: NOMBRE_TIPO_PROVEEDOR[t] }));

/** Conceptos de ISLR activos, más el actual del proveedor aunque esté inactivo. */
export async function conceptosIslr(db: Db, incluir?: string | null): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>(
    `select id, codigo || ' · ' || descripcion as nombre from concepto_islr where activo or id = $1 order by codigo`,
    [incluir ?? null]);
  return rows;
}
