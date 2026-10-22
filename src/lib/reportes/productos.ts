import type { Db } from '@/lib/db/tipos';

/**
 * M2 · Productos, pestaña "Catálogo de artículos" (spec_reportes §5.1). Reusa vw_venta_linea y
 * vw_nota_credito_linea (§2, §12: misma definición de venta y devolución que en M1 Clientes).
 * El costo promedio sale de producto_costo (§8.2 de la especificación principal), nunca de una lista de precios.
 */

export interface FiltroProductos {
  /** Años a sumar en unidades vendidas / monto / devolución; vacío = todo el histórico. */
  anios?: number[];
  texto?: string;
  limite?: number;
}

export interface FilaCatalogoProducto {
  id: string;
  codigo: string;
  descripcion: string;
  grupo: string | null;
  marca: string | null;
  precioAUsd: string | null;
  precioDUsd: string | null;
  costoPromedioUsd: string;
  stock: string;
  unidadesVendidas: string;
  ventaUsd: string;
  devolucionUsd: string;
}

const HOY = `((now() at time zone 'America/Caracas')::date)`;

export async function catalogoProductos(db: Db, f: FiltroProductos = {}): Promise<FilaCatalogoProducto[]> {
  const texto = (f.texto ?? '').trim();
  const anios = f.anios && f.anios.length > 0 ? f.anios : null;
  const { rows } = await db.query<{
    id: string; codigo: string; descripcion: string; grupo: string | null; marca: string | null;
    precio_a: string | null; precio_d: string | null; costo: string; stock: string; unidades: string; venta: string; devolucion: string;
  }>(
    `with venta as (
       select producto_id, sum(cantidad)::numeric(16,4) as unidades, sum(base_usd)::numeric(16,2) as monto
         from vw_venta_linea
        where ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by producto_id
     ), devol as (
       select producto_id, sum(base_usd)::numeric(16,2) as monto
         from vw_nota_credito_linea
        where motivo_nc = 'devolucion' and ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by producto_id
     ), stock as (
       select e.producto_id, sum(e.cantidad)::numeric(14,4) as total
         from existencia e join almacen a on a.id = e.almacen_id and a.permite_venta
        group by e.producto_id
     )
     select p.id, p.codigo, p.descripcion, g.nombre as grupo, m.nombre as marca,
            fn_precio(p.id, 'A', ${HOY})::text as precio_a, fn_precio(p.id, 'D', ${HOY})::text as precio_d,
            coalesce(pc.costo_promedio_usd, 0::numeric(16,4))::text as costo,
            coalesce(stock.total, 0::numeric(14,4))::text as stock,
            coalesce(venta.unidades, 0::numeric(16,4))::text as unidades, coalesce(venta.monto, 0::numeric(16,2))::text as venta,
            coalesce(devol.monto, 0::numeric(16,2))::text as devolucion
       from producto p
       left join grupo_producto g on g.id = p.grupo_id
       left join marca m on m.id = p.marca_id
       left join producto_costo pc on pc.producto_id = p.id
       left join stock on stock.producto_id = p.id
       left join venta on venta.producto_id = p.id
       left join devol on devol.producto_id = p.id
      where p.estado = 'activo'
        and ($2 = '' or p.codigo ilike '%' || $2 || '%' or fn_nombre_normalizado(p.descripcion) like '%' || fn_nombre_normalizado($2) || '%')
      order by p.codigo
      limit $3`,
    [anios, texto, Math.min(Math.max(f.limite ?? 100, 1), 1000)]);
  return rows.map((r) => ({
    id: r.id, codigo: r.codigo, descripcion: r.descripcion, grupo: r.grupo, marca: r.marca,
    precioAUsd: r.precio_a, precioDUsd: r.precio_d, costoPromedioUsd: r.costo, stock: r.stock,
    unidadesVendidas: r.unidades, ventaUsd: r.venta, devolucionUsd: r.devolucion,
  }));
}
