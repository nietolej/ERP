import type { Db } from '@/lib/db/tipos';

/**
 * M1 · Clientes, pestaña "Análisis por año" (spec_reportes §4.1). Las definiciones (venta, devolución, pedido,
 * días de pago, tendencia) salen de vw_venta_documento, vw_venta_linea, vw_nota_credito_linea, vw_cxc_antiguedad
 * y vw_cobro_aplicado (§2, §12): aquí solo se agregan por cliente y por año, nunca se recalculan.
 *
 * Vista global (clienteId ausente): suma todos los clientes activos (o todos, con incluirInactivos) y
 * excluye los vendedores administrativo/casa (o los incluye, con el mismo interruptor). Vista de un cliente
 * (clienteId presente): el cliente se muestra aunque esté inactivo; el filtro de vendedor se mantiene.
 */

/** Años con al menos una factura emitida, para poblar el selector de año (más reciente primero). */
export async function aniosDisponibles(db: Db): Promise<number[]> {
  const { rows } = await db.query<{ anio: number }>(
    'select distinct extract(year from fecha)::int as anio from vw_venta_documento order by 1 desc');
  return rows.map((r) => r.anio);
}

export interface FiltroClientes {
  clienteId?: string;
  /** Años a sumar; vacío o ausente = todo el histórico ("Todos"). */
  anios?: number[];
  incluirInactivos?: boolean;
  /** Seguridad por fila: un usuario con solo el rol Ventas ve nada más su propia cartera (§4.3). */
  vendedorId?: string;
}

interface Condicion { sql: string; params: unknown[]; }

/**
 * `$n` consecutivos para cliente, vendedor (join a `vendedor v`) y año, a partir de `desde`.
 * `columnaCliente` se califica con su alias de tabla cuando la consulta junta más de una tabla con `cliente_id`
 * (p. ej. vw_cxc_antiguedad y documento_venta a la vez), para que la columna no quede ambigua.
 */
function condicion(f: FiltroClientes, columnaFecha: string, desde: number, columnaCliente = 'cliente_id'): Condicion {
  const partes: string[] = [];
  const params: unknown[] = [];
  let n = desde;
  if (f.clienteId) { partes.push(`${columnaCliente} = $${n++}`); params.push(f.clienteId); }
  else if (!f.incluirInactivos) { partes.push(`${columnaCliente} in (select tercero_id from cliente where estado = 'activo')`); }
  if (!f.incluirInactivos) partes.push(`v.tipo in ('interno', 'externo')`);
  if (f.vendedorId) { partes.push(`v.id = $${n++}`); params.push(f.vendedorId); }
  if (f.anios && f.anios.length > 0) { partes.push(`extract(year from ${columnaFecha})::int = any($${n++})`); params.push(f.anios); }
  return { sql: partes.length > 0 ? `where ${partes.join(' and ')}` : '', params };
}

export interface VentaPorAnio { anio: number; ventaUsd: string; }

export interface AnalisisAnioClientes {
  finanzasMetas: {
    ventaTotalUsd: string;
    tendenciaUsd: string;
    metaUsd: string | null;
    cumplimientoTendenciaPct: number | null;
  };
  volumenOperaciones: {
    pedidos: number;
    ticketPromedioUsd: string;
    porSucursal: { sucursal: string; ventaUsd: string; pedidos: number; ticketUsd: string }[];
    itemsVendidos: string;
    ultimaCompra: string | null;
  };
  devoluciones: {
    montoUsd: string; items: string; pedidos: number;
    indiceMontoPct: number | null; indiceItemsPct: number | null; indicePedidosPct: number | null;
  };
  cobranzasCxC: {
    diasPagoPromedio: number | null;
    deudaActualUsd: string;
    deudaEmitidaEnPeriodoUsd: string;
    vencimientoMasAntiguo: string | null;
  };
  descuentos: {
    facturaUsd: string; facturaPct: number | null;
    prontoPagoUsd: string; prontoPagoPct: number | null;
    totalUsd: string; totalPct: number | null;
  };
  insight: { tipo: 'mora' | 'deuda' | 'devolucion' | 'tendencia' | null; mensaje: string | null };
  evolucionMensual: { anio: number; mes: number; ventaUsd: string; devolucionUsd: string }[];
  pagosPorInstrumento: { instrumento: string; montoUsd: string; pct: number }[];
}

const HOY = `((now() at time zone 'America/Caracas')::date)`;

export async function analisisAnio(db: Db, f: FiltroClientes = {}): Promise<AnalisisAnioClientes> {
  const anioActual = Number((await db.query<{ a: string }>(`select extract(year from ${HOY})::text as a`)).rows[0].a);
  const diasTranscurridos = Number((await db.query<{ d: string }>(`select extract(doy from ${HOY})::text as d`)).rows[0].d);

  // Venta y tendencia, por año (sumadas si se seleccionó más de un año; "Todos" trae todo el histórico).
  const cVd = condicion(f, 'd.fecha', 1);
  const { rows: porAnio } = await db.query<{ anio: number; venta: string }>(
    `select extract(year from d.fecha)::int as anio, coalesce(sum(d.base_usd), 0)::numeric(16,2)::text as venta
       from vw_venta_documento d join vendedor v on v.id = d.vendedor_id ${cVd.sql}
      group by 1`, cVd.params);
  let ventaTotal = 0, tendencia = 0;
  for (const r of porAnio) {
    const venta = Number(r.venta);
    ventaTotal += venta;
    tendencia += r.anio === anioActual && diasTranscurridos > 0 ? (venta * 365) / diasTranscurridos : venta;
  }

  // Pedidos, ticket y última compra (global y por sucursal).
  const cVd2 = condicion(f, 'd.fecha', 1);
  const { rows: op } = await db.query<{ pedidos: string; ultima_compra: string | null }>(
    `select count(distinct (d.cliente_id, d.fecha))::text as pedidos, max(d.fecha)::text as ultima_compra
       from vw_venta_documento d join vendedor v on v.id = d.vendedor_id ${cVd2.sql}`, cVd2.params);
  const cVd3 = condicion(f, 'd.fecha', 1);
  const { rows: porSucursal } = await db.query<{ sucursal: string; venta: string; pedidos: string }>(
    `select s.nombre as sucursal, coalesce(sum(d.base_usd), 0)::numeric(16,2)::text as venta,
            count(distinct (d.cliente_id, d.fecha))::text as pedidos
       from vw_venta_documento d join vendedor v on v.id = d.vendedor_id join sucursal s on s.id = d.sucursal_id
       ${cVd3.sql}
      group by s.nombre order by s.nombre`, cVd3.params);

  // Venta bruta, ítems y descuento de línea.
  const cVl = condicion(f, 'l.fecha', 1);
  const { rows: linea } = await db.query<{ venta_bruta: string; items: string; descuento_linea: string }>(
    `select coalesce(sum(l.venta_bruta_usd), 0)::numeric(16,2)::text as venta_bruta,
            coalesce(sum(l.cantidad), 0)::numeric(16,4)::text as items,
            coalesce(sum(l.descuento_usd), 0)::numeric(16,2)::text as descuento_linea
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id ${cVl.sql}`, cVl.params);

  // Devoluciones y descuentos de nota de crédito, por motivo.
  const cNc = condicion(f, 'n.fecha', 1);
  const { rows: nc } = await db.query<{
    devol_monto: string; devol_items: string; devol_pedidos: string; descuento_nc: string; pronto_pago: string;
  }>(
    `select coalesce(sum(n.base_usd) filter (where n.motivo_nc = 'devolucion'), 0)::numeric(16,2)::text as devol_monto,
            coalesce(sum(n.cantidad) filter (where n.motivo_nc = 'devolucion'), 0)::numeric(16,4)::text as devol_items,
            count(distinct n.factura_id) filter (where n.motivo_nc = 'devolucion')::text as devol_pedidos,
            coalesce(sum(n.base_usd) filter (where n.motivo_nc in ('descuento_comercial', 'ajuste_precio')), 0)::numeric(16,2)::text as descuento_nc,
            coalesce(sum(n.base_usd) filter (where n.motivo_nc = 'pronto_pago'), 0)::numeric(16,2)::text as pronto_pago
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id ${cNc.sql}`, cNc.params);

  // Venta de facturas canceladas del periodo (denominador del % de pronto pago).
  const cCancel = condicion(f, 'd.fecha', 1);
  const { rows: cancel } = await db.query<{ venta: string }>(
    `select coalesce(sum(d.base_usd), 0)::numeric(16,2)::text as venta
       from vw_venta_documento d join vendedor v on v.id = d.vendedor_id ${cCancel.sql}${cCancel.sql ? ' and' : 'where'} d.cancelada`,
    cCancel.params);

  // Cuentas por cobrar: deuda actual, emitida en el periodo y vencimiento más antiguo (siempre al día de hoy, sin filtro de año en la deuda actual).
  const cCxc = condicion({ ...f, anios: undefined }, 'a.fecha', 1, 'a.cliente_id');
  const { rows: cxc } = await db.query<{ deuda: string; vencimiento: string | null }>(
    `select coalesce(sum(a.saldo_usd), 0)::numeric(16,2)::text as deuda, min(a.vencimiento)::text as vencimiento
       from vw_cxc_antiguedad a join documento_venta f on f.id = a.documento_id join vendedor v on v.id = f.vendedor_id ${cCxc.sql}`,
    cCxc.params);
  const cCxcAnio = condicion(f, 'a.fecha', 1, 'a.cliente_id');
  const { rows: cxcAnio } = await db.query<{ deuda: string }>(
    `select coalesce(sum(a.saldo_usd), 0)::numeric(16,2)::text as deuda
       from vw_cxc_antiguedad a join documento_venta f on f.id = a.documento_id join vendedor v on v.id = f.vendedor_id ${cCxcAnio.sql}`,
    cCxcAnio.params);

  // Partidas vencidas (para el insight de mora), siempre a hoy, con el mismo filtro de cliente/vendedor.
  const cMora = condicion({ ...f, anios: undefined }, 'a.fecha', 1, 'a.cliente_id');
  const { rows: mora } = await db.query<{ n: string }>(
    `select count(*)::text as n from vw_cxc_antiguedad a join documento_venta f on f.id = a.documento_id join vendedor v on v.id = f.vendedor_id
      ${cMora.sql}${cMora.sql ? ' and' : 'where'} a.dias_vencida > 0`, cMora.params);

  // Días de pago promedio, ponderado por monto, con los cobros del periodo.
  const cCobro = condicion(f, 'a.fecha', 1);
  const { rows: cobro } = await db.query<{ ponderado: string | null }>(
    `select case when sum(a.monto_usd) > 0 then (sum(a.monto_usd * a.dias_pago) / sum(a.monto_usd))::text else null end as ponderado
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id ${cCobro.sql}`, cCobro.params);

  // Pagos por instrumento (torta).
  const cPagos = condicion(f, 'a.fecha', 1);
  const { rows: pagos } = await db.query<{ instrumento: string; monto: string }>(
    `select i.nombre as instrumento, coalesce(sum(a.monto_usd), 0)::numeric(16,2)::text as monto
       from vw_cobro_aplicado a join vendedor v on v.id = a.vendedor_id join instrumento_pago i on i.id = a.instrumento_id
       ${cPagos.sql}
      group by i.nombre having sum(a.monto_usd) > 0 order by sum(a.monto_usd) desc`, cPagos.params);
  const totalPagos = pagos.reduce((s, p) => s + Number(p.monto), 0);

  // Evolución mensual (ventas vs. devoluciones) del año de referencia: el último seleccionado, o el actual si es "Todos".
  const anioEvolucion = f.anios && f.anios.length > 0 ? Math.max(...f.anios) : anioActual;
  const cEvVenta = condicion({ ...f, anios: [anioEvolucion] }, 'd.fecha', 1);
  const { rows: evVenta } = await db.query<{ mes: number; venta: string }>(
    `select extract(month from d.fecha)::int as mes, coalesce(sum(d.base_usd), 0)::numeric(16,2)::text as venta
       from vw_venta_documento d join vendedor v on v.id = d.vendedor_id ${cEvVenta.sql} group by 1`, cEvVenta.params);
  const cEvNc = condicion({ ...f, anios: [anioEvolucion] }, 'n.fecha', 1);
  const { rows: evNc } = await db.query<{ mes: number; devolucion: string }>(
    `select extract(month from n.fecha)::int as mes, coalesce(sum(n.base_usd), 0)::numeric(16,2)::text as devolucion
       from vw_nota_credito_linea n join vendedor v on v.id = n.vendedor_id ${cEvNc.sql}
        ${cEvNc.sql ? 'and' : 'where'} n.motivo_nc = 'devolucion' group by 1`, cEvNc.params);
  const ventaPorMes = Object.fromEntries(evVenta.map((r) => [r.mes, r.venta]));
  const devolPorMes = Object.fromEntries(evNc.map((r) => [r.mes, r.devolucion]));
  const evolucionMensual = Array.from({ length: 12 }, (_, i) => ({
    anio: anioEvolucion, mes: i + 1, ventaUsd: ventaPorMes[i + 1] ?? '0.00', devolucionUsd: devolPorMes[i + 1] ?? '0.00',
  }));

  // Meta: del cliente, o global en la vista general; suma de los años seleccionados (o de todos, si es "Todos").
  const anios = f.anios && f.anios.length > 0 ? f.anios : porAnio.map((r) => r.anio);
  const { rows: meta } = await db.query<{ monto: string | null }>(
    anios.length > 0
      ? `select sum(monto_usd)::text as monto from vw_meta_anual where tipo = $1 and entidad_id ${f.clienteId ? '= $2' : 'is null'} and anio = any($${f.clienteId ? 3 : 2})`
      : `select null::text as monto`,
    anios.length > 0 ? (f.clienteId ? ['cliente', f.clienteId, anios] : ['global', anios]) : [],
  );
  const metaUsd = meta[0]?.monto ?? null;

  const descuentoFacturaUsd = Number(linea[0].descuento_linea) + Number(nc[0].descuento_nc);
  const ventaBruta = Number(linea[0].venta_bruta);
  const ventaCancelada = Number(cancel[0].venta);
  const prontoPagoUsd = Number(nc[0].pronto_pago);
  const devolucionMonto = Number(nc[0].devol_monto);
  const itemsVendidos = Number(linea[0].items);
  const devolucionItems = Number(nc[0].devol_items);
  const pedidos = Number(op[0].pedidos);
  const devolucionPedidos = Number(nc[0].devol_pedidos);

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);

  const cumplimientoTendenciaPct = metaUsd !== null && Number(metaUsd) > 0 ? (tendencia / Number(metaUsd)) * 100 : null;

  const umbralDevolucion = Number((await db.query<{ v: string }>("select fn_parametro_reporte('INSIGHT_DEVOLUCION_PCT')::text as v")).rows[0].v);
  const umbralTendencia = Number((await db.query<{ v: string }>("select fn_parametro_reporte('INSIGHT_CUMPLIMIENTO_TENDENCIA_PCT')::text as v")).rows[0].v);
  const partidasVencidas = Number(mora[0].n);
  const deudaActual = Number(cxc[0].deuda);
  const indiceDevolucionMontoPct = pct(devolucionMonto, ventaTotal);

  let insight: AnalisisAnioClientes['insight'] = { tipo: null, mensaje: null };
  if (partidasVencidas > 0) {
    insight = { tipo: 'mora', mensaje: `El cliente tiene ${partidasVencidas} factura(s) en mora. Se recomienda suspender créditos y contactar para cobranza.` };
  } else if (deudaActual > 0) {
    insight = { tipo: 'deuda', mensaje: `Deuda activa de $${deudaActual.toFixed(2)}. Monitorear fechas de vencimiento.` };
  } else if (indiceDevolucionMontoPct !== null && indiceDevolucionMontoPct > umbralDevolucion) {
    insight = { tipo: 'devolucion', mensaje: 'Investigar calidad del último lote.' };
  } else if (cumplimientoTendenciaPct !== null && cumplimientoTendenciaPct > umbralTendencia) {
    insight = { tipo: 'tendencia', mensaje: 'Considerar programa de lealtad.' };
  }

  return {
    finanzasMetas: {
      ventaTotalUsd: ventaTotal.toFixed(2), tendenciaUsd: tendencia.toFixed(2), metaUsd,
      cumplimientoTendenciaPct,
    },
    volumenOperaciones: {
      pedidos, ticketPromedioUsd: pedidos > 0 ? (ventaTotal / pedidos).toFixed(2) : '0.00',
      porSucursal: porSucursal.map((s) => ({
        sucursal: s.sucursal, ventaUsd: s.venta, pedidos: Number(s.pedidos),
        ticketUsd: Number(s.pedidos) > 0 ? (Number(s.venta) / Number(s.pedidos)).toFixed(2) : '0.00',
      })),
      itemsVendidos: linea[0].items, ultimaCompra: op[0].ultima_compra,
    },
    devoluciones: {
      montoUsd: nc[0].devol_monto, items: nc[0].devol_items, pedidos: devolucionPedidos,
      indiceMontoPct: indiceDevolucionMontoPct, indiceItemsPct: pct(devolucionItems, itemsVendidos), indicePedidosPct: pct(devolucionPedidos, pedidos),
    },
    cobranzasCxC: {
      diasPagoPromedio: cobro[0].ponderado === null ? null : Number(cobro[0].ponderado),
      deudaActualUsd: cxc[0].deuda, deudaEmitidaEnPeriodoUsd: cxcAnio[0].deuda, vencimientoMasAntiguo: cxc[0].vencimiento,
    },
    descuentos: {
      facturaUsd: descuentoFacturaUsd.toFixed(2), facturaPct: pct(descuentoFacturaUsd, ventaBruta),
      prontoPagoUsd: prontoPagoUsd.toFixed(2), prontoPagoPct: pct(prontoPagoUsd, ventaCancelada),
      totalUsd: (descuentoFacturaUsd + prontoPagoUsd).toFixed(2), totalPct: pct(descuentoFacturaUsd + prontoPagoUsd, ventaBruta),
    },
    insight,
    evolucionMensual,
    pagosPorInstrumento: pagos.map((p) => ({ instrumento: p.instrumento, montoUsd: p.monto, pct: totalPagos > 0 ? (Number(p.monto) / totalPagos) * 100 : 0 })),
  };
}

export interface AnalisisHistoricoClientes {
  /** Todo el histórico, con las mismas funciones de "Análisis por año" (§4.2: nunca se recalcula aparte). */
  total: AnalisisAnioClientes;
  /** Un `analisisAnio` por cada año con venta, para la matriz y el gráfico de evolución anual. */
  porAnio: (AnalisisAnioClientes & { anio: number })[];
}

/** Pestaña "Análisis total (histórico)" (spec_reportes §4.2): reusa `analisisAnio`, aplicada a todo el histórico y a cada año. */
export async function analisisHistorico(db: Db, f: Omit<FiltroClientes, 'anios'> = {}): Promise<AnalisisHistoricoClientes> {
  const anios = await aniosDisponibles(db);
  const [total, ...porAnio] = await Promise.all([
    analisisAnio(db, { ...f, anios: undefined }),
    ...anios.map(async (anio) => ({ ...(await analisisAnio(db, { ...f, anios: [anio] })), anio })),
  ]);
  porAnio.sort((a, b) => a.anio - b.anio);
  return { total, porAnio };
}

export interface PartidaAbierta {
  numero: string; emision: string; montoOriginalUsd: string; abonadoUsd: string; saldoUsd: string; vencimiento: string; mora: string;
}

const diasEntre = (desde: string, hasta: string) => Math.round((new Date(hasta).getTime() - new Date(desde).getTime()) / 86_400_000);

/** "Estado de cuenta (global)" (§4.2): partidas de CxC abiertas, siempre a hoy (no se filtra por año). */
export async function partidasAbiertas(db: Db, f: Omit<FiltroClientes, 'anios'> = {}): Promise<PartidaAbierta[]> {
  const hoy = (await db.query<{ h: string }>(`select ${HOY}::text as h`)).rows[0].h;
  const c = condicion({ ...f, anios: undefined }, 'a.fecha', 1, 'a.cliente_id');
  const { rows } = await db.query<{
    numero: string; emision: string; monto_usd: string; saldo_usd: string; vencimiento: string;
  }>(
    `select a.factura as numero, a.fecha::text as emision, p.monto_usd::text, a.saldo_usd::text, a.vencimiento::text
       from vw_cxc_antiguedad a join partida_cxc p on p.id = a.partida_id join documento_venta d on d.id = a.documento_id join vendedor v on v.id = d.vendedor_id
       ${c.sql}
      order by a.vencimiento, a.factura`, c.params);
  return rows.map((r) => ({
    numero: r.numero, emision: r.emision, montoOriginalUsd: r.monto_usd,
    abonadoUsd: (Number(r.monto_usd) - Number(r.saldo_usd)).toFixed(2), saldoUsd: r.saldo_usd, vencimiento: r.vencimiento,
    mora: r.vencimiento < hoy ? `${diasEntre(r.vencimiento, hoy)} días de vencido`
        : r.vencimiento > hoy ? `${diasEntre(hoy, r.vencimiento)} días por vencer` : 'Al día',
  }));
}

export interface TopItemCliente {
  productoId: string; codigo: string; descripcion: string; ultimaVenta: string | null; stockComercial: string | null;
  cantidad: string; montoUsd: string;
}

/** Top 100 productos vendidos (al cliente, o globales) en el periodo, por cantidad o por monto. */
export async function topItems(db: Db, f: FiltroClientes, orden: 'cantidad' | 'monto'): Promise<TopItemCliente[]> {
  const c = condicion(f, 'l.fecha', 1);
  const { rows } = await db.query<{
    producto_id: string; codigo: string; descripcion: string; ultima_venta: string | null; stock_comercial: string | null;
    cantidad: string; monto_usd: string;
  }>(
    `select p.id as producto_id, p.codigo, p.descripcion,
            (select max(fecha) from vw_venta_linea where producto_id = p.id)::text as ultima_venta,
            (select stock_comercial::text from vw_disponibilidad where producto_id = p.id) as stock_comercial,
            sum(l.cantidad)::numeric(16,4)::text as cantidad, sum(l.base_usd)::numeric(16,2)::text as monto_usd
       from vw_venta_linea l join vendedor v on v.id = l.vendedor_id join producto p on p.id = l.producto_id
       ${c.sql}
      group by p.id, p.codigo, p.descripcion
      order by ${orden === 'cantidad' ? 'sum(l.cantidad)' : 'sum(l.base_usd)'} desc
      limit 100`, c.params);
  return rows.map((r) => ({
    productoId: r.producto_id, codigo: r.codigo, descripcion: r.descripcion, ultimaVenta: r.ultima_venta,
    stockComercial: r.stock_comercial, cantidad: r.cantidad, montoUsd: r.monto_usd,
  }));
}
