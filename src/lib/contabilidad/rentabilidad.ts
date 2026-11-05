import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Rentabilidad por dimensión (spec §12.5; migración 0052). Una sola fuente: vw_rentabilidad_linea, en USD (gestión).
 *
 *   venta neta = venta − devoluciones − descuentos posteriores (notas de crédito) − pronto pago
 *   margen     = venta neta − costo (foto del costo de cada línea; la devolución resta el costo que reingresa)
 *   margen %   = margen ÷ venta neta
 *
 * La venta ya viene neta de los descuentos de línea, que se muestran aparte. Las comisiones se restarán cuando exista su devengo.
 */

export const ROLES_VEN_RENTABILIDAD = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];

export const DIMENSIONES = ['cliente', 'producto', 'grupo', 'marca', 'vendedor', 'sucursal'] as const;
export type Dimension = (typeof DIMENSIONES)[number];
export const NOMBRE_DIMENSION: Record<Dimension, string> = {
  cliente: 'Cliente', producto: 'Producto', grupo: 'Grupo de producto', marca: 'Marca', vendedor: 'Vendedor', sucursal: 'Sucursal',
};

/** Cómo se llega al código y al nombre de cada dimensión desde la columna de la vista. */
const DEF: Record<Dimension, { col: string; join: string; codigo: string; nombre: string }> = {
  cliente: { col: 'cliente_id', join: 'join cliente c on c.tercero_id = r.cliente_id join tercero t on t.id = c.tercero_id', codigo: 'c.codigo', nombre: 't.razon_social' },
  producto: { col: 'producto_id', join: 'join producto x on x.id = r.producto_id', codigo: 'x.codigo', nombre: 'x.descripcion' },
  grupo: { col: 'grupo_id', join: 'left join grupo_producto x on x.id = r.grupo_id', codigo: "coalesce(x.codigo, '—')", nombre: "coalesce(x.nombre, 'Sin grupo')" },
  marca: { col: 'marca_id', join: 'left join marca x on x.id = r.marca_id', codigo: "coalesce(x.codigo, '—')", nombre: "coalesce(x.nombre, 'Sin marca')" },
  vendedor: { col: 'vendedor_id', join: 'left join vendedor x on x.id = r.vendedor_id', codigo: "coalesce(x.codigo, '—')", nombre: "coalesce(x.nombre, 'Sin vendedor')" },
  sucursal: { col: 'sucursal_id', join: 'left join sucursal x on x.id = r.sucursal_id', codigo: "coalesce(x.codigo, '—')", nombre: "coalesce(x.nombre, 'Sin sucursal')" },
};

export interface Cifras {
  ventaUsd: Decimal; descuentoLineaUsd: Decimal; devolucionUsd: Decimal; descuentoPosteriorUsd: Decimal; prontoPagoUsd: Decimal;
  ventaNetaUsd: Decimal; costoUsd: Decimal; margenUsd: Decimal;
  /** null si no hay venta neta (no se divide entre cero). */
  margenPct: string | null;
}
export interface FilaRentabilidad extends Cifras { codigo: string; nombre: string }

interface Cruda { venta: string; desc_linea: string; devolucion: string; desc_post: string; pronto: string; costo: string }

/** Las cifras derivadas (venta neta, margen y %) se calculan aquí una sola vez, con decimales exactos. */
export function cifrasDe(c: Cruda): Cifras {
  const d = (v: string) => new Decimal(v);
  const ventaNetaUsd = d(c.venta).minus(c.devolucion).minus(c.desc_post).minus(c.pronto);
  const costoUsd = d(c.costo);
  const margenUsd = ventaNetaUsd.minus(costoUsd);
  return {
    ventaUsd: d(c.venta), descuentoLineaUsd: d(c.desc_linea), devolucionUsd: d(c.devolucion), descuentoPosteriorUsd: d(c.desc_post), prontoPagoUsd: d(c.pronto),
    ventaNetaUsd, costoUsd, margenUsd, margenPct: ventaNetaUsd.isZero() ? null : margenUsd.dividedBy(ventaNetaUsd).times(100).toFixed(2),
  };
}

const SUMAS = `coalesce(sum(r.venta_usd), 0)::text as venta, coalesce(sum(r.descuento_linea_usd), 0)::text as desc_linea, coalesce(sum(r.devolucion_usd), 0)::text as devolucion,
               coalesce(sum(r.descuento_posterior_usd), 0)::text as desc_post, coalesce(sum(r.pronto_pago_usd), 0)::text as pronto, coalesce(sum(r.costo_usd), 0)::text as costo`;

function validar(desde: string, hasta: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new ErrorMaestro('Indique un rango de fechas válido.');
  if (hasta < desde) throw new ErrorMaestro('La fecha final no puede ser anterior a la inicial.');
}

/** Margen por dimensión en [desde, hasta], de mayor a menor margen. Una dimensión con venta y sin margen (todo devuelto) también aparece. */
export async function rentabilidadPor(db: Db, dimension: Dimension, desde: string, hasta: string): Promise<FilaRentabilidad[]> {
  validar(desde, hasta);
  const def = DEF[dimension];
  if (!def) throw new ErrorMaestro('Seleccione una dimensión válida.');
  const { rows } = await db.query<Cruda & { codigo: string; nombre: string }>(
    `select ${def.codigo} as codigo, ${def.nombre} as nombre, ${SUMAS}
       from vw_rentabilidad_linea r ${def.join}
      where r.fecha between $1::date and $2::date
      group by 1, 2`, [desde, hasta]);
  return rows.map((r) => ({ codigo: r.codigo, nombre: r.nombre, ...cifrasDe(r) }))
    .sort((a, b) => b.margenUsd.comparedTo(a.margenUsd) || a.codigo.localeCompare(b.codigo));
}

/** El total del periodo, igual a la suma de cualquier dimensión. */
export async function rentabilidadTotal(db: Db, desde: string, hasta: string): Promise<Cifras> {
  validar(desde, hasta);
  const { rows } = await db.query<Cruda>(`select ${SUMAS} from vw_rentabilidad_linea r where r.fecha between $1::date and $2::date`, [desde, hasta]);
  return cifrasDe(rows[0]);
}
