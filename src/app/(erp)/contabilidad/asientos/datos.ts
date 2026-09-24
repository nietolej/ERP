import 'server-only';
import type { CuentaOpcion } from '@/components/formulario-asiento';
import type { Db } from '@/lib/db';

/** Cuentas que aceptan asientos manuales: imputables, activas y no controladas por un auxiliar. */
export async function cuentasParaManual(db: Db): Promise<CuentaOpcion[]> {
  const { rows } = await db.query<CuentaOpcion>(
    `select id, codigo, nombre from cuenta_contable
      where imputable and activa and controlada_por is null
      order by string_to_array(codigo, '.')::int[]`);
  return rows;
}

export async function monedasActivas(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ codigo: string }>(
    `select codigo from moneda where activa order by case codigo when 'VES' then 0 when 'USD' then 1 else 2 end, codigo`);
  return rows.map((r) => r.codigo);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
