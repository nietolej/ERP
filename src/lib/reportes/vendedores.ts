import type { Db } from '@/lib/db/tipos';

/**
 * M3 · Vendedores, pestaña "Catálogo" (spec_reportes §6.1). Reusa vw_venta_documento y vw_nota_credito_linea
 * (§2, §12: misma venta y devolución de M1 Clientes y M2 Productos) y vw_meta_anual (§10 de metas).
 */

export type OrdenVendedores = 'venta' | 'facturas' | 'clientes';

export interface FiltroVendedores {
  anios?: number[];
  texto?: string;
  orden?: OrdenVendedores;
  incluirAdministrativos?: boolean;
}

export interface FilaCatalogoVendedor {
  id: string;
  codigo: string;
  nombre: string;
  contacto: string | null;
  clientesAtendidos: number;
  facturas: number;
  coberturaCarteraPct: number | null;
  concentracionTop3Pct: number | null;
  ventaTotalUsd: string;
  devolucionesPct: number | null;
  metaUsd: string | null;
  cumplimientoMetaPct: number | null;
}

const ORDEN_SQL: Record<OrdenVendedores, string> = {
  venta: 'venta desc', facturas: 'facturas desc', clientes: 'atendidos desc',
};

const HOY = `((now() at time zone 'America/Caracas')::date)`;

export async function catalogoVendedores(db: Db, f: FiltroVendedores = {}): Promise<FilaCatalogoVendedor[]> {
  const texto = (f.texto ?? '').trim();
  const anios = f.anios && f.anios.length > 0 ? f.anios : null;
  const anioActual = Number((await db.query<{ a: string }>(`select extract(year from ${HOY})::text as a`)).rows[0].a);
  const aniosMeta = f.anios && f.anios.length > 0 ? f.anios : [anioActual];
  const orden = ORDEN_SQL[f.orden ?? 'venta'];

  const { rows } = await db.query<{
    id: string; codigo: string; nombre: string; contacto: string | null; atendidos: string; facturas: string;
    asignados: string; top3: string; venta: string; devolucion: string; meta: string | null;
  }>(
    `with venta as (
       select vendedor_id, sum(base_usd)::numeric(16,2) as venta, count(*) as facturas, count(distinct cliente_id) as atendidos
         from vw_venta_documento
        where ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by vendedor_id
     ), devol as (
       select vendedor_id, sum(base_usd)::numeric(16,2) as devolucion
         from vw_nota_credito_linea
        where motivo_nc = 'devolucion' and ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by vendedor_id
     ), venta_cliente as (
       select vendedor_id, cliente_id, sum(base_usd) as venta
         from vw_venta_documento
        where ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by vendedor_id, cliente_id
     ), top3 as (
       select vendedor_id, sum(venta)::numeric(16,2) as top3
         from (select vendedor_id, venta, row_number() over (partition by vendedor_id order by venta desc) as rn from venta_cliente) x
        where rn <= 3
        group by vendedor_id
     ), asignados as (
       select vendedor_id, count(*) as asignados from cliente where estado = 'activo' and vendedor_id is not null group by vendedor_id
     ), meta as (
       select entidad_id as vendedor_id, sum(monto_usd)::numeric(16,2) as meta
         from vw_meta_anual where tipo = 'vendedor' and anio = any($2::int[]) group by entidad_id
     )
     select v.id, v.codigo, v.nombre, coalesce(u.email, t.email, t.telefono) as contacto,
            coalesce(venta.atendidos, 0)::text as atendidos, coalesce(venta.facturas, 0)::text as facturas,
            coalesce(asignados.asignados, 0)::text as asignados,
            coalesce(top3.top3, 0::numeric(16,2))::text as top3, coalesce(venta.venta, 0::numeric(16,2))::text as venta,
            coalesce(devol.devolucion, 0::numeric(16,2))::text as devolucion, meta.meta::text as meta
       from vendedor v
       left join usuario u on u.id = v.usuario_id
       left join tercero t on t.id = v.tercero_id
       left join venta on venta.vendedor_id = v.id
       left join devol on devol.vendedor_id = v.id
       left join top3 on top3.vendedor_id = v.id
       left join asignados on asignados.vendedor_id = v.id
       left join meta on meta.vendedor_id = v.id
      where v.estado = 'activo'
        and ($3::boolean or v.tipo in ('interno', 'externo'))
        and ($4 = '' or v.codigo ilike '%' || $4 || '%' or fn_nombre_normalizado(v.nombre) like '%' || fn_nombre_normalizado($4) || '%')
      order by ${orden}`,
    [anios, aniosMeta, Boolean(f.incluirAdministrativos), texto]);

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);
  return rows.map((r) => {
    const venta = Number(r.venta);
    const metaUsd = r.meta;
    return {
      id: r.id, codigo: r.codigo, nombre: r.nombre, contacto: r.contacto,
      clientesAtendidos: Number(r.atendidos), facturas: Number(r.facturas),
      coberturaCarteraPct: pct(Number(r.atendidos), Number(r.asignados)),
      concentracionTop3Pct: pct(Number(r.top3), venta),
      ventaTotalUsd: r.venta, devolucionesPct: pct(Number(r.devolucion), venta),
      metaUsd, cumplimientoMetaPct: metaUsd !== null && Number(metaUsd) > 0 ? (venta / Number(metaUsd)) * 100 : null,
    };
  });
}

export interface VendedorDetalle {
  id: string; codigo: string; nombre: string; contacto: string | null; tipo: string;
}

export async function vendedorPorCodigo(db: Db, codigo: string): Promise<VendedorDetalle | null> {
  const { rows } = await db.query<{ id: string; codigo: string; nombre: string; contacto: string | null; tipo: string }>(
    `select v.id, v.codigo, v.nombre, coalesce(u.email, t.email, t.telefono) as contacto, v.tipo
       from vendedor v left join usuario u on u.id = v.usuario_id left join tercero t on t.id = v.tercero_id
      where v.codigo = $1`, [codigo]);
  return rows[0] ?? null;
}

export interface InsightVendedor {
  tipo: 'mora' | 'deuda' | 'devolucion' | 'tendencia' | null;
  mensaje: string | null;
}

export interface PuntoVentaMetaVendedor { anio: number; mes: number; ventaUsd: string; metaUsd: string | null; }

export interface VistaGeneralVendedor {
  ventaTotalUsd: string;
  facturas: number;
  clientesAtendidos: number;
  pedidoPromedioUsd: string;
  metaUsd: string | null;
  cumplimientoMetaPct: number | null;
  devolucionesPct: number | null;
  insight: InsightVendedor;
  mensual: PuntoVentaMetaVendedor[];
}

const HOY_V = `((now() at time zone 'America/Caracas')::date)`;

/**
 * M3 · Vendedores, pestaña "Vista general / anual" del detalle de vendedor (spec_reportes §6.2). El panel de
 * insight reusa las mismas reglas y umbrales que M1 Clientes (§4.1), con el filtro de mora/deuda/devolución
 * aplicado a toda la cartera del vendedor en vez de a un solo cliente.
 */
export async function vistaGeneralVendedor(db: Db, vendedorId: string, anios: number[]): Promise<VistaGeneralVendedor> {
  const anioActual = Number((await db.query<{ a: string }>(`select extract(year from ${HOY_V})::text as a`)).rows[0].a);
  const diasTranscurridos = Number((await db.query<{ d: string }>(`select extract(doy from ${HOY_V})::text as d`)).rows[0].d);
  const aniosFiltro = anios.length > 0 ? anios : null;

  const { rows: venta } = await db.query<{ venta: string; facturas: string; atendidos: string }>(
    `select coalesce(sum(base_usd), 0)::numeric(16,2)::text as venta, count(*)::text as facturas,
            count(distinct cliente_id)::text as atendidos
       from vw_venta_documento
      where vendedor_id = $1 and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))`,
    [vendedorId, aniosFiltro]);
  const ventaTotal = Number(venta[0].venta);
  const facturas = Number(venta[0].facturas);

  const { rows: devol } = await db.query<{ devolucion: string }>(
    `select coalesce(sum(base_usd), 0)::numeric(16,2)::text as devolucion
       from vw_nota_credito_linea
      where vendedor_id = $1 and motivo_nc = 'devolucion' and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))`,
    [vendedorId, aniosFiltro]);
  const devolucionMonto = Number(devol[0].devolucion);

  const { rows: porAnio } = await db.query<{ anio: number; venta: string }>(
    `select extract(year from fecha)::int as anio, coalesce(sum(base_usd), 0)::numeric(16,2)::text as venta
       from vw_venta_documento
      where vendedor_id = $1 and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))
      group by 1`, [vendedorId, aniosFiltro]);
  let tendencia = 0;
  for (const r of porAnio) {
    const v = Number(r.venta);
    tendencia += r.anio === anioActual && diasTranscurridos > 0 ? (v * 365) / diasTranscurridos : v;
  }

  const aniosMeta = aniosFiltro ?? [anioActual];
  const { rows: meta } = await db.query<{ monto: string | null }>(
    `select sum(monto_usd)::text as monto from vw_meta_anual where tipo = 'vendedor' and entidad_id = $1 and anio = any($2::int[])`,
    [vendedorId, aniosMeta]);
  const metaUsd = meta[0]?.monto ?? null;

  const { rows: mora } = await db.query<{ n: string }>(
    `select count(*)::text as n from vw_cxc_antiguedad a join documento_venta f on f.id = a.documento_id
      where f.vendedor_id = $1 and a.dias_vencida > 0`, [vendedorId]);
  const { rows: cxc } = await db.query<{ deuda: string }>(
    `select coalesce(sum(a.saldo_usd), 0)::numeric(16,2)::text as deuda from vw_cxc_antiguedad a
       join documento_venta f on f.id = a.documento_id where f.vendedor_id = $1`, [vendedorId]);

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);
  const devolucionesPct = pct(devolucionMonto, ventaTotal);
  const cumplimientoMetaPct = metaUsd !== null && Number(metaUsd) > 0 ? (ventaTotal / Number(metaUsd)) * 100 : null;
  const cumplimientoTendenciaPct = metaUsd !== null && Number(metaUsd) > 0 ? (tendencia / Number(metaUsd)) * 100 : null;

  const umbralDevolucion = Number((await db.query<{ v: string }>("select fn_parametro_reporte('INSIGHT_DEVOLUCION_PCT')::text as v")).rows[0].v);
  const umbralTendencia = Number((await db.query<{ v: string }>("select fn_parametro_reporte('INSIGHT_CUMPLIMIENTO_TENDENCIA_PCT')::text as v")).rows[0].v);
  const partidasVencidas = Number(mora[0].n);
  const deudaActual = Number(cxc[0].deuda);

  let insight: InsightVendedor = { tipo: null, mensaje: null };
  if (partidasVencidas > 0) {
    insight = {
      tipo: 'mora',
      mensaje: `Su cartera tiene ${partidasVencidas} factura(s) en mora. Se recomienda contactar a esos clientes para cobranza.`,
    };
  } else if (deudaActual > 0) {
    insight = { tipo: 'deuda', mensaje: `Deuda activa de $${deudaActual.toFixed(2)} en su cartera. Monitorear fechas de vencimiento.` };
  } else if (devolucionesPct !== null && devolucionesPct > umbralDevolucion) {
    insight = { tipo: 'devolucion', mensaje: 'Investigar calidad de las ventas recientes.' };
  } else if (cumplimientoTendenciaPct !== null && cumplimientoTendenciaPct > umbralTendencia) {
    insight = { tipo: 'tendencia', mensaje: 'Considerar incentivo de volumen o asignación de nuevas cuentas clave.' };
  }

  const anioMensual = aniosFiltro ? Math.max(...aniosFiltro) : anioActual;
  const { rows: ventaMes } = await db.query<{ mes: number; venta: string }>(
    `select extract(month from fecha)::int as mes, coalesce(sum(base_usd), 0)::numeric(16,2)::text as venta
       from vw_venta_documento where vendedor_id = $1 and extract(year from fecha)::int = $2 group by 1`,
    [vendedorId, anioMensual]);
  const { rows: metaMes } = await db.query<{ mes: number; monto: string }>(
    `select mes, monto_usd::text as monto from vw_meta_periodo
      where tipo = 'vendedor' and entidad_id = $1 and anio = $2 and mes is not null`,
    [vendedorId, anioMensual]);
  const metaAnualUsd = (await db.query<{ monto: string | null }>(
    `select monto_usd::text as monto from vw_meta_anual where tipo = 'vendedor' and entidad_id = $1 and anio = $2`,
    [vendedorId, anioMensual])).rows[0]?.monto ?? null;

  const ventaPorMes = Object.fromEntries(ventaMes.map((r) => [r.mes, r.venta]));
  const metaPorMes = Object.fromEntries(metaMes.map((r) => [r.mes, r.monto]));
  const metaMensualReparto = metaMes.length === 0 && metaAnualUsd !== null ? (Number(metaAnualUsd) / 12).toFixed(2) : null;

  const mensual: PuntoVentaMetaVendedor[] = Array.from({ length: 12 }, (_, i) => {
    const mes = i + 1;
    return { anio: anioMensual, mes, ventaUsd: ventaPorMes[mes] ?? '0.00', metaUsd: metaPorMes[mes] ?? metaMensualReparto };
  });

  return {
    ventaTotalUsd: ventaTotal.toFixed(2), facturas, clientesAtendidos: Number(venta[0].atendidos),
    pedidoPromedioUsd: facturas > 0 ? (ventaTotal / facturas).toFixed(2) : '0.00',
    metaUsd, cumplimientoMetaPct, devolucionesPct, insight, mensual,
  };
}

export interface ClienteDormidoVendedor {
  id: string; codigo: string; nombre: string; ventaHistoricaUsd: string; ultimaCompra: string | null;
  diasSinComprar: number | null; enRiesgo: boolean;
}

export interface AnaliticaEstrategicaVendedor {
  coberturaCarteraPct: number | null;
  concentracionTop3Pct: number | null;
  ventaCruzada: number | null;
  tasaFugaPct: number | null;
  dormidos: ClienteDormidoVendedor[];
}

/**
 * M3 · Vendedores, pestaña "Analítica estratégica & cartera dormida" del detalle de vendedor (spec_reportes §6.2).
 * Cobertura y concentración top 3 reusan la misma fórmula del catálogo (§6.1). "Cartera dormida" son los clientes
 * asignados sin ninguna factura en el periodo filtrado; "días sin comprar" sale de su última compra histórica,
 * no de una estimación.
 */
export async function analiticaEstrategicaVendedor(db: Db, vendedorId: string, anios: number[]): Promise<AnaliticaEstrategicaVendedor> {
  const aniosFiltro = anios.length > 0 ? anios : null;
  const umbralFuga = Number((await db.query<{ v: string }>("select fn_parametro_reporte('DIAS_FUGA_CLIENTE')::text as v")).rows[0].v);

  const { rows: venta } = await db.query<{ venta: string; atendidos: string }>(
    `select coalesce(sum(base_usd), 0)::numeric(16,2)::text as venta, count(distinct cliente_id)::text as atendidos
       from vw_venta_documento
      where vendedor_id = $1 and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))`,
    [vendedorId, aniosFiltro]);
  const ventaTotal = Number(venta[0].venta);

  const { rows: top3 } = await db.query<{ top3: string }>(
    `with venta_cliente as (
       select cliente_id, sum(base_usd) as venta from vw_venta_documento
        where vendedor_id = $1 and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))
        group by cliente_id
     )
     select coalesce(sum(venta), 0)::numeric(16,2)::text as top3
       from (select venta, row_number() over (order by venta desc) as rn from venta_cliente) x where rn <= 3`,
    [vendedorId, aniosFiltro]);

  const { rows: asignados } = await db.query<{ asignados: string }>(
    `select count(*)::text as asignados from cliente where estado = 'activo' and vendedor_id = $1`, [vendedorId]);

  const { rows: cruzada } = await db.query<{ v: string | null }>(
    `with por_factura as (
       select documento_id, count(distinct grupo_id) as grupos from vw_venta_linea
        where vendedor_id = $1 and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))
        group by documento_id
     )
     select avg(grupos)::text as v from por_factura`, [vendedorId, aniosFiltro]);

  const { rows: dormidos } = await db.query<{
    id: string; codigo: string; nombre: string; venta: string; ultima: string | null; dias: number | null;
  }>(
    `with compras_periodo as (
       select cliente_id from vw_venta_documento
        where vendedor_id = $1 and ($2::int[] is null or extract(year from fecha)::int = any($2::int[]))
        group by cliente_id
     ), historico as (
       select cliente_id, sum(base_usd)::numeric(16,2) as venta, max(fecha) as ultima
         from vw_venta_documento where vendedor_id = $1 group by cliente_id
     )
     select c.tercero_id as id, c.codigo, t.razon_social as nombre, coalesce(h.venta, 0::numeric(16,2))::text as venta,
            h.ultima::text as ultima, (${HOY_V} - h.ultima) as dias
       from cliente c
       join tercero t on t.id = c.tercero_id
       left join historico h on h.cliente_id = c.tercero_id
      where c.estado = 'activo' and c.vendedor_id = $1
        and not exists (select 1 from compras_periodo cp where cp.cliente_id = c.tercero_id)
      order by coalesce(h.venta, 0) desc`,
    [vendedorId, aniosFiltro]);

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);
  const asignadosN = Number(asignados[0].asignados);

  return {
    coberturaCarteraPct: pct(Number(venta[0].atendidos), asignadosN),
    concentracionTop3Pct: pct(Number(top3[0].top3), ventaTotal),
    ventaCruzada: cruzada[0].v === null ? null : Number(cruzada[0].v),
    tasaFugaPct: pct(dormidos.length, asignadosN),
    dormidos: dormidos.map((d) => ({
      id: d.id, codigo: d.codigo, nombre: d.nombre, ventaHistoricaUsd: d.venta, ultimaCompra: d.ultima,
      diasSinComprar: d.dias, enRiesgo: d.dias !== null && d.dias > umbralFuga,
    })),
  };
}
