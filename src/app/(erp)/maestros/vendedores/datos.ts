import 'server-only';
import type { OpcionSimple } from '@/components/formulario-vendedor';
import type { Db } from '@/lib/db';
import { NOMBRE_TIPO_VENDEDOR, TIPOS_VENDEDOR } from '@/lib/maestros/vendedores';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TIPOS = TIPOS_VENDEDOR.map((t) => ({ valor: t, nombre: NOMBRE_TIPO_VENDEDOR[t] }));

/** Sucursales activas y usuarios que pueden enlazarse (rol Ventas o Supervisor, sin otro vendedor). */
export async function opcionesVendedor(db: Db, vendedorId?: string): Promise<{ sucursales: OpcionSimple[]; usuarios: OpcionSimple[] }> {
  const [s, u] = await Promise.all([
    db.query<OpcionSimple>(`select id, nombre from sucursal where activa order by nombre`),
    db.query<OpcionSimple>(
      `select distinct u.id, u.nombre from usuario u join usuario_rol ur on ur.usuario_id = u.id
        where u.activo and ur.rol in ('ventas', 'supervisor_ventas')
          and not exists (select 1 from vendedor v where v.usuario_id = u.id and ($1::uuid is null or v.id <> $1::uuid))
        order by u.nombre`, [vendedorId ?? null]),
  ]);
  return { sucursales: s.rows, usuarios: u.rows };
}
