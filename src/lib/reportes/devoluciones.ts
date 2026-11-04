import type { Db } from '@/lib/db/tipos';
import { condicion, type FiltroClientes } from './clientes';

/**
 * M5 · Devoluciones (spec_reportes §8). Devolución = línea de nota de crédito emitida con motivo 'devolucion'
 * (vw_nota_credito_linea, §2); venta y venta bruta salen de vw_venta_linea. Aquí solo se agregan. Los umbrales
 * son parámetros de `parametro_reporte` (migración 0034); el costo por devolución es opcional.
 *
 * Los filtros son los de M1 (años, incluir inactivos y vendedores administrativos/casa, vendedor por seguridad por fila).
 */

const pct = (parte: number, total: number): number | null => (total > 0 ? (parte / total) * 100 : null);

async function parametro(db: Db, codigo: string): Promise<number> {
  return Number((await db.query<{ v: string }>('select fn_parametro_reporte($1)::text as v', [codigo])).rows[0].v);
}

export interface ResumenDevoluciones {
  montoUsd: string; unidades: string;
  /** Devoluciones ÷ venta bruta; null si no hubo venta. */
  tasaFinancieraPct: number | null; umbralTasaPct: number; tasaSobreUmbral: boolean;
  facturasAfectadas: number; facturasTotal: number; facturasAfectadasPct: number | null;
  /** Devoluciones × costo por devolución; null si el parámetro COSTO_POR_DEVOLUCION_USD no está cargado (la tarjeta no se muestra). */
  costoOperativoUsd: string | null;
}

/** Tarjetas de M5 (§8). */
export async function resumenDevoluciones(db: Db, f: FiltroClientes = {}): Promise<ResumenDevoluciones> {
  const cn = condicion(f, 'n.fecha', 1);
  const { rows: nc } = await db.query<{ monto: string; unidades: string; facturas: string; notas: string }>(
    `select coalesce(sum(n.base_usd), 0)::numeric(16,2)::text as monto, coalesce(sum(n.cantidad), 0)::numeric(16,4)::text as unidades,
            count(distinct n.factura_id)::text as facturas, count(distinct n.documento_id)::text as notas
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id
       ${cn.sql}${cn.sql ? ' and' : 'where'} n.motivo_nc = 'devolucion'`, cn.params);
  const cv = condicion(f, 'l.fecha', 1, 'l.cliente_id');
  const { rows: venta } = await db.query<{ bruta: string }>(
    `select coalesce(sum(l.venta_bruta_usd), 0)::numeric(16,2)::text as bruta
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id ${cv.sql}`, cv.params);
  const cd = condicion(f, 'd.fecha', 1, 'd.cliente_id');
  const { rows: docs } = await db.query<{ n: string }>(
    `select count(*)::text as n from vw_venta_documento d join vendedor v on v.id = d.vendedor_id ${cd.sql}`, cd.params);
  const { rows: costo } = await db.query<{ v: string }>("select valor::text as v from parametro_reporte where codigo = 'COSTO_POR_DEVOLUCION_USD'");

  const umbral = await parametro(db, 'DEVOLUCION_TASA_UMBRAL_PCT');
  const tasa = pct(Number(nc[0].monto), Number(venta[0].bruta));
  const afectadas = Number(nc[0].facturas);
  const totalFacturas = Number(docs[0].n);
  return {
    montoUsd: nc[0].monto, unidades: nc[0].unidades,
    tasaFinancieraPct: tasa, umbralTasaPct: umbral, tasaSobreUmbral: tasa !== null && tasa > umbral,
    facturasAfectadas: afectadas, facturasTotal: totalFacturas, facturasAfectadasPct: pct(afectadas, totalFacturas),
    // Costo por devolución = por nota de crédito de devolución emitida.
    costoOperativoUsd: costo[0] ? (Number(costo[0].v) * Number(nc[0].notas)).toFixed(2) : null,
  };
}

export interface PuntoDevolucionMensual { anio: number; mes: number; ventaUsd: string; devolucionUsd: string; devueltoPct: number | null; }

/** Venta contra devoluciones por mes, con el % devuelto sobre la venta bruta (§8, pestaña Resumen). */
export async function tendenciaDevoluciones(db: Db, f: FiltroClientes = {}): Promise<PuntoDevolucionMensual[]> {
  const cv = condicion(f, 'l.fecha', 1, 'l.cliente_id');
  const { rows: ventas } = await db.query<{ anio: number; mes: number; venta: string; bruta: string }>(
    `select extract(year from l.fecha)::int as anio, extract(month from l.fecha)::int as mes,
            sum(l.base_usd)::numeric(16,2)::text as venta, sum(l.venta_bruta_usd)::numeric(16,2)::text as bruta
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id ${cv.sql} group by 1, 2`, cv.params);
  const cn = condicion(f, 'n.fecha', 1);
  const { rows: devs } = await db.query<{ anio: number; mes: number; devolucion: string }>(
    `select extract(year from n.fecha)::int as anio, extract(month from n.fecha)::int as mes, sum(n.base_usd)::numeric(16,2)::text as devolucion
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id
       ${cn.sql}${cn.sql ? ' and' : 'where'} n.motivo_nc = 'devolucion' group by 1, 2`, cn.params);
  const claves = new Set([...ventas, ...devs].map((r) => `${r.anio}-${r.mes}`));
  return [...claves].map((k) => {
    const [anio, mes] = k.split('-').map(Number);
    const v = ventas.find((r) => r.anio === anio && r.mes === mes);
    const d = devs.find((r) => r.anio === anio && r.mes === mes);
    return { anio, mes, ventaUsd: v?.venta ?? '0.00', devolucionUsd: d?.devolucion ?? '0.00', devueltoPct: pct(Number(d?.devolucion ?? 0), Number(v?.bruta ?? 0)) };
  }).sort((a, b) => a.anio - b.anio || a.mes - b.mes);
}

export type NivelRiesgo = 'CRÍTICO' | 'MODERADO' | 'NORMAL';
export interface FilaDevolucionCliente {
  clienteId: string; codigo: string; nombre: string; ventaUsd: string; devueltoUsd: string; unidades: string;
  facturasAfectadas: number; devolucionPct: number | null; riesgo: NivelRiesgo;
}

/** Nivel de riesgo por % de devolución (§8): más del umbral crítico, más del moderado, o normal. */
export function nivelRiesgo(devolucionPct: number | null, critico: number, moderado: number): NivelRiesgo {
  if (devolucionPct === null) return 'NORMAL';
  return devolucionPct > critico ? 'CRÍTICO' : devolucionPct > moderado ? 'MODERADO' : 'NORMAL';
}

/** Análisis por cliente (§8): clientes con devoluciones en el periodo, ordenados por monto devuelto. % = devuelto ÷ venta. */
export async function devolucionesPorCliente(db: Db, f: FiltroClientes = {}): Promise<FilaDevolucionCliente[]> {
  const cn = condicion(f, 'n.fecha', 1);
  const { rows: devs } = await db.query<{ cliente_id: string; devuelto: string; unidades: string; facturas: string }>(
    `select n.cliente_id, sum(n.base_usd)::numeric(16,2)::text as devuelto, sum(n.cantidad)::numeric(16,4)::text as unidades,
            count(distinct n.factura_id)::text as facturas
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id
       ${cn.sql}${cn.sql ? ' and' : 'where'} n.motivo_nc = 'devolucion' group by n.cliente_id`, cn.params);
  if (devs.length === 0) return [];
  const cv = condicion(f, 'l.fecha', 1, 'l.cliente_id');
  const { rows: ventas } = await db.query<{ cliente_id: string; venta: string }>(
    `select l.cliente_id, sum(l.base_usd)::numeric(16,2)::text as venta
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id ${cv.sql} group by l.cliente_id`, cv.params);
  const { rows: info } = await db.query<{ id: string; codigo: string; nombre: string }>(
    `select cl.tercero_id as id, cl.codigo, t.razon_social as nombre from cliente cl join tercero t on t.id = cl.tercero_id
      where cl.tercero_id = any($1::uuid[])`, [devs.map((d) => d.cliente_id)]);
  const critico = await parametro(db, 'DEVOLUCION_RIESGO_CRITICO_PCT');
  const moderado = await parametro(db, 'DEVOLUCION_RIESGO_MODERADO_PCT');
  return devs.map((d) => {
    const i = info.find((x) => x.id === d.cliente_id)!;
    const venta = ventas.find((x) => x.cliente_id === d.cliente_id)?.venta ?? '0.00';
    const p = pct(Number(d.devuelto), Number(venta));
    return {
      clienteId: d.cliente_id, codigo: i.codigo, nombre: i.nombre, ventaUsd: venta, devueltoUsd: d.devuelto, unidades: d.unidades,
      facturasAfectadas: Number(d.facturas), devolucionPct: p, riesgo: nivelRiesgo(p, critico, moderado),
    };
  }).sort((a, b) => Number(b.devueltoUsd) - Number(a.devueltoUsd) || a.codigo.localeCompare(b.codigo));
}

export interface FilaDevolucionVendedor {
  vendedorId: string; codigo: string; nombre: string; ventaBrutaUsd: string; devueltoUsd: string; ventaNetaUsd: string;
  facturasAfectadas: number; devolucionPct: number | null;
}

/**
 * Análisis por vendedor (§8): venta bruta (antes de descuentos), monto devuelto, venta neta (venta menos devoluciones)
 * y % de devolución sobre la venta bruta. Excluye administrativos y de casa salvo "incluir".
 */
export async function devolucionesPorVendedor(db: Db, f: FiltroClientes = {}): Promise<FilaDevolucionVendedor[]> {
  const cv = condicion(f, 'l.fecha', 1, 'l.cliente_id');
  const { rows: ventas } = await db.query<{ id: string; codigo: string; nombre: string; bruta: string; venta: string }>(
    `select v.id, v.codigo, v.nombre, sum(l.venta_bruta_usd)::numeric(16,2)::text as bruta, sum(l.base_usd)::numeric(16,2)::text as venta
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id ${cv.sql} group by v.id, v.codigo, v.nombre`, cv.params);
  const cn = condicion(f, 'n.fecha', 1);
  const { rows: devs } = await db.query<{ vendedor_id: string; devuelto: string; facturas: string }>(
    `select n.vendedor_id, sum(n.base_usd)::numeric(16,2)::text as devuelto, count(distinct n.factura_id)::text as facturas
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id
       ${cn.sql}${cn.sql ? ' and' : 'where'} n.motivo_nc = 'devolucion' group by n.vendedor_id`, cn.params);
  return ventas.map((v) => {
    const d = devs.find((x) => x.vendedor_id === v.id);
    const devuelto = d?.devuelto ?? '0.00';
    return {
      vendedorId: v.id, codigo: v.codigo, nombre: v.nombre, ventaBrutaUsd: v.bruta, devueltoUsd: devuelto,
      ventaNetaUsd: (Number(v.venta) - Number(devuelto)).toFixed(2), facturasAfectadas: d ? Number(d.facturas) : 0,
      devolucionPct: pct(Number(devuelto), Number(v.bruta)),
    };
  }).sort((a, b) => Number(b.ventaBrutaUsd) - Number(a.ventaBrutaUsd) || a.codigo.localeCompare(b.codigo));
}

export interface FilaDevolucionProducto {
  productoId: string; codigo: string; descripcion: string; grupo: string | null; unidadesVendidas: string; unidadesDevueltas: string;
  devueltoUsd: string; devolucionPct: number | null; alertaDefecto: boolean;
}

/**
 * Análisis por producto (§8): productos con devoluciones. ALERTA DEFECTO si el % en volumen supera DEFECTO_PCT y las
 * unidades devueltas llegan a DEFECTO_UNIDADES_MINIMAS. El monto devuelto sale del importe de la línea de la NC.
 */
export async function devolucionesPorProducto(db: Db, f: FiltroClientes = {}): Promise<FilaDevolucionProducto[]> {
  const cn = condicion(f, 'n.fecha', 1);
  const { rows: devs } = await db.query<{ producto_id: string; unidades: string; devuelto: string }>(
    `select n.producto_id, sum(n.cantidad)::numeric(16,4)::text as unidades, sum(n.base_usd)::numeric(16,2)::text as devuelto
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id
       ${cn.sql}${cn.sql ? ' and' : 'where'} n.motivo_nc = 'devolucion' group by n.producto_id`, cn.params);
  if (devs.length === 0) return [];
  const cv = condicion(f, 'l.fecha', 1, 'l.cliente_id');
  const { rows: ventas } = await db.query<{ producto_id: string; unidades: string }>(
    `select l.producto_id, sum(l.cantidad)::numeric(16,4)::text as unidades
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id ${cv.sql} group by l.producto_id`, cv.params);
  const { rows: info } = await db.query<{ id: string; codigo: string; descripcion: string; grupo: string | null }>(
    `select p.id, p.codigo, p.descripcion, g.nombre as grupo from producto p left join grupo_producto g on g.id = p.grupo_id
      where p.id = any($1::uuid[])`, [devs.map((d) => d.producto_id)]);
  const umbralPct = await parametro(db, 'DEFECTO_PCT');
  const minUnidades = await parametro(db, 'DEFECTO_UNIDADES_MINIMAS');
  return devs.map((d) => {
    const i = info.find((x) => x.id === d.producto_id)!;
    const vendidas = ventas.find((x) => x.producto_id === d.producto_id)?.unidades ?? '0.0000';
    const p = pct(Number(d.unidades), Number(vendidas));
    return {
      productoId: d.producto_id, codigo: i.codigo, descripcion: i.descripcion, grupo: i.grupo, unidadesVendidas: vendidas,
      unidadesDevueltas: d.unidades, devueltoUsd: d.devuelto, devolucionPct: p,
      alertaDefecto: p !== null && p > umbralPct && Number(d.unidades) >= minUnidades,
    };
  }).sort((a, b) => Number(b.devueltoUsd) - Number(a.devueltoUsd) || a.codigo.localeCompare(b.codigo));
}
