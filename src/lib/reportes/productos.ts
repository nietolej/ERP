import type { Db } from '@/lib/db/tipos';
import { variacion, type MetricaComparada } from '@/lib/reportes/clientes';

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

/**
 * Detalle de producto, pestaña "Vista general / anual" (§5.2). Los días de inventario y los días sin
 * inventario salen siempre de vw_disponibilidad (la ventana vigente, calculada con el kardex, §9) y no
 * dependen del año elegido para la venta: son el estado actual del producto, igual que la deuda de un
 * cliente nunca depende del año en M1.
 */

export interface TopClienteProducto {
  clienteId: string; codigo: string; razonSocial: string; cantidad: string; montoUsd: string; compras: number; ultimaCompra: string | null;
}

export interface DetalleProductoAnio {
  producto: { id: string; codigo: string; descripcion: string; grupo: string | null; marca: string | null };
  ventaTotalUsd: string;
  unidadesVendidas: string;
  pedidos: number;
  stockDisponible: string;
  diasInventario: string | null;
  diasSinInventario: number | null;
  tasaDevolucionPct: number | null;
  ratiosDevolucion: { montoPct: number | null; cantidadPct: number | null; pedidosPct: number | null };
  evolucionMensual: { mes: number; ventaUsd: string; devolucionUsd: string }[];
  topClientes: TopClienteProducto[];
}

export async function detalleProductoAnio(db: Db, codigo: string, anios: number[] = []): Promise<DetalleProductoAnio | null> {
  const { rows: prod } = await db.query<{ id: string; codigo: string; descripcion: string; grupo: string | null; marca: string | null }>(
    `select p.id, p.codigo, p.descripcion, g.nombre as grupo, m.nombre as marca
       from producto p left join grupo_producto g on g.id = p.grupo_id left join marca m on m.id = p.marca_id
      where p.codigo = $1`, [codigo]);
  if (!prod[0]) return null;
  const productoId = prod[0].id;
  const filtroAnio = anios.length > 0 ? 'extract(year from fecha)::int = any($2::int[])' : 'true';
  const params = anios.length > 0 ? [productoId, anios] : [productoId];

  const { rows: venta } = await db.query<{ venta: string; unidades: string; pedidos: string }>(
    `select coalesce(sum(base_usd), 0::numeric(16,2))::text as venta, coalesce(sum(cantidad), 0::numeric(16,4))::text as unidades,
            count(distinct documento_id)::text as pedidos
       from vw_venta_linea where producto_id = $1 and ${filtroAnio}`, params);
  const { rows: nc } = await db.query<{ devol_monto: string; devol_cantidad: string; devol_pedidos: string }>(
    `select coalesce(sum(base_usd) filter (where motivo_nc = 'devolucion'), 0::numeric(16,2))::text as devol_monto,
            coalesce(sum(cantidad) filter (where motivo_nc = 'devolucion'), 0::numeric(16,4))::text as devol_cantidad,
            count(distinct factura_id) filter (where motivo_nc = 'devolucion')::text as devol_pedidos
       from vw_nota_credito_linea where producto_id = $1 and ${filtroAnio}`, params);
  const { rows: stock } = await db.query<{ disponible: string }>(
    `select coalesce(sum(e.cantidad - e.reservado), 0::numeric(14,4))::text as disponible
       from existencia e join almacen a on a.id = e.almacen_id and a.permite_venta
      where e.producto_id = $1`, [productoId]);
  const { rows: disp } = await db.query<{ cobertura: string | null; dias_sin: number | null }>(
    `select cobertura_dias::text as cobertura, dias_sin_existencia as dias_sin from vw_disponibilidad where producto_id = $1`, [productoId]);

  const { rows: evVenta } = await db.query<{ mes: number; venta: string }>(
    `select extract(month from fecha)::int as mes, sum(base_usd)::numeric(16,2)::text as venta
       from vw_venta_linea where producto_id = $1 and ${filtroAnio} group by 1`, params);
  const { rows: evNc } = await db.query<{ mes: number; devolucion: string }>(
    `select extract(month from fecha)::int as mes, sum(base_usd)::numeric(16,2)::text as devolucion
       from vw_nota_credito_linea where producto_id = $1 and motivo_nc = 'devolucion' and ${filtroAnio} group by 1`, params);
  const ventaPorMes = Object.fromEntries(evVenta.map((r) => [r.mes, r.venta]));
  const devolPorMes = Object.fromEntries(evNc.map((r) => [r.mes, r.devolucion]));
  const evolucionMensual = Array.from({ length: 12 }, (_, i) => ({
    mes: i + 1, ventaUsd: ventaPorMes[i + 1] ?? '0.00', devolucionUsd: devolPorMes[i + 1] ?? '0.00',
  }));

  const { rows: top } = await db.query<{
    cliente_id: string; codigo: string; razon_social: string; cantidad: string; monto: string; compras: string; ultima: string | null;
  }>(
    `select l.cliente_id, c.codigo, t.razon_social, sum(l.cantidad)::numeric(16,4)::text as cantidad,
            sum(l.base_usd)::numeric(16,2)::text as monto, count(distinct l.documento_id)::text as compras, max(l.fecha)::text as ultima
       from vw_venta_linea l join cliente c on c.tercero_id = l.cliente_id join tercero t on t.id = c.tercero_id
      where l.producto_id = $1 and ${filtroAnio}
      group by l.cliente_id, c.codigo, t.razon_social
      order by sum(l.base_usd) desc
      limit 20`, params);

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);
  const ventaTotal = Number(venta[0].venta);
  const unidades = Number(venta[0].unidades);
  const pedidos = Number(venta[0].pedidos);
  const devolMonto = Number(nc[0].devol_monto);
  const devolCantidad = Number(nc[0].devol_cantidad);
  const devolPedidos = Number(nc[0].devol_pedidos);

  return {
    producto: prod[0],
    ventaTotalUsd: ventaTotal.toFixed(2), unidadesVendidas: venta[0].unidades, pedidos,
    stockDisponible: stock[0].disponible,
    diasInventario: disp[0]?.cobertura ?? null, diasSinInventario: disp[0]?.dias_sin ?? null,
    tasaDevolucionPct: pct(devolMonto, ventaTotal),
    ratiosDevolucion: { montoPct: pct(devolMonto, ventaTotal), cantidadPct: pct(devolCantidad, unidades), pedidosPct: pct(devolPedidos, pedidos) },
    evolucionMensual,
    topClientes: top.map((r) => ({
      clienteId: r.cliente_id, codigo: r.codigo, razonSocial: r.razon_social, cantidad: r.cantidad, montoUsd: r.monto,
      compras: Number(r.compras), ultimaCompra: r.ultima,
    })),
  };
}

export interface StockAlmacenProducto {
  almacenId: string; codigo: string; nombre: string; sucursal: string; cantidad: string; reservado: string; disponible: string; vendible: boolean;
}

/** Pestaña "Stock por almacén" (§5.2): existencia del producto en cada almacén activo, con si es vendible. */
export async function stockPorAlmacen(db: Db, productoId: string): Promise<StockAlmacenProducto[]> {
  const { rows } = await db.query<{
    almacen_id: string; codigo: string; nombre: string; sucursal: string; cantidad: string; reservado: string; vendible: boolean;
  }>(
    `select a.id as almacen_id, a.codigo, a.nombre, s.nombre as sucursal,
            coalesce(e.cantidad, 0::numeric(14,4))::text as cantidad, coalesce(e.reservado, 0::numeric(14,4))::text as reservado,
            a.permite_venta as vendible
       from almacen a
       join sucursal s on s.id = a.sucursal_id
       left join existencia e on e.almacen_id = a.id and e.producto_id = $1
      where a.activo
      order by s.nombre, a.codigo`, [productoId]);
  return rows.map((r) => ({
    almacenId: r.almacen_id, codigo: r.codigo, nombre: r.nombre, sucursal: r.sucursal,
    cantidad: r.cantidad, reservado: r.reservado, disponible: (Number(r.cantidad) - Number(r.reservado)).toFixed(4), vendible: r.vendible,
  }));
}

const NOMBRE_TIPO_MOVIMIENTO: Record<string, string> = {
  entrada_compra: 'Entrada por compra', salida_venta: 'Salida por venta', devolucion_cliente: 'Devolución de cliente',
  devolucion_proveedor: 'Devolución a proveedor', transferencia_salida: 'Transferencia (salida)',
  transferencia_entrada: 'Transferencia (entrada)', ajuste_positivo: 'Ajuste positivo', ajuste_negativo: 'Ajuste negativo',
  consumo_produccion: 'Consumo de producción', entrada_produccion: 'Entrada de producción', apertura: 'Apertura',
};

export interface MovimientoKardex {
  id: string; fecha: string; tipo: string; almacenCodigo: string; documento: string; cantidad: string; stockAlmacen: string; stockTotal: string;
}

/**
 * Pestaña "Movimientos" (§5.2): kardex del producto, en orden cronológico, con el stock por almacén y el
 * stock total progresivos (sumas acumuladas sobre el mismo orden). El documento se resuelve según el tipo
 * de origen del movimiento (recepción, nota de entrega, nota de crédito o ajuste de inventario).
 */
export async function kardexProducto(db: Db, productoId: string): Promise<MovimientoKardex[]> {
  const { rows } = await db.query<{
    id: string; fecha: string; tipo: string; almacen_codigo: string; documento: string; cantidad: string; stock_almacen: string; stock_total: string;
  }>(
    `select m.id::text, m.fecha::text, m.tipo, a.codigo as almacen_codigo,
            case m.origen_tipo
              when 'recepcion' then coalesce(dc.serie || '-' || dc.numero::text, 'Recepción (sin número)')
              when 'nota_entrega' then coalesce(dv1.serie || '-' || dv1.numero::text, 'Nota de entrega')
              when 'nota_credito' then coalesce(dv2.serie || '-' || dv2.numero::text, 'Nota de crédito')
              when 'ajuste_inventario' then coalesce('AJ-' || ai.numero::text, 'Ajuste (sin número)')
              else m.origen_tipo
            end as documento,
            m.cantidad::text,
            sum(m.cantidad) over (partition by m.almacen_id order by m.fecha, m.id)::text as stock_almacen,
            sum(m.cantidad) over (order by m.fecha, m.id)::text as stock_total
       from movimiento_inventario m
       join almacen a on a.id = m.almacen_id
       left join documento_compra dc on m.origen_tipo = 'recepcion' and dc.id = m.origen_id
       left join documento_venta dv1 on m.origen_tipo = 'nota_entrega' and dv1.id = m.origen_id
       left join documento_venta dv2 on m.origen_tipo = 'nota_credito' and dv2.id = m.origen_id
       left join ajuste_inventario ai on m.origen_tipo = 'ajuste_inventario' and ai.id = m.origen_id
      where m.producto_id = $1
      order by m.fecha, m.id`, [productoId]);
  return rows.map((r) => ({
    id: r.id, fecha: r.fecha, tipo: NOMBRE_TIPO_MOVIMIENTO[r.tipo] ?? r.tipo, almacenCodigo: r.almacen_codigo,
    documento: r.documento, cantidad: r.cantidad, stockAlmacen: r.stock_almacen, stockTotal: r.stock_total,
  }));
}

export interface ComparativaMultianualProducto {
  anioA: number; anioB: number;
  venta: MetricaComparada; cantidad: MetricaComparada; pedidos: MetricaComparada; devolucion: MetricaComparada;
  mensual: { mes: number; ventaA: string; ventaB: string }[];
}

/** Pestaña "Comparativa multianual" (§5.2): año A contra año B, con barras mensuales lado a lado. */
export async function comparativaMultianual(db: Db, productoId: string, anioA: number, anioB: number): Promise<ComparativaMultianualProducto> {
  const { rows: venta } = await db.query<{ anio: number; venta: string; cantidad: string; pedidos: string }>(
    `select extract(year from fecha)::int as anio, sum(base_usd)::numeric(16,2) as venta, sum(cantidad)::numeric(16,4) as cantidad,
            count(distinct documento_id) as pedidos
       from vw_venta_linea where producto_id = $1 and extract(year from fecha)::int = any($2::int[])
      group by 1`, [productoId, [anioA, anioB]]);
  const { rows: devol } = await db.query<{ anio: number; devolucion: string }>(
    `select extract(year from fecha)::int as anio, sum(base_usd)::numeric(16,2) as devolucion
       from vw_nota_credito_linea where producto_id = $1 and motivo_nc = 'devolucion' and extract(year from fecha)::int = any($2::int[])
      group by 1`, [productoId, [anioA, anioB]]);
  const { rows: mensual } = await db.query<{ anio: number; mes: number; venta: string }>(
    `select extract(year from fecha)::int as anio, extract(month from fecha)::int as mes, sum(base_usd)::numeric(16,2) as venta
       from vw_venta_linea where producto_id = $1 and extract(year from fecha)::int = any($2::int[])
      group by 1, 2`, [productoId, [anioA, anioB]]);

  const porAnio = (anio: number) => ({
    venta: Number(venta.find((r) => r.anio === anio)?.venta ?? 0),
    cantidad: Number(venta.find((r) => r.anio === anio)?.cantidad ?? 0),
    pedidos: Number(venta.find((r) => r.anio === anio)?.pedidos ?? 0),
    devolucion: Number(devol.find((r) => r.anio === anio)?.devolucion ?? 0),
  });
  const a = porAnio(anioA);
  const b = porAnio(anioB);
  const ventaMes = (anio: number, mes: number) => mensual.find((r) => r.anio === anio && r.mes === mes)?.venta ?? '0.00';

  return {
    anioA, anioB,
    venta: variacion(a.venta, b.venta), cantidad: variacion(a.cantidad, b.cantidad, 4),
    pedidos: variacion(a.pedidos, b.pedidos, 0), devolucion: variacion(a.devolucion, b.devolucion),
    mensual: Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, ventaA: ventaMes(anioA, i + 1), ventaB: ventaMes(anioB, i + 1) })),
  };
}
