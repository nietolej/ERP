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

export type Agrupador = 'categoria' | 'codigo_comun';

export interface FilaGrupoProducto {
  id: string;
  codigo: string;
  nombre: string;
  totalArticulos: number;
  unidadesVendidas: string;
  ventaUsd: string;
  devolucionUsd: string;
  stockValorizadoUsd: string;
  productoLider: { codigo: string; descripcion: string } | null;
}

/**
 * Pestaña "Análisis por grupos/familias" (§5.1): por categoría (la "familia", árbol Frenos › Pastillas,
 * sin acumular hacia los nodos padres) o por código común (el mismo artículo en todas sus marcas).
 * Cada producto se agrega una sola vez con sus mismas fuentes (vw_venta_linea, vw_nota_credito_linea,
 * producto_costo), y el líder del grupo es el de mayor venta.
 */
export async function analisisGrupos(db: Db, agrupador: Agrupador, f: Omit<FiltroProductos, 'texto' | 'limite'> = {}): Promise<FilaGrupoProducto[]> {
  const anios = f.anios && f.anios.length > 0 ? f.anios : null;
  const porCategoria = agrupador === 'categoria';
  const { rows } = await db.query<{
    grupo_id: string; grupo_codigo: string; grupo_nombre: string; articulos: string; unidades: string; venta: string;
    devolucion: string; stock_valor: string; lider_codigo: string | null; lider_descripcion: string | null;
  }>(
    `with pcat as (
       select p.id as producto_id, p.codigo, p.descripcion,
              case when $1 then pb.categoria_id else p.producto_base_id end as grupo_id
         from producto p
         left join producto_base pb on pb.id = p.producto_base_id
        where p.estado = 'activo'
     ), venta as (
       select producto_id, sum(cantidad)::numeric(16,4) as unidades, sum(base_usd)::numeric(16,2) as monto
         from vw_venta_linea
        where ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))
        group by producto_id
     ), devol as (
       select n.producto_id, sum(n.base_usd)::numeric(16,2) as monto
         from vw_nota_credito_linea n
        where n.motivo_nc = 'devolucion' and ($2::int[] is null or extract(year from n.fecha)::int = any($2::int[]))
        group by n.producto_id
     ), stock as (
       select e.producto_id, sum(e.cantidad * coalesce(pc.costo_promedio_usd, 0))::numeric(18,2) as valor
         from existencia e
         join almacen a on a.id = e.almacen_id and a.permite_venta
         left join producto_costo pc on pc.producto_id = e.producto_id
        group by e.producto_id
     ), porProducto as (
       select pcat.grupo_id, pcat.producto_id, pcat.codigo, pcat.descripcion,
              coalesce(venta.unidades, 0::numeric(16,4)) as unidades, coalesce(venta.monto, 0::numeric(16,2)) as monto,
              coalesce(devol.monto, 0::numeric(16,2)) as devolucion, coalesce(stock.valor, 0::numeric(18,2)) as stock_valor
         from pcat
         left join venta on venta.producto_id = pcat.producto_id
         left join devol on devol.producto_id = pcat.producto_id
         left join stock on stock.producto_id = pcat.producto_id
     ), agregado as (
       select grupo_id, count(*) as articulos, sum(unidades) as unidades, sum(monto) as venta,
              sum(devolucion) as devolucion, sum(stock_valor) as stock_valor
         from porProducto
        group by grupo_id
     ), lider as (
       select distinct on (grupo_id) grupo_id, codigo, descripcion
         from porProducto
        order by grupo_id, monto desc, codigo
     )
     select coalesce(g.grupo_id::text, '—') as grupo_id,
            coalesce(case when $1 then cat.codigo else pb.codigo end, 'SIN_GRUPO') as grupo_codigo,
            coalesce(case when $1 then cat.nombre else pb.descripcion end, 'Sin categoría') as grupo_nombre,
            g.articulos::text as articulos, g.unidades::text as unidades, g.venta::text as venta,
            g.devolucion::text as devolucion, g.stock_valor::text as stock_valor,
            l.codigo as lider_codigo, l.descripcion as lider_descripcion
       from agregado g
       left join categoria_producto cat on cat.id = g.grupo_id and $1
       left join producto_base pb on pb.id = g.grupo_id and not $1
       left join lider l on l.grupo_id is not distinct from g.grupo_id
      order by g.venta desc`,
    [porCategoria, anios]);
  return rows.map((r) => ({
    id: r.grupo_id, codigo: r.grupo_codigo, nombre: r.grupo_nombre, totalArticulos: Number(r.articulos),
    unidadesVendidas: r.unidades, ventaUsd: r.venta, devolucionUsd: r.devolucion, stockValorizadoUsd: r.stock_valor,
    productoLider: r.lider_codigo ? { codigo: r.lider_codigo, descripcion: r.lider_descripcion! } : null,
  }));
}
