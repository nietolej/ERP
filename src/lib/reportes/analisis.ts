import type { Db } from '@/lib/db/tipos';
import { condicion, type Condicion, type FiltroClientes } from './clientes';

/**
 * M7 · Análisis Avanzado (spec_reportes §14). Las definiciones salen de las vistas de la migración 0036
 * (vw_pedido_morosidad, vw_quiebre_episodio) y de los parámetros de `parametro_reporte`: aquí solo se agrupan.
 * Pedidos y morosidad usan los filtros de M1 (años, incluir inactivos, vendedor por seguridad por fila) más
 * sucursal, zona y búsqueda de cliente. Los quiebres usan año, grupo de producto y almacén.
 */

export interface FiltroPedidos extends FiltroClientes {
  sucursalId?: string;
  zona?: string;
  /** Búsqueda por código o nombre del cliente. */
  texto?: string;
}

/** Filtros comunes de pedidos y morosidad: `d` = vw_pedido_morosidad. Une vendedor, cliente y tercero. */
function condicionPedidos(f: FiltroPedidos): Condicion {
  const c = condicion({ ...f, clienteId: undefined }, 'd.fecha', 1, 'd.cliente_id');
  const params = [...c.params];
  const extra: string[] = [];
  let n = params.length + 1;
  if (f.sucursalId) { extra.push(`d.sucursal_id = $${n++}`); params.push(f.sucursalId); }
  if (f.zona) { extra.push(`cl.zona = $${n++}`); params.push(f.zona); }
  const texto = (f.texto ?? '').trim();
  if (texto) {
    extra.push(`(cl.codigo ilike '%' || $${n} || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($${n}) || '%')`);
    params.push(texto); n++;
  }
  const base = c.sql || 'where true';
  return { sql: [base, ...extra].join(' and '), params };
}

const DESDE_PEDIDOS = `from vw_pedido_morosidad d join vendedor v on v.id = d.vendedor_id
                       join cliente cl on cl.tercero_id = d.cliente_id join tercero t on t.id = d.cliente_id`;

const pct = (parte: number, total: number): number | null => (total > 0 ? (parte / total) * 100 : null);

/** Zonas con clientes, para el selector de filtro. */
export async function zonasDisponibles(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ zona: string }>(
    `select distinct trim(zona) as zona from cliente where zona is not null and trim(zona) <> '' order by 1`);
  return rows.map((r) => r.zona);
}

/** Sucursales, para el selector de filtro. */
export async function sucursalesDisponibles(db: Db): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>('select id, nombre from sucursal order by nombre');
  return rows;
}

// ---------------------------------------------------------------------
// §14.1 Histograma de pedidos
// ---------------------------------------------------------------------

export interface TramoPedido {
  indice: number; etiqueta: string; desdeUsd: number; hastaUsd: number | null;
  pedidos: number; pct: number | null; montoUsd: string; promedioUsd: string | null;
}
export interface HistogramaPedidos { tramoUsd: number; topeUsd: number; totalPedidos: number; filas: TramoPedido[]; }

const usd = (v: number) => `$${v.toLocaleString('es-VE', { maximumFractionDigits: 2 })}`;

/** Etiquetas de los tramos con el ancho y el tope vigentes (siempre todos, aunque estén vacíos). */
export function tramosDePedido(tramoUsd: number, topeUsd: number): { indice: number; etiqueta: string; desdeUsd: number; hastaUsd: number | null }[] {
  const abierto = Math.ceil(topeUsd / tramoUsd);
  const filas = [];
  for (let i = 0; i < abierto; i++) {
    filas.push({ indice: i, etiqueta: `${usd(i * tramoUsd)} – ${usd((i + 1) * tramoUsd)}`, desdeUsd: i * tramoUsd, hastaUsd: (i + 1) * tramoUsd });
  }
  filas.push({ indice: abierto, etiqueta: `Más de ${usd(abierto * tramoUsd)}`, desdeUsd: abierto * tramoUsd, hastaUsd: null });
  return filas;
}

async function parametrosHistograma(db: Db): Promise<{ tramo: number; tope: number }> {
  const { rows } = await db.query<{ tramo: string; tope: string }>(
    `select fn_parametro_reporte('HISTOGRAMA_PEDIDOS_TRAMO_USD')::text as tramo, fn_parametro_reporte('HISTOGRAMA_PEDIDOS_TOPE_USD')::text as tope`);
  return { tramo: Number(rows[0].tramo), tope: Number(rows[0].tope) };
}

/** Cantidad y monto de pedidos (facturas) por tramo de monto (§14.1). */
export async function histogramaPedidos(db: Db, f: FiltroPedidos = {}): Promise<HistogramaPedidos> {
  const { tramo, tope } = await parametrosHistograma(db);
  const c = condicionPedidos(f);
  const { rows } = await db.query<{ tramo: number; pedidos: string; monto: string }>(
    `select d.tramo, count(*)::text as pedidos, sum(d.base_usd)::numeric(16,2)::text as monto ${DESDE_PEDIDOS} ${c.sql} group by d.tramo`, c.params);
  const total = rows.reduce((s, r) => s + Number(r.pedidos), 0);
  return {
    tramoUsd: tramo, topeUsd: tope, totalPedidos: total,
    filas: tramosDePedido(tramo, tope).map((t) => {
      const r = rows.find((x) => x.tramo === t.indice);
      const pedidos = r ? Number(r.pedidos) : 0;
      return {
        ...t, pedidos, pct: pct(pedidos, total), montoUsd: r?.monto ?? '0.00',
        promedioUsd: r && pedidos > 0 ? (Number(r.monto) / pedidos).toFixed(2) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------
// §14.2 Patrones de morosidad
// ---------------------------------------------------------------------

export type OrdenMorosidad = 'tramo' | 'mora' | 'dias';
export interface FilaMorosidad {
  tramo: number; etiqueta: string; diasCredito: number; facturas: number;
  /** Días de pago promedio ponderado por monto (§2); null si todavía no hay cobros en la celda. */
  diasPago: number | null; enMora: number; moraPct: number | null; deudaUsd: string;
  /** El % de mora llega al umbral relevante (MOROSIDAD_PATRON_PCT). */
  marcada: boolean;
}
export interface Morosidad { umbralPct: number; filas: FilaMorosidad[]; }

/**
 * Tramo de monto × días de crédito (§14.2). Los días de crédito son los congelados en cada factura (decisión 17).
 * Orden: por tramo y plazo (por defecto), por % de mora o por días de pago, de mayor a menor.
 */
export async function patronesMorosidad(db: Db, f: FiltroPedidos = {}, orden: OrdenMorosidad = 'tramo'): Promise<Morosidad> {
  const { tramo, tope } = await parametrosHistograma(db);
  const { rows: par } = await db.query<{ umbral: string }>(`select fn_parametro_reporte('MOROSIDAD_PATRON_PCT')::text as umbral`);
  const umbral = Number(par[0].umbral);
  const etiquetas = tramosDePedido(tramo, tope);
  const c = condicionPedidos(f);
  const { rows } = await db.query<{
    tramo: number; dias_credito: number; facturas: string; cobrado: string; ponderado: string; mora: string; deuda: string;
  }>(
    `select d.tramo, d.dias_credito, count(*)::text as facturas, sum(d.cobrado_usd)::text as cobrado, sum(d.dias_ponderados)::text as ponderado,
            count(*) filter (where d.en_mora)::text as mora, coalesce(sum(d.saldo_usd), 0)::numeric(16,2)::text as deuda
       ${DESDE_PEDIDOS} ${c.sql} group by d.tramo, d.dias_credito order by d.tramo, d.dias_credito`, c.params);
  const filas: FilaMorosidad[] = rows.map((r) => {
    const facturas = Number(r.facturas);
    const mora = Number(r.mora);
    const moraPct = pct(mora, facturas);
    return {
      tramo: r.tramo, etiqueta: etiquetas[r.tramo]?.etiqueta ?? String(r.tramo), diasCredito: r.dias_credito, facturas,
      diasPago: Number(r.cobrado) > 0 ? Number(r.ponderado) / Number(r.cobrado) : null,
      enMora: mora, moraPct, deudaUsd: r.deuda, marcada: moraPct !== null && moraPct >= umbral,
    };
  });
  if (orden === 'mora') filas.sort((a, b) => (b.moraPct ?? -1) - (a.moraPct ?? -1));
  else if (orden === 'dias') filas.sort((a, b) => (b.diasPago ?? -1) - (a.diasPago ?? -1));
  return { umbralPct: umbral, filas };
}

// ---------------------------------------------------------------------
// §14.3 y §14.4 Episodios de quiebre
// ---------------------------------------------------------------------

export interface FiltroQuiebres {
  anios?: number[];
  grupoId?: string;
  almacenId?: string;
}

function condicionQuiebres(f: FiltroQuiebres): Condicion {
  const partes: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  if (f.anios && f.anios.length > 0) { partes.push(`extract(year from e.inicio)::int = any($${n++})`); params.push(f.anios); }
  if (f.grupoId) { partes.push(`p.grupo_id = $${n++}`); params.push(f.grupoId); }
  if (f.almacenId) { partes.push(`e.almacen_id = $${n++}`); params.push(f.almacenId); }
  return { sql: partes.length > 0 ? `where ${partes.join(' and ')}` : '', params };
}

const DESDE_EPISODIOS = `from vw_quiebre_episodio e join producto p on p.id = e.producto_id join almacen a on a.id = e.almacen_id`;

/** Años con al menos un episodio de quiebre, para el selector de año. */
export async function aniosConQuiebres(db: Db): Promise<number[]> {
  const { rows } = await db.query<{ anio: number }>('select distinct extract(year from inicio)::int as anio from vw_quiebre_episodio order by 1 desc');
  return rows.map((r) => r.anio);
}

export async function gruposDisponibles(db: Db): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>('select id, codigo || \' · \' || nombre as nombre from grupo_producto order by codigo');
  return rows;
}

export async function almacenesDisponibles(db: Db): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>(
    `select id, codigo || ' · ' || nombre as nombre from almacen where permite_venta order by codigo`);
  return rows;
}

export interface FilaVelocidadQuiebre {
  productoId: string; codigo: string; descripcion: string; almacen: string; inicio: string; reposicion: string | null; duracionDias: number;
  velocidadAntes: string; velocidadDespues: string | null; variacionPct: number | null;
}
export interface VelocidadQuiebre { ventanaDias: number; filas: FilaVelocidadQuiebre[]; }

/** Velocidad de venta antes del quiebre y después de la reposición, por episodio (§14.3). Orden: variación % descendente. */
export async function velocidadTrasQuiebre(db: Db, f: FiltroQuiebres = {}): Promise<VelocidadQuiebre> {
  const { rows: par } = await db.query<{ v: string }>(`select fn_parametro_reporte('VENTANA_VELOCIDAD_QUIEBRE_DIAS')::text as v`);
  const c = condicionQuiebres(f);
  const { rows } = await db.query<{
    producto_id: string; codigo: string; descripcion: string; almacen: string; inicio: string; reposicion: string | null; duracion: number;
    antes: string; despues: string | null; variacion: string | null;
  }>(
    `select e.producto_id, p.codigo, p.descripcion, a.codigo || ' · ' || a.nombre as almacen, e.inicio::text, e.reposicion::text, e.duracion_dias as duracion,
            e.velocidad_antes::text as antes, e.velocidad_despues::text as despues, e.variacion_pct::text as variacion
       ${DESDE_EPISODIOS} ${c.sql}
      order by e.variacion_pct desc nulls last, e.inicio desc limit 500`, c.params);
  return {
    ventanaDias: Number(par[0].v),
    filas: rows.map((r) => ({
      productoId: r.producto_id, codigo: r.codigo, descripcion: r.descripcion, almacen: r.almacen, inicio: r.inicio, reposicion: r.reposicion,
      duracionDias: r.duracion, velocidadAntes: r.antes, velocidadDespues: r.despues, variacionPct: r.variacion === null ? null : Number(r.variacion),
    })),
  };
}

export type OrdenQuiebres = 'episodios' | 'duracion' | 'venta_perdida';
export interface FilaQuiebreProducto {
  productoId: string; codigo: string; descripcion: string; episodios: number; duracionTotalDias: number; duracionPromedioDias: number;
  ventaPerdidaUsd: string;
}

/** Quiebres por producto: episodios, duración y venta perdida acumulada (§14.4). */
export async function quiebresPorProducto(db: Db, f: FiltroQuiebres = {}, orden: OrdenQuiebres = 'episodios'): Promise<FilaQuiebreProducto[]> {
  const c = condicionQuiebres(f);
  const claves: Record<OrdenQuiebres, string> = { episodios: 'count(*)', duracion: 'sum(e.duracion_dias)', venta_perdida: 'sum(e.venta_perdida_usd)' };
  const { rows } = await db.query<{ producto_id: string; codigo: string; descripcion: string; episodios: string; total: string; promedio: string; perdida: string }>(
    `select e.producto_id, p.codigo, p.descripcion, count(*)::text as episodios, sum(e.duracion_dias)::text as total,
            avg(e.duracion_dias)::numeric(10,1)::text as promedio, coalesce(sum(e.venta_perdida_usd), 0)::numeric(16,2)::text as perdida
       ${DESDE_EPISODIOS} ${c.sql}
      group by e.producto_id, p.codigo, p.descripcion order by ${claves[orden]} desc, p.codigo limit 500`, c.params);
  return rows.map((r) => ({
    productoId: r.producto_id, codigo: r.codigo, descripcion: r.descripcion, episodios: Number(r.episodios), duracionTotalDias: Number(r.total),
    duracionPromedioDias: Number(r.promedio), ventaPerdidaUsd: r.perdida,
  }));
}

export interface PuntoQuiebreMensual { anio: number; mes: number; episodios: number; }

/** Cantidad de episodios que empezaron en cada mes (§14.4), solo los meses con episodios. */
export async function quiebresPorMes(db: Db, f: FiltroQuiebres = {}): Promise<PuntoQuiebreMensual[]> {
  const c = condicionQuiebres(f);
  const { rows } = await db.query<{ anio: number; mes: number; episodios: string }>(
    `select extract(year from e.inicio)::int as anio, extract(month from e.inicio)::int as mes, count(*)::text as episodios
       ${DESDE_EPISODIOS} ${c.sql} group by 1, 2 order by 1, 2`, c.params);
  return rows.map((r) => ({ anio: r.anio, mes: r.mes, episodios: Number(r.episodios) }));
}
