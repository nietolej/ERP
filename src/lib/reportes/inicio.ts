import type { Db } from '@/lib/db/tipos';

/**
 * Tarjetas e indicadores de Inicio (spec_reportes §3). Las definiciones (venta, cliente activo, deuda actual,
 * riesgo de quiebre) salen siempre de vw_venta_documento, vw_disponibilidad y vw_cxc_antiguedad (§2, §12):
 * aquí solo se agregan, nunca se recalculan con una regla propia.
 */

const HOY = `((now() at time zone 'America/Caracas')::date)`;

export interface VentaMes {
  ventaUsd: string;
  variacionPct: number | null;
}

/** Venta del mes en curso contra el mismo número de días del mes anterior (tarjeta "Ventas del mes"). */
export async function ventaMes(db: Db): Promise<VentaMes> {
  const { rows } = await db.query<{ actual: string; anterior: string }>(
    `select
       coalesce((select sum(base_usd) from vw_venta_documento
                  where fecha >= date_trunc('month', ${HOY})::date and fecha <= ${HOY}), 0)::numeric(16,2)::text as actual,
       coalesce((select sum(base_usd) from vw_venta_documento
                  where fecha >= (date_trunc('month', ${HOY}) - interval '1 month')::date
                    and fecha <= (date_trunc('month', ${HOY}) - interval '1 month')::date
                                  + (${HOY} - date_trunc('month', ${HOY})::date)), 0)::numeric(16,2)::text as anterior`,
  );
  const actual = Number(rows[0].actual);
  const anterior = Number(rows[0].anterior);
  const variacionPct = anterior === 0 ? (actual > 0 ? 100 : 0) : ((actual - anterior) / anterior) * 100;
  return { ventaUsd: rows[0].actual, variacionPct };
}

/** Clientes con al menos una factura en los últimos 90 días (definición propia de esta tarjeta, distinta de cliente.estado). */
export async function clientesActivos90Dias(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(distinct cliente_id)::text as n from vw_venta_documento where fecha >= ${HOY} - 89`,
  );
  return Number(rows[0].n);
}

/** Productos en vw_disponibilidad con estado de salud RIESGO_QUIEBRE (§9), en la ventana vigente. */
export async function productosEnQuiebre(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from vw_disponibilidad where estado_salud = 'RIESGO_QUIEBRE'`,
  );
  return Number(rows[0].n);
}

export interface CobranzaPendiente {
  deudaUsd: string;
  vencidoUsd: string;
}

/** Deuda actual de clientes activos (saldo de CxC abierta) y cuánto de eso ya está vencido. */
export async function cobranzaPendiente(db: Db): Promise<CobranzaPendiente> {
  const { rows } = await db.query<{ deuda: string; vencido: string }>(
    `select coalesce(sum(a.saldo_usd), 0)::numeric(16,2)::text as deuda,
            coalesce(sum(a.saldo_usd) filter (where a.dias_vencida > 0), 0)::numeric(16,2)::text as vencido
       from vw_cxc_antiguedad a
       join cliente c on c.tercero_id = a.cliente_id
      where c.estado = 'activo'`,
  );
  return { deudaUsd: rows[0].deuda, vencidoUsd: rows[0].vencido };
}

export interface VentaMensual {
  anio: number;
  mes: number;
  ventaUsd: string;
  metaUsd: string | null;
}

/** Venta de los últimos `meses` (incluido el actual) con la meta global de cada mes, si existe (gráfico "Rendimiento Global de Ventas"). */
export async function ventaMensualConMeta(db: Db, meses = 6): Promise<VentaMensual[]> {
  const { rows } = await db.query<{ anio: string; mes: string; venta: string; meta: string | null }>(
    `with m as (
       select date_trunc('month', ${HOY})::date - (n || ' months')::interval as inicio
         from generate_series(0, $1 - 1) as n
     )
     select extract(year from m.inicio)::text as anio, extract(month from m.inicio)::text as mes,
            coalesce((select sum(v.base_usd) from vw_venta_documento v
                       where v.fecha >= m.inicio::date and v.fecha < (m.inicio + interval '1 month')::date), 0)::numeric(16,2)::text as venta,
            (select g.monto_usd::text from vw_meta_periodo g
              where g.tipo = 'global' and g.anio = extract(year from m.inicio)::int and g.mes = extract(month from m.inicio)::int) as meta
       from m
      order by m.inicio`,
    [meses],
  );
  return rows.map((r) => ({ anio: Number(r.anio), mes: Number(r.mes), ventaUsd: r.venta, metaUsd: r.meta }));
}
