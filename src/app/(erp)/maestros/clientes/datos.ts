import 'server-only';
import type { Opcion } from '@/components/formulario-cliente';
import type { Db } from '@/lib/db';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function opcionesComerciales(db: Db): Promise<{ sucursales: Opcion[]; vendedores: Opcion[] }> {
  const [s, v] = await Promise.all([
    db.query<Opcion>(`select id, nombre from sucursal where activa order by nombre`),
    db.query<Opcion>(`select id, codigo || ' · ' || nombre as nombre from vendedor where estado = 'activo' order by codigo`),
  ]);
  return { sucursales: s.rows, vendedores: v.rows };
}

export async function condicionesDePago(db: Db): Promise<Opcion[]> {
  const { rows } = await db.query<Opcion>(`select id, nombre from condicion_pago where activa order by dias, nombre`);
  return rows;
}
