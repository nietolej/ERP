import { crearOrden, guardarLinea, type Usuario } from '@/lib/compras/ordenes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { validarPeriodo } from '@/lib/inventario/disponibilidad';

/**
 * M6 · Inventario (spec_reportes §9). Los indicadores de rotación salen de fn_disponibilidad (migración 0027): aquí se
 * agregan por grupo, se valoran al costo promedio y se cruzan con lo pendiente de recibir. Lo pendiente en producción
 * no existe todavía (no hay órdenes de producción): el sugerido solo descuenta el tránsito.
 */

export interface TarjetasInventario {
  /** Σ existencia (todos los almacenes) × costo promedio (§9). */
  capitalInmovilizadoUsd: string;
  /** Σ venta perdida estimada por producto en el periodo. */
  ventaPerdidaUsd: string;
}

export async function tarjetasInventario(db: Db, desde: string, hasta: string): Promise<TarjetasInventario> {
  validarPeriodo(desde, hasta);
  const { rows: cap } = await db.query<{ capital: string }>(
    `select coalesce(sum(e.cantidad * pc.costo_promedio_usd), 0)::numeric(18,2)::text as capital
       from existencia e join producto_costo pc on pc.producto_id = e.producto_id where e.cantidad > 0`);
  const { rows: vp } = await db.query<{ perdida: string }>(
    'select coalesce(sum(venta_perdida_usd), 0)::numeric(18,2)::text as perdida from fn_disponibilidad($1::date, $2::date)', [desde, hasta]);
  return { capitalInmovilizadoUsd: cap[0].capital, ventaPerdidaUsd: vp[0].perdida };
}

export interface PuntoValorizacion { mes: string; almacen: string; valorUsd: string; }

/**
 * Valorización mensual (§9): valor al costo del inventario al cierre de cada uno de los últimos `meses` meses, por almacén.
 * Sale del kardex: cada movimiento guarda su costo con el signo de su cantidad, así que la suma acumulada es el valor.
 */
export async function valorizacionMensual(db: Db, meses = 12): Promise<PuntoValorizacion[]> {
  const n = Math.min(Math.max(Math.trunc(meses), 1), 36);
  const { rows } = await db.query<{ mes: string; almacen: string; valor: string }>(
    `with hoy as (select ((now() at time zone 'America/Caracas')::date) as d),
          mes as (select (date_trunc('month', hoy.d) - make_interval(months => g))::date as ini from hoy, generate_series(0, $1::int - 1) g),
          valor as (
            select to_char(m.ini, 'YYYY-MM') as mes, a.codigo || ' · ' || a.nombre as almacen,
                   coalesce(sum(mi.costo_total_usd), 0)::numeric(18,2) as valor
              from mes m cross join almacen a
              left join movimiento_inventario mi on mi.almacen_id = a.id
                   and (mi.fecha at time zone 'America/Caracas')::date < (m.ini + interval '1 month')::date
             group by m.ini, a.id, a.codigo, a.nombre)
     select mes, almacen, valor::text from valor
      where almacen in (select almacen from valor group by almacen having bool_or(valor <> 0))
      order by mes, almacen`, [n]);
  return rows.map((r) => ({ mes: r.mes, almacen: r.almacen, valorUsd: r.valor }));
}

export interface FilaSugerido {
  productoId: string; codigo: string; descripcion: string; stock: string; transito: string; velocidadAjustada: string;
  /** Demanda del horizonte: velocidad ajustada × días de cobertura. */
  demanda: string; sugerido: number;
}

export interface SugeridoCompra { diasCobertura: number; filas: FilaSugerido[]; }

/**
 * Sugerido de compra (§9.1): max(0, ⌈velocidad ajustada × días de cobertura − (stock comercial + tránsito)⌉), con la
 * velocidad vigente (vw_disponibilidad). Tránsito = lo ordenado y no recibido en órdenes de compra aprobadas.
 * Solo se listan los productos con sugerido mayor que cero, del mayor al menor.
 */
export async function sugeridoCompra(db: Db, f: { texto?: string } = {}): Promise<SugeridoCompra> {
  const texto = (f.texto ?? '').trim();
  const { rows: par } = await db.query<{ dias: string }>("select fn_parametro_inventario('DIAS_COBERTURA_COMPRA')::text as dias");
  const dias = Number(par[0].dias);
  const { rows } = await db.query<{
    producto_id: string; codigo: string; descripcion: string; stock: string; transito: string; velocidad: string; demanda: string; sugerido: string;
  }>(
    `with transito as (
       select l.producto_id, sum(greatest(l.cantidad - fn_orden_linea_recibida(l.id), 0)) as cantidad
         from documento_compra_linea l join documento_compra d on d.id = l.documento_id
        where d.tipo = 'orden_compra' and d.estado = 'aprobada' group by l.producto_id)
     select v.producto_id, v.codigo, v.descripcion, v.stock_comercial::text as stock, coalesce(t.cantidad, 0)::text as transito,
            v.velocidad_ajustada::text as velocidad, (v.velocidad_ajustada * $1::numeric)::numeric(16,2)::text as demanda,
            ceil(v.velocidad_ajustada * $1::numeric - (v.stock_comercial + coalesce(t.cantidad, 0)))::text as sugerido
       from vw_disponibilidad v left join transito t on t.producto_id = v.producto_id
      where v.velocidad_ajustada > 0
        and ceil(v.velocidad_ajustada * $1::numeric - (v.stock_comercial + coalesce(t.cantidad, 0))) > 0
        and ($2 = '' or v.codigo ilike '%' || $2 || '%' or fn_nombre_normalizado(v.descripcion) like '%' || fn_nombre_normalizado($2) || '%')
      order by ceil(v.velocidad_ajustada * $1::numeric - (v.stock_comercial + coalesce(t.cantidad, 0))) desc, v.codigo
      limit 500`, [dias, texto]);
  return {
    diasCobertura: dias,
    filas: rows.map((r) => ({
      productoId: r.producto_id, codigo: r.codigo, descripcion: r.descripcion, stock: r.stock, transito: r.transito,
      velocidadAjustada: r.velocidad, demanda: r.demanda, sugerido: Number(r.sugerido),
    })),
  };
}

export interface FilaSaludGrupo {
  grupoId: string | null; codigo: string | null; nombre: string; items: number; capitalUsd: string;
  enQuiebre: number; enSobrestock: number; ventaPerdidaUsd: string;
}

/** Salud por grupo (§9.2): ítems, capital inmovilizado, ítems en quiebre y sobrestock, y venta perdida. Orden: venta perdida. */
export async function saludPorGrupo(db: Db, desde: string, hasta: string): Promise<FilaSaludGrupo[]> {
  validarPeriodo(desde, hasta);
  const { rows } = await db.query<{
    id: string | null; codigo: string | null; nombre: string | null; items: string; capital: string; quiebre: string; sobre: string; perdida: string;
  }>(
    `with cap as (
       select e.producto_id, sum(e.cantidad) * pc.costo_promedio_usd as capital
         from existencia e join producto_costo pc on pc.producto_id = e.producto_id where e.cantidad > 0 group by e.producto_id, pc.costo_promedio_usd)
     select g.id, g.codigo, g.nombre, count(*)::text as items, coalesce(sum(cap.capital), 0)::numeric(18,2)::text as capital,
            count(*) filter (where d.estado_salud = 'RIESGO_QUIEBRE')::text as quiebre,
            count(*) filter (where d.estado_salud = 'SOBRESTOCK')::text as sobre,
            coalesce(sum(d.venta_perdida_usd), 0)::numeric(18,2)::text as perdida
       from fn_disponibilidad($1::date, $2::date) d
       join producto p on p.id = d.producto_id
       left join grupo_producto g on g.id = p.grupo_id
       left join cap on cap.producto_id = d.producto_id
      group by g.id, g.codigo, g.nombre
      order by coalesce(sum(d.venta_perdida_usd), 0) desc, g.codigo nulls last`, [desde, hasta]);
  return rows.map((r) => ({
    grupoId: r.id, codigo: r.codigo, nombre: r.nombre ?? 'Sin grupo', items: Number(r.items), capitalUsd: r.capital,
    enQuiebre: Number(r.quiebre), enSobrestock: Number(r.sobre), ventaPerdidaUsd: r.perdida,
  }));
}

/**
 * "Crear orden de compra" desde el sugerido (§9.2): arma un borrador en USD con las líneas seleccionadas, a su costo
 * promedio como precio de referencia. Compras revisa precios, medidas y proveedor antes de enviarla a aprobación.
 */
export async function crearOrdenDesdeSugerido(
  tx: Db, u: Usuario, d: { proveedorId: string; almacenId: string; lineas: { productoId: string; cantidad: string }[] },
): Promise<string> {
  if (d.lineas.length === 0) throw new ErrorMaestro('Seleccione al menos un producto del sugerido.');
  const id = await crearOrden(tx, u, {
    proveedorId: d.proveedorId, almacenId: d.almacenId, moneda: 'USD', observaciones: 'Creada desde el sugerido de compra (M6).',
  });
  for (const l of d.lineas) {
    const { rows } = await tx.query<{ costo: string }>(
      'select coalesce((select costo_promedio_usd from producto_costo where producto_id = $1), 0)::numeric(16,4)::text as costo', [l.productoId]);
    await guardarLinea(tx, id, { productoId: l.productoId, cantidad: l.cantidad, precio: rows[0].costo });
  }
  return id;
}
