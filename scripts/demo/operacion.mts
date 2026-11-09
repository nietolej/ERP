/**
 * Operación diaria de la empresa ficticia, día por día con el reloj simulado: reposición de mercancía (orden de compra →
 * aprobación de Gerencia → recepción → factura del proveedor → pago aprobado), ventas (pedido → nota de entrega →
 * salida de almacén → factura con número de control → cobro) y la tasa BCV de cada día. Todo con las funciones reales
 * del ERP, así que cada regla de la base de datos se ejerce igual que en el uso real.
 */
import { ErrorMaestro } from '../../src/lib/errores';
import { ImprentaSimulada } from '../../src/lib/fiscal/imprenta';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { crearFactura, guardarLinea as guardarLineaFactura, registrarFactura } from '../../src/lib/compras/facturas';
import { crearOrden, enviarOrden, guardarLinea as guardarLineaOrden } from '../../src/lib/compras/ordenes';
import { partidasPorPagar, solicitarPago } from '../../src/lib/compras/pagos';
import { recibirMercancia } from '../../src/lib/compras/recepciones';
import { registrarCobro } from '../../src/lib/ventas/cobros';
import { confirmarSalida } from '../../src/lib/ventas/despacho';
import { facturarNotas } from '../../src/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega } from '../../src/lib/ventas/pedidos';
import { sembrarApertura } from './apertura.mts';
import { sembrarPlanComision } from './comisiones.mts';
import { gastosDelDia } from './gastos.mts';
import { notasDeVenta } from './postventa.mts';
import { ajustarCostos, esFeriado, factorEstacional, retrasoExtra, saltoCambiario } from './ruido.mts';
import { ajustarInventario, producirUnKit, sembrarKits } from './produccion.mts';
import { solicitarBaja } from '../../src/lib/contabilidad/activos';
import { cerrarUnMes, mesesEntre } from './cierre.mts';
import { avisar, como, contar, diaSemana, diasEntre, dinero, fijarReloj, programar, sumarDias, type Cliente, type Ctx, type Proveedor } from './base.mts';

const TASA_INICIAL = 320;
const PUNTO_DE_PEDIDO = 30;

// ---------------------------------------------------------------------------------------------------------------------
// Tasa BCV
// ---------------------------------------------------------------------------------------------------------------------
async function registrarTasa(ctx: Ctx, fecha: string, tasaAnterior: number | null): Promise<number> {
  const salto = ctx.ruido && tasaAnterior !== null ? saltoCambiario(ctx, fecha, diaSemana(fecha)) : 1;
  const tasa = tasaAnterior === null ? TASA_INICIAL : tasaAnterior * (1 + ctx.azar.entero(2, 9) / 1000) * salto;
  await ctx.db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', $2)`, [fecha, tasa.toFixed(6)]);
  return tasa;
}

// ---------------------------------------------------------------------------------------------------------------------
// Compras: reposición, recepción, factura del proveedor y pago
// ---------------------------------------------------------------------------------------------------------------------
async function existenciaPorProducto(ctx: Ctx): Promise<Map<string, number>> {
  const { rows } = await ctx.db.query<{ producto_id: string; disponible: string }>(
    `select producto_id, (cantidad - reservado)::text as disponible from existencia where almacen_id = $1`, [ctx.almacenId]);
  return new Map(rows.map((r) => [r.producto_id, Number(r.disponible)]));
}

async function reponer(ctx: Ctx, fecha: string): Promise<void> {
  const stock = await existenciaPorProducto(ctx);
  for (const prov of ctx.proveedores) {
    const lineas = ctx.productos
      .filter((p) => p.marcaId === prov.marcaId && (stock.get(p.id) ?? 0) + (ctx.estado.enCamino.get(p.id) ?? 0) < PUNTO_DE_PEDIDO)
      .map((p) => ({ producto: p, cantidad: ctx.azar.entero(60, 140) }));
    if (!lineas.length) continue;

    const { compras, gerencia } = ctx.u;
    const ordenId = await como(ctx, compras, async (tx) => {
      const id = await crearOrden(tx, compras, { proveedorId: prov.id, almacenId: ctx.almacenId, moneda: 'USD' });
      for (const l of lineas) await guardarLineaOrden(tx, id, { productoId: l.producto.id, cantidad: String(l.cantidad), precio: dinero(l.producto.costoUsd) });
      await enviarOrden(tx, compras, id);
      return id;
    });
    await como(ctx, gerencia, (tx) => resolverAprobacion(tx, 'orden_compra', ordenId, gerencia.id, 'aprobada'));
    for (const l of lineas) ctx.estado.enCamino.set(l.producto.id, (ctx.estado.enCamino.get(l.producto.id) ?? 0) + l.cantidad);
    contar(ctx, 'ordenes_compra');
    const entrega = prov.plazoDias >= 45 ? 6 : 2;
    programar(ctx, sumarDias(fecha, entrega), () => recibirYFacturar(ctx, ordenId, prov, lineas.map((l) => [l.producto.id, l.cantidad] as const)));
  }
}

async function recibirYFacturar(ctx: Ctx, ordenId: string, prov: Proveedor, porProducto: readonly (readonly [string, number])[]): Promise<void> {
  const { almacen, compras, gerencia } = ctx.u;
  const { rows: lineas } = await ctx.db.query<{ id: string; producto_id: string; cantidad: string; precio_unitario: string }>(
    'select id, producto_id, cantidad::text, precio_unitario::text from documento_compra_linea where documento_id = $1 order by linea', [ordenId]);
  await como(ctx, almacen, (tx) => recibirMercancia(tx, almacen, ordenId, lineas.map((l) => ({ lineaId: l.id, cantidad: l.cantidad }))));
  contar(ctx, 'recepciones');
  for (const [producto, cantidad] of porProducto) ctx.estado.enCamino.set(producto, Math.max(0, (ctx.estado.enCamino.get(producto) ?? 0) - cantidad));

  // Factura del proveedor el mismo día. En una de cada diez, el proveedor sube el precio de una línea más de lo tolerado.
  const secuencia = ++ctx.estado.secuencia;
  const subeUnaLinea = ctx.azar() < 0.1 ? ctx.azar.entero(0, lineas.length - 1) : -1;
  const fecha = (await ctx.db.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`)).rows[0].hoy;
  const resultado = await como(ctx, compras, async (tx) => {
    const id = await crearFactura(tx, compras, { ordenId, numeroFactura: `FC-${String(secuencia).padStart(5, '0')}`, numeroControl: `00-${String(secuencia + 40_000).padStart(8, '0')}`, fechaFactura: fecha });
    for (const [i, l] of lineas.entries()) {
      const precio = i === subeUnaLinea ? Number(l.precio_unitario) * 1.2 : Number(l.precio_unitario);
      await guardarLineaFactura(tx, id, { ordenLineaId: l.id, cantidad: l.cantidad, precio: precio.toFixed(2) });
    }
    return { id, ...(await registrarFactura(tx, compras, id)) };
  });
  if (resultado.estado === 'retenida') {
    contar(ctx, 'facturas_compra_retenidas');
    await como(ctx, gerencia, (tx) => resolverAprobacion(tx, 'factura_compra', resultado.id, gerencia.id, 'aprobada'));
  }
  contar(ctx, 'facturas_compra');
  void prov;
}

async function pagarProveedores(ctx: Ctx, fecha: string): Promise<void> {
  const { tesoreria, gerencia } = ctx.u;
  const saldoUsd = async () => Number((await ctx.db.query<{ s: string }>(
    `select coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as s from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
       join cuenta_bancaria b on b.cuenta_contable_id = l.cuenta_id where b.id = $1`, [ctx.cuentaUsdId])).rows[0].s);
  const tasa = Number((await ctx.db.query<{ t: string }>(`select fn_tasa('USD', $1::date)::text as t`, [fecha])).rows[0].t);
  // Mercancía y servicios: lo vencido se paga desde la cuenta de su moneda. Si la cuenta en dólares no alcanza (la empresa cambia
  // bolívares a dólares en el mercado, algo que el ERP todavía no registra), la factura en dólares se paga desde la cuenta en bolívares.
  for (const prov of [...ctx.proveedores, ...ctx.proveedoresServicio]) {
    const vencidas = (await partidasPorPagar(ctx.db, prov.id)).filter((p) => p.vencimiento <= fecha);
    for (const moneda of ['USD', 'VES']) {
      const deMoneda = vencidas.filter((p) => p.moneda === moneda);
      if (!deMoneda.length) continue;
      const total = deMoneda.reduce((s, p) => s + Number(p.saldo), 0);
      const convertir = moneda === 'USD' && (await saldoUsd()) < total + 1000;
      const aplicaciones = deMoneda.map((p) => ({ partidaId: p.partida_id, monto: convertir ? dinero(Number(p.saldo) * tasa) : p.saldo, liquida: true }));
      const pago = await como(ctx, tesoreria, (tx) => solicitarPago(tx, tesoreria, {
        proveedorId: prov.id, fecha, instrumentoId: ctx.instrumentos.transferencia, cuentaBancariaId: moneda === 'USD' && !convertir ? ctx.cuentaUsdId : ctx.cuentaVesId,
        monto: convertir ? dinero(total * tasa) : dinero(total), aplicaciones,
      }));
      await como(ctx, gerencia, (tx) => resolverAprobacion(tx, 'pago_proveedor', pago.id, gerencia.id, 'aprobada'));
      contar(ctx, convertir ? 'pagos_proveedor_usd_desde_bs' : 'pagos_proveedor');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ventas y cobros
// ---------------------------------------------------------------------------------------------------------------------
async function cobrar(ctx: Ctx, cliente: Cliente, partidaId: string, fecha: string, fraccion = 1): Promise<void> {
  const { rows } = await ctx.db.query<{ saldo: string; estado: string }>('select saldo::text, estado from partida_cxc where id = $1', [partidaId]);
  if (!rows[0] || rows[0].estado !== 'abierta') return;
  const saldo = Number(rows[0].saldo);
  const { cobranzas } = ctx.u;
  // Un remanente de centavos no se cobra a medias ni en dólares: se liquida completo en bolívares.
  const remanente = saldo < 5;
  if (remanente) fraccion = 1;
  const liquida = fraccion === 1;
  const enUsd = cliente.pagaEnDivisas && !remanente;
  const tasa = enUsd ? Number((await ctx.db.query<{ t: string }>(`select fn_tasa('USD', $1::date)::text as t`, [fecha])).rows[0].t) : 1;
  const monto = (saldo * fraccion) / tasa;
  await como(ctx, cobranzas, (tx) => registrarCobro(tx, cobranzas, {
    clienteId: cliente.id, fecha, instrumentoId: enUsd ? ctx.instrumentos.zelle : ctx.instrumentos.transferencia,
    cuentaBancariaId: enUsd ? ctx.cuentaUsdId : ctx.cuentaVesId, monto: dinero(monto),
    aplicaciones: [{ partidaId, monto: dinero(monto), liquida }],
  }));
  contar(ctx, 'cobros');
  if (!liquida) programar(ctx, sumarDias(fecha, 12), () => cobrar(ctx, cliente, partidaId, sumarDias(fecha, 12)));
}

async function venderUnPedido(ctx: Ctx, fecha: string, stock: Map<string, number>): Promise<void> {
  const { azar, u } = ctx;
  const cliente = azar.elegir(ctx.clientes);
  const vendedor = cliente.vendedorUsuario;
  const lineas = azar.barajar(ctx.productos.filter((p) => (stock.get(p.id) ?? 0) > 0)).slice(0, azar.entero(1, 5))
    .map((p) => ({ producto: p, cantidad: Math.min(azar.entero(1, 12), Math.floor(stock.get(p.id) ?? 0)) }))
    .filter((l) => l.cantidad > 0);
  if (!lineas.length) { avisar(ctx, 'Sin existencia para armar un pedido'); return; }

  try {
    const pedido = await como(ctx, vendedor, async (tx) => {
      const id = await crearPedido(tx, vendedor, { clienteId: cliente.id, almacenId: ctx.almacenId });
      for (const l of lineas) await agregarLinea(tx, vendedor, id, { productoId: l.producto.id, cantidad: String(l.cantidad) });
      return id;
    });
    const emision = await como(ctx, vendedor, (tx) => emitirPedido(tx, vendedor, pedido));
    if (emision.situacion === 'retenido_credito') {
      contar(ctx, 'pedidos_retenidos_por_credito');
      const aprobar = azar() < 0.7;
      await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'pedido_credito', pedido, u.gerencia.id, aprobar ? 'aprobada' : 'rechazada', aprobar ? {} : { comentario: 'Cliente con mora' }));
      if (!aprobar) { contar(ctx, 'pedidos_rechazados_por_credito'); return; }
    }
    for (const l of lineas) stock.set(l.producto.id, (stock.get(l.producto.id) ?? 0) - l.cantidad);
    contar(ctx, 'pedidos');
    const nota = await como(ctx, vendedor, (tx) => generarNotaEntrega(tx, vendedor, pedido));
    await como(ctx, u.almacen, (tx) => confirmarSalida(tx, u.almacen, nota));
    const factura = await como(ctx, u.facturacion, (tx) => facturarNotas(tx, u.facturacion, [nota], { servicio: new ImprentaSimulada() }));
    contar(ctx, 'facturas_venta');

    // Cuándo paga: contado, ese mismo día; a crédito, al vencimiento más el retraso habitual del cliente.
    const { rows } = await ctx.db.query<{ id: string; vencimiento: string }>('select id, vencimiento::text from partida_cxc where documento_id = $1', [factura.facturaId]);
    const extra = ctx.ruido && cliente.condicionDias > 0 ? retrasoExtra(ctx) : 0;
    const pago = extra === null ? sumarDias(ctx.hasta, 1) : sumarDias(rows[0].vencimiento, cliente.retrasoDias + extra);
    const parcial = cliente.condicionDias > 0 && azar() < 0.15;
    if (pago <= fecha) await cobrar(ctx, cliente, rows[0].id, fecha, parcial ? 0.5 : 1);
    else if (pago <= ctx.hasta) programar(ctx, pago, () => cobrar(ctx, cliente, rows[0].id, pago, parcial ? 0.5 : 1));
  } catch (e) {
    if (!(e instanceof ErrorMaestro)) throw e;
    avisar(ctx, e.message);
    if (process.env.DEMO_DEBUG) console.log(`[${fecha}] venta: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
async function darDeBajaUnActivo(ctx: Ctx, fecha: string): Promise<void> {
  const { u } = ctx;
  const activoId = ctx.estado.activoIds[ctx.estado.activoIds.length - 1];
  const baja = await como(ctx, u.contabilidad, (tx) => solicitarBaja(tx, u.contabilidad, { activoId, fecha, motivo: 'Equipos de cómputo obsoletos: se retiran del servicio' }));
  await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'baja_activo_fijo', baja, u.gerencia.id, 'aprobada'));
  contar(ctx, 'bajas_de_activos');
}

// ---------------------------------------------------------------------------------------------------------------------
// Bucle diario
// ---------------------------------------------------------------------------------------------------------------------
export async function simular(ctx: Ctx, log: (texto: string) => void = () => {}): Promise<void> {
  const inicio = sumarDias(ctx.desde, -7);
  let tasa: number | null = null;
  const pendientesDeCierre = mesesEntre(inicio, ctx.hasta);
  for (const fecha of diasEntre(inicio, ctx.hasta)) {
    fijarReloj(fecha, 8);
    tasa = await registrarTasa(ctx, fecha, tasa);

    // Día 0: arranque con saldos iniciales. Las facturas pendientes de clientes se cobran según el hábito de cada cliente.
    if (fecha === inicio) {
      const partidasApertura = await sembrarApertura(ctx, fecha, tasa);
      await sembrarPlanComision(ctx, fecha);
      await sembrarKits(ctx, fecha);
      // Un activo de la apertura se da de baja unas semanas después (Gerencia aprueba), cuando ya hay meses depreciados antes de la fecha.
      const fechaBaja = sumarDias(inicio, 30);
      if (fechaBaja <= ctx.hasta) programar(ctx, fechaBaja, () => darDeBajaUnActivo(ctx, fechaBaja));
      for (const p of partidasApertura) {
        const cliente = ctx.clientes.find((c) => c.id === p.clienteId)!;
        const habitual = sumarDias(p.vencimiento, cliente.retrasoDias);
        const pago = habitual > sumarDias(inicio, 3) ? habitual : sumarDias(inicio, 3);
        if (pago <= ctx.hasta) programar(ctx, pago, () => cobrar(ctx, cliente, p.partidaId, pago));
      }
    }

    // Primer día del mes: Contabilidad cierra los meses terminados, antes de que entre cualquier documento nuevo.
    if (fecha.endsWith('-01') && fecha > inicio) {
      const anterior = sumarDias(fecha, -1).slice(0, 7);
      while (pendientesDeCierre[0] && `${pendientesDeCierre[0].anio}-${String(pendientesDeCierre[0].mes).padStart(2, '0')}` <= anterior) {
        fijarReloj(fecha, 7);
        const { anio, mes } = pendientesDeCierre.shift()!;
        await cerrarUnMes(ctx, anio, mes);
      }
    }

    const tareas = ctx.agenda.get(fecha) ?? [];
    ctx.agenda.delete(fecha);
    for (const tarea of tareas) { fijarReloj(fecha, 10); await tarea(); }

    const dia = diaSemana(fecha);
    fijarReloj(fecha, 9);
    if (ctx.ruido && fecha > inicio) { fijarReloj(fecha, 8); await ajustarCostos(ctx, fecha, dia); fijarReloj(fecha, 9); }
    if (fecha === inicio || dia === 1) await reponer(ctx, fecha);
    if (dia >= 1 && dia <= 5) { fijarReloj(fecha, 15); await pagarProveedores(ctx, fecha); }

    // Gastos (servicios, caja chica) y notas del proveedor: desde el día siguiente al arranque.
    if (fecha > inicio && dia !== 0 && !(ctx.ruido && esFeriado(fecha))) { fijarReloj(fecha, 11); await gastosDelDia(ctx, fecha, dia); }

    // Producción: los martes Almacén ensambla un kit (después de la reposición, antes de las ventas).
    if (fecha > inicio && dia === 2 && !(ctx.ruido && esFeriado(fecha))) { fijarReloj(fecha, 10); await producirUnKit(ctx); }

    const cerrado = ctx.ruido && esFeriado(fecha);
    if (fecha >= ctx.desde && dia !== 0 && !cerrado) {
      const stock = await existenciaPorProducto(ctx);
      const base = dia === 6 ? ctx.azar.entero(1, 4) : ctx.azar.entero(3, 9);
      const n = ctx.ruido ? Math.max(1, Math.round(base * factorEstacional(fecha))) : base;
      for (let i = 0; i < n; i++) {
        fijarReloj(fecha, 9 + Math.floor((i * 8) / n));
        await venderUnPedido(ctx, fecha, stock);
      }
      fijarReloj(fecha, 17);
      await notasDeVenta(ctx, fecha);
    }
    // Conteo cíclico de los viernes, al final de la jornada.
    if (fecha > inicio && dia === 5 && !(ctx.ruido && esFeriado(fecha))) { fijarReloj(fecha, 18); await ajustarInventario(ctx); }
    if (fecha.endsWith('-01') || fecha === ctx.hasta) log(`  ${fecha} · facturas de venta ${ctx.resumen.facturas_venta ?? 0} · cobros ${ctx.resumen.cobros ?? 0} · órdenes de compra ${ctx.resumen.ordenes_compra ?? 0}`);
  }
}
