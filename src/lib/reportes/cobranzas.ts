import type { Db } from '@/lib/db/tipos';
import { condicion, type FiltroClientes } from './clientes';

/**
 * M4 · Cobranzas (spec_reportes §7). Las definiciones (cobro, días de pago, deuda actual, mora) salen de
 * vw_cobro_aplicado y vw_cxc_antiguedad (§2, §12); aquí solo se agregan. Un "pago" es una aplicación de cobro a
 * una factura, porque los días de pago se miden contra la factura a la que se aplicó (§2).
 *
 * Los filtros son los de M1 (años, incluir inactivos, vendedor por seguridad por fila). La deuda abierta
 * (antigüedad, deuda por vendedor y por cliente) es siempre la de hoy y no depende del periodo.
 */

const pct = (parte: number, total: number): number | null => (total > 0 ? (parte / total) * 100 : null);
const sinPeriodo = (f: FiltroClientes): FiltroClientes => ({ ...f, anios: undefined, fechaDesde: undefined, fechaHasta: undefined });

export interface ResumenCobranza {
  cobradoUsd: string; pagos: number;
  /** Días de pago promedio ponderado por monto (§2); null si no hubo cobros. */
  diasPromedio: number | null; diasMediana: number | null;
  /** % de pagos con 30 días o menos; null si no hubo cobros. */
  aTiempoPct: number | null;
  facturadoUsd: string; pendienteUsd: string;
  /** (facturado − saldo pendiente de esas facturas) ÷ facturado; null si no se facturó nada. */
  efectividadPct: number | null;
}

/** Tarjetas principales de M4 (§7). */
export async function resumenCobranza(db: Db, f: FiltroClientes = {}): Promise<ResumenCobranza> {
  const c = condicion(f, 'a.fecha', 1);
  const { rows } = await db.query<{ cobrado: string; pagos: string; ponderado: string | null; mediana: string | null; a_tiempo: string }>(
    `select coalesce(sum(a.monto_usd), 0)::numeric(16,2)::text as cobrado, count(*)::text as pagos,
            case when sum(a.monto_usd) > 0 then (sum(a.monto_usd * a.dias_pago) / sum(a.monto_usd))::text else null end as ponderado,
            (percentile_cont(0.5) within group (order by a.dias_pago))::text as mediana,
            count(*) filter (where a.dias_pago <= 30)::text as a_tiempo
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${c.sql}`, c.params);
  const cf = condicion(f, 'd.fecha', 1, 'd.cliente_id');
  const { rows: fac } = await db.query<{ facturado: string; pendiente: string }>(
    `select coalesce(sum(d.total_usd), 0)::numeric(16,2)::text as facturado, coalesce(sum(d.saldo_usd), 0)::numeric(16,2)::text as pendiente
       from vw_venta_documento d join vendedor v on v.id = d.vendedor_id ${cf.sql}`, cf.params);
  const r = rows[0];
  const pagos = Number(r.pagos);
  const facturado = Number(fac[0].facturado);
  return {
    cobradoUsd: r.cobrado, pagos,
    diasPromedio: r.ponderado === null ? null : Number(r.ponderado),
    diasMediana: r.mediana === null ? null : Number(r.mediana),
    aTiempoPct: pct(Number(r.a_tiempo), pagos),
    facturadoUsd: fac[0].facturado, pendienteUsd: fac[0].pendiente,
    efectividadPct: pct(facturado - Number(fac[0].pendiente), facturado),
  };
}

export type TramoVelocidad = 'pronto_pago' | 'puntual' | 'mora_leve' | 'mora_critica';
export interface FilaVelocidad { tramo: TramoVelocidad; etiqueta: string; rango: string; montoUsd: string; pagos: number; pct: number | null; }

const TRAMOS_VELOCIDAD: { tramo: TramoVelocidad; etiqueta: string; rango: string }[] = [
  { tramo: 'pronto_pago', etiqueta: 'Pronto pago', rango: '0-15 días' },
  { tramo: 'puntual', etiqueta: 'Puntual', rango: '16-30 días' },
  { tramo: 'mora_leve', etiqueta: 'Mora leve', rango: '31-60 días' },
  { tramo: 'mora_critica', etiqueta: 'Mora crítica', rango: 'Más de 60 días' },
];

/** Distribución de velocidad de cobro (§7): siempre los cuatro tramos, aunque estén en cero. */
export async function velocidadCobro(db: Db, f: FiltroClientes = {}): Promise<FilaVelocidad[]> {
  const c = condicion(f, 'a.fecha', 1);
  const { rows } = await db.query<{ tramo: TramoVelocidad; monto: string; pagos: string }>(
    `select case when a.dias_pago <= 15 then 'pronto_pago' when a.dias_pago <= 30 then 'puntual'
                 when a.dias_pago <= 60 then 'mora_leve' else 'mora_critica' end as tramo,
            sum(a.monto_usd)::numeric(16,2)::text as monto, count(*)::text as pagos
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${c.sql}
      group by 1`, c.params);
  const total = rows.reduce((s, r) => s + Number(r.monto), 0);
  return TRAMOS_VELOCIDAD.map((t) => {
    const r = rows.find((x) => x.tramo === t.tramo);
    return { ...t, montoUsd: r?.monto ?? '0.00', pagos: r ? Number(r.pagos) : 0, pct: r ? pct(Number(r.monto), total) : (total > 0 ? 0 : null) };
  });
}

export type BaseAntiguedad = 'emision' | 'vencimiento';
export interface FilaAntiguedad { tramo: string; montoUsd: string; facturas: number; pct: number | null; }

const TRAMOS_ANTIGUEDAD = ['0-30 días', '31-60 días', '61-90 días', 'Más de 90 días'];

/**
 * Antigüedad de saldos (§7): deuda abierta a hoy. Cuenta los días desde la emisión (como el dashboard) o desde el
 * vencimiento (mora real; lo que aún no vence cuenta 0 días).
 */
export async function antiguedadSaldos(db: Db, f: FiltroClientes = {}, base: BaseAntiguedad = 'vencimiento'): Promise<FilaAntiguedad[]> {
  const c = condicion(sinPeriodo(f), 'a.fecha', 1, 'a.cliente_id');
  const dias = base === 'emision' ? 'a.dias_emitida' : 'a.dias_vencida';
  const { rows } = await db.query<{ idx: number; monto: string; facturas: string }>(
    `select case when ${dias} <= 30 then 0 when ${dias} <= 60 then 1 when ${dias} <= 90 then 2 else 3 end as idx,
            sum(a.saldo_usd)::numeric(16,2)::text as monto, count(*)::text as facturas
       from vw_cxc_antiguedad a join documento_venta d on d.id = a.documento_id join vendedor v on v.id = d.vendedor_id ${c.sql}
      group by 1`, c.params);
  const total = rows.reduce((s, r) => s + Number(r.monto), 0);
  return TRAMOS_ANTIGUEDAD.map((tramo, i) => {
    const r = rows.find((x) => x.idx === i);
    return { tramo, montoUsd: r?.monto ?? '0.00', facturas: r ? Number(r.facturas) : 0, pct: pct(Number(r?.monto ?? 0), total) };
  });
}

export interface PuntoTendenciaCobro { anio: number; mes: number; montoUsd: string; diasPromedio: number | null; }

/** Tendencia mensual (§7): monto cobrado y días promedio de pago (ponderado) por mes. */
export async function tendenciaCobranza(db: Db, f: FiltroClientes = {}): Promise<PuntoTendenciaCobro[]> {
  const c = condicion(f, 'a.fecha', 1);
  const { rows } = await db.query<{ anio: number; mes: number; monto: string; ponderado: string | null }>(
    `select extract(year from a.fecha)::int as anio, extract(month from a.fecha)::int as mes,
            sum(a.monto_usd)::numeric(16,2)::text as monto,
            case when sum(a.monto_usd) > 0 then (sum(a.monto_usd * a.dias_pago) / sum(a.monto_usd))::text else null end as ponderado
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${c.sql}
      group by 1, 2 order by 1, 2`, c.params);
  return rows.map((r) => ({ anio: r.anio, mes: r.mes, montoUsd: r.monto, diasPromedio: r.ponderado === null ? null : Number(r.ponderado) }));
}

export interface FilaCobranzaVendedor {
  vendedorId: string; codigo: string; nombre: string; cobradoUsd: string; cobros: number;
  diasPromedio: number | null; diasMediana: number | null; aTiempoPct: number | null; moraPct: number | null; deudaUsd: string;
}

/** Promedio por vendedor (§7): el vendedor se toma de la factura cobrada. Orden: monto cobrado descendente. */
export async function cobranzaPorVendedor(db: Db, f: FiltroClientes = {}): Promise<FilaCobranzaVendedor[]> {
  const c = condicion(f, 'a.fecha', 1);
  const { rows } = await db.query<{
    id: string; codigo: string; nombre: string; cobrado: string; cobros: string; ponderado: string | null; mediana: string; a_tiempo: string; deuda: string;
  }>(
    `select v.id, v.codigo, v.nombre, sum(a.monto_usd)::numeric(16,2)::text as cobrado, count(*)::text as cobros,
            case when sum(a.monto_usd) > 0 then (sum(a.monto_usd * a.dias_pago) / sum(a.monto_usd))::text else null end as ponderado,
            (percentile_cont(0.5) within group (order by a.dias_pago))::text as mediana,
            count(*) filter (where a.dias_pago <= 30)::text as a_tiempo,
            (select coalesce(sum(x.saldo_usd), 0)::numeric(16,2)::text from vw_cxc_antiguedad x
               join documento_venta d on d.id = x.documento_id where d.vendedor_id = v.id) as deuda
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${c.sql}
      group by v.id, v.codigo, v.nombre order by sum(a.monto_usd) desc, v.codigo`, c.params);
  return rows.map((r) => {
    const n = Number(r.cobros);
    const aTiempo = Number(r.a_tiempo);
    return {
      vendedorId: r.id, codigo: r.codigo, nombre: r.nombre, cobradoUsd: r.cobrado, cobros: n,
      diasPromedio: r.ponderado === null ? null : Number(r.ponderado), diasMediana: Number(r.mediana),
      aTiempoPct: pct(aTiempo, n), moraPct: pct(n - aTiempo, n), deudaUsd: r.deuda,
    };
  });
}

export type CategoriaCliente = 'puntual' | 'mora_leve' | 'mora_critica' | 'con_deuda';
export type Comportamiento = 'Puntual' | 'Mora leve' | 'Mora crítica' | 'Sin cobros';
export interface FilaCobranzaCliente {
  clienteId: string; codigo: string; nombre: string; asesor: string | null; cobradoUsd: string; cobros: number;
  diasPromedio: number | null; diasMediana: number | null; aTiempoPct: number | null; deudaUsd: string; comportamiento: Comportamiento;
}

/** Comportamiento según los días de pago promedio (§7): ≤30 puntual, 31-60 mora leve, más de 60 mora crítica. */
export function comportamientoDe(diasPromedio: number | null): Comportamiento {
  if (diasPromedio === null) return 'Sin cobros';
  return diasPromedio <= 30 ? 'Puntual' : diasPromedio <= 60 ? 'Mora leve' : 'Mora crítica';
}

/**
 * Promedio por cliente (§7): clientes con cobros en el periodo o con deuda pendiente, con búsqueda por código o
 * nombre y filtro por categoría. Orden: monto cobrado descendente.
 */
export async function cobranzaPorCliente(db: Db, f: FiltroClientes & { texto?: string; categoria?: CategoriaCliente } = {}): Promise<FilaCobranzaCliente[]> {
  const c = condicion(f, 'a.fecha', 1);
  const { rows: cobros } = await db.query<{
    cliente_id: string; cobrado: string; cobros: string; ponderado: string | null; mediana: string; a_tiempo: string;
  }>(
    `select a.cliente_id, sum(a.monto_usd)::numeric(16,2)::text as cobrado, count(*)::text as cobros,
            case when sum(a.monto_usd) > 0 then (sum(a.monto_usd * a.dias_pago) / sum(a.monto_usd))::text else null end as ponderado,
            (percentile_cont(0.5) within group (order by a.dias_pago))::text as mediana, count(*) filter (where a.dias_pago <= 30)::text as a_tiempo
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${c.sql} group by a.cliente_id`, c.params);

  const cd = condicion(sinPeriodo(f), 'a.fecha', 1, 'a.cliente_id');
  const { rows: deudas } = await db.query<{ cliente_id: string; deuda: string }>(
    `select a.cliente_id, sum(a.saldo_usd)::numeric(16,2)::text as deuda
       from vw_cxc_antiguedad a join documento_venta d on d.id = a.documento_id join vendedor v on v.id = d.vendedor_id ${cd.sql}
      group by a.cliente_id`, cd.params);

  const ids = [...new Set([...cobros.map((r) => r.cliente_id), ...deudas.map((r) => r.cliente_id)])];
  if (ids.length === 0) return [];
  const { rows: info } = await db.query<{ id: string; codigo: string; nombre: string; asesor: string | null }>(
    `select cl.tercero_id as id, cl.codigo, t.razon_social as nombre, v.nombre as asesor
       from cliente cl join tercero t on t.id = cl.tercero_id left join vendedor v on v.id = cl.vendedor_id
      where cl.tercero_id = any($1::uuid[])`, [ids]);

  const texto = f.texto?.trim().toLowerCase();
  const filas: FilaCobranzaCliente[] = [];
  for (const i of info) {
    const co = cobros.find((r) => r.cliente_id === i.id);
    const deuda = deudas.find((r) => r.cliente_id === i.id)?.deuda ?? '0.00';
    const dias = co?.ponderado == null ? null : Number(co.ponderado);
    const comportamiento = comportamientoDe(dias);
    if (texto && !i.codigo.toLowerCase().includes(texto) && !i.nombre.toLowerCase().includes(texto)) continue;
    if (f.categoria === 'con_deuda' && Number(deuda) <= 0) continue;
    if (f.categoria === 'puntual' && comportamiento !== 'Puntual') continue;
    if (f.categoria === 'mora_leve' && comportamiento !== 'Mora leve') continue;
    if (f.categoria === 'mora_critica' && comportamiento !== 'Mora crítica') continue;
    const n = co ? Number(co.cobros) : 0;
    filas.push({
      clienteId: i.id, codigo: i.codigo, nombre: i.nombre, asesor: i.asesor, cobradoUsd: co?.cobrado ?? '0.00', cobros: n,
      diasPromedio: dias, diasMediana: co ? Number(co.mediana) : null, aTiempoPct: co ? pct(Number(co.a_tiempo), n) : null,
      deudaUsd: deuda, comportamiento,
    });
  }
  return filas.sort((a, b) => Number(b.cobradoUsd) - Number(a.cobradoUsd) || a.codigo.localeCompare(b.codigo));
}

export interface FilaBancoCanal { nombre: string; montoUsd: string; transacciones: number; participacionPct: number | null; }
export interface BancosCanales { porCuenta: FilaBancoCanal[]; porInstrumento: FilaBancoCanal[]; }

/** Bancos y canales (§7): por cuenta bancaria y por instrumento de pago, con monto, transacciones y participación. */
export async function bancosYCanales(db: Db, f: FiltroClientes = {}): Promise<BancosCanales> {
  const c = condicion(f, 'a.fecha', 1);
  const agrupar = async (join: string, nombre: string): Promise<FilaBancoCanal[]> => {
    const { rows } = await db.query<{ nombre: string; monto: string; n: string }>(
      `select ${nombre} as nombre, sum(a.monto_usd)::numeric(16,2)::text as monto, count(*)::text as n
         from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${join} ${c.sql}
        group by 1 order by sum(a.monto_usd) desc, 1`, c.params);
    const total = rows.reduce((s, r) => s + Number(r.monto), 0);
    return rows.map((r) => ({ nombre: r.nombre, montoUsd: r.monto, transacciones: Number(r.n), participacionPct: pct(Number(r.monto), total) }));
  };
  return {
    porCuenta: await agrupar('join cuenta_bancaria cb on cb.id = a.cuenta_bancaria_id', `cb.codigo || ' · ' || cb.nombre`),
    porInstrumento: await agrupar('join instrumento_pago i on i.id = a.instrumento_id', 'i.nombre'),
  };
}
