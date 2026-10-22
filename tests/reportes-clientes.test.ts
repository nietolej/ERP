import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { aprobarLoteMetas, crearLoteMetas } from '@/lib/maestros/metas';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { registrarCobro } from '@/lib/ventas/cobros';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion, type DatosNotaCredito } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import {
  analisisAnio, analisisHistorico, comparacionPeriodos, partidasAbiertas, periodosPorDefecto, topItems,
} from '@/lib/reportes/clientes';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('M1 Clientes: análisis por año (spec_reportes §4.1, §2, §12)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let clienteC: string;
  let aceite: string;
  let cuentaVes: string;
  let transferencia = '';
  let motivoDevolucion = '';
  let motivoDescuento = '';
  let hoy = '';
  let anioActual = 0;
  let diasTranscurridos = 0;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });

  async function facturar(cliente: string, cantidad: string): Promise<{ facturaId: string; lineaId: string }> {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: aceite, cantidad }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const { rows } = await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [f.facturaId]);
    return { facturaId: f.facturaId, lineaId: rows[0].id };
  }
  async function nota(d: DatosNotaCredito): Promise<string> {
    const id = await como(ventas, (tx) => crearNotaCredito(tx, ventas, d));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, id));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', id, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, id, { servicio: new ImprentaSimulada() }));
    return id;
  }
  async function pagarSaldo(cliente: string, facturaId: string): Promise<void> {
    const { rows } = await db.query<{ id: string; saldo: string }>('select id, saldo::text from partida_cxc where documento_id = $1', [facturaId]);
    await como(cobranzas, (tx) => registrarCobro(tx, cobranzas, {
      clienteId: cliente, fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, monto: rows[0].saldo,
      aplicaciones: [{ partidaId: rows[0].id, monto: rows[0].saldo, liquida: true }],
    }));
  }

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    ventas = { id: idVen, roles: ['ventas'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const h = (await db.query<{ d: string; a: number; doy: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as d,
              extract(year from now() at time zone 'America/Caracas')::int as a,
              extract(doy from now() at time zone 'America/Caracas')::int as doy`)).rows[0];
    hoy = h.d; anioActual = h.a; diasTranscurridos = h.doy;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [hoy]);

    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, idFac, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    clienteA = await cliente('J-00000010-7', 'Repuestos Lara, C.A.');
    clienteB = await cliente('J-00000020-4', 'Autopartes Sur, C.A.');
    clienteC = await cliente('J-00000030-1', 'Frenos del Centro, C.A.');

    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-AC-001', { descripcion: 'Artículo AC-001' }));
    aceite = await db.transaction((tx) => crearProducto(tx, idAlm, 'AC-001', {
      descripcion: 'Aceite de motor', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
    await db.transaction((tx) => fijarPrecio(tx, aceite, 'B', '20.00', hoy));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 500, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));

    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(cobranzas, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    const instrumentos = await listarInstrumentos(db);
    transferencia = instrumentos.find((i) => i.codigo === 'TRANSFERENCIA')!.id;
    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;
    motivoDescuento = (await db.query<{ id: string }>(`select id from motivo where tipo = 'descuento' and codigo = 'VOLUMEN'`)).rows[0].id;

    // --- Cliente A: deuda activa (dispara el insight de "deuda"), con descuento comercial y devolución. ---
    const f1 = await facturar(clienteA, '10');                                         // US$ 200, sin pagar
    const f2 = await facturar(clienteA, '5');                                          // US$ 100
    await nota({ facturaId: f2.facturaId, clase: 'descuento_comercial', porcentaje: '10', motivoId: motivoDescuento });
    await facturar(clienteA, '5');                                                     // US$ 100, sin NC, sin pagar
    await nota({ facturaId: f1.facturaId, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: f1.lineaId, cantidad: '2' }] }); // US$ 40
    const f4 = await facturar(clienteA, '5');                                          // US$ 100
    await nota({ facturaId: f4.facturaId, clase: 'pronto_pago', porcentaje: '20' });    // US$ 20
    await pagarSaldo(clienteA, f4.facturaId);                                          // liquida f4: queda cancelada

    // --- Cliente B: sin deuda, índice de devolución alto (dispara el insight de "devolución"). ---
    const f5 = await facturar(clienteB, '5');                                          // US$ 100
    await nota({ facturaId: f5.facturaId, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: f5.lineaId, cantidad: '1' }] }); // US$ 20 (20 %)
    await pagarSaldo(clienteB, f5.facturaId);

    // --- Cliente C: sin deuda, sin devolución, meta mínima (dispara el insight de "tendencia"). ---
    const f6 = await facturar(clienteC, '1');                                          // US$ 20
    await pagarSaldo(clienteC, f6.facturaId);
    await db.transaction((tx) => crearLoteMetas(tx, idSup, 'manual', [{ fila: 1, tipo: 'cliente', entidadId: clienteC, anio: anioActual, mes: null, monto: '1' }]));
    const { rows: lote } = await db.query<{ id: string }>(`select id from meta_lote order by created_at desc limit 1`);
    await db.transaction((tx) => aprobarLoteMetas(tx, lote[0].id, idGer));
  });
  afterAll(() => cerrar());

  it('cliente A: venta, devolución, descuentos ponderados, CxC y el insight de deuda', async () => {
    const r = await analisisAnio(db, { clienteId: clienteA, anios: [anioActual] });
    expect(r.finanzasMetas.ventaTotalUsd).toBe('500.00');
    expect(r.volumenOperaciones).toMatchObject({ pedidos: 1, ticketPromedioUsd: '500.00', itemsVendidos: '25.0000' });
    expect(r.devoluciones).toMatchObject({ montoUsd: '40.00', items: '2.0000', pedidos: 1, indiceMontoPct: 8, indiceItemsPct: 8, indicePedidosPct: 100 });
    expect(r.descuentos).toMatchObject({
      facturaUsd: '10.00', facturaPct: 2, prontoPagoUsd: '20.00', prontoPagoPct: 20, totalUsd: '30.00', totalPct: 6,
    });
    expect(r.cobranzasCxC).toMatchObject({ deudaActualUsd: '350.00', deudaEmitidaEnPeriodoUsd: '350.00', vencimientoMasAntiguo: hoy, diasPagoPromedio: 0 });
    expect(r.insight).toEqual({ tipo: 'deuda', mensaje: 'Deuda activa de $350.00. Monitorear fechas de vencimiento.' });
    expect(r.pagosPorInstrumento).toEqual([{ instrumento: 'Transferencia bancaria', montoUsd: '80.00', pct: 100 }]);
    // Tendencia: venta × 365 ÷ días transcurridos del año en curso.
    const tendenciaEsperada = (500 * 365) / diasTranscurridos;
    expect(Number(r.finanzasMetas.tendenciaUsd)).toBeCloseTo(tendenciaEsperada, 1);
  });

  it('la evolución mensual del año en curso trae la venta y la devolución del mes con factura', async () => {
    const r = await analisisAnio(db, { clienteId: clienteA, anios: [anioActual] });
    expect(r.evolucionMensual).toHaveLength(12);
    const mesHoy = Number(hoy.slice(5, 7));
    const fila = r.evolucionMensual.find((m) => m.mes === mesHoy)!;
    expect(fila).toMatchObject({ anio: anioActual, ventaUsd: '500.00', devolucionUsd: '40.00' });
    expect(r.evolucionMensual.filter((m) => m.mes !== mesHoy).every((m) => m.ventaUsd === '0.00' && m.devolucionUsd === '0.00')).toBe(true);
  });

  it('top ítems por cantidad y por monto, limitado al cliente filtrado', async () => {
    const porCantidad = await topItems(db, { clienteId: clienteA, anios: [anioActual] }, 'cantidad');
    expect(porCantidad).toHaveLength(1);
    expect(porCantidad[0]).toMatchObject({ codigo: 'AC-001', cantidad: '25.0000', montoUsd: '500.00' });
    const porMonto = await topItems(db, { clienteId: clienteA, anios: [anioActual] }, 'monto');
    expect(porMonto[0]).toMatchObject({ codigo: 'AC-001', montoUsd: '500.00' });
  });

  it('cliente B: sin deuda y con índice de devolución por encima del umbral dispara el insight de devolución', async () => {
    const r = await analisisAnio(db, { clienteId: clienteB, anios: [anioActual] });
    expect(r.cobranzasCxC.deudaActualUsd).toBe('0.00');
    expect(r.devoluciones.indiceMontoPct).toBe(20);
    expect(r.insight).toEqual({ tipo: 'devolucion', mensaje: 'Investigar calidad del último lote.' });
  });

  it('cliente C: sin deuda, sin devolución y cumpliendo de sobra una meta mínima dispara el insight de tendencia', async () => {
    const r = await analisisAnio(db, { clienteId: clienteC, anios: [anioActual] });
    expect(r.cobranzasCxC.deudaActualUsd).toBe('0.00');
    expect(r.devoluciones.indiceMontoPct).toBe(0);
    expect(r.finanzasMetas.metaUsd).toBe('1.00');
    expect(r.finanzasMetas.cumplimientoTendenciaPct).toBeGreaterThan(100);
    expect(r.insight).toEqual({ tipo: 'tendencia', mensaje: 'Considerar programa de lealtad.' });
  });

  it('la vista global suma los tres clientes', async () => {
    const r = await analisisAnio(db, { anios: [anioActual] });
    expect(r.finanzasMetas.ventaTotalUsd).toBe('620.00'); // 500 (A) + 100 (B) + 20 (C)
  });

  it('el histórico de cliente A usa las mismas funciones que "por año", con un único año de datos', async () => {
    const h = await analisisHistorico(db, { clienteId: clienteA });
    expect(h.total.finanzasMetas.ventaTotalUsd).toBe('500.00');
    expect(h.total.devoluciones.montoUsd).toBe('40.00');
    expect(h.porAnio).toHaveLength(1);
    expect(h.porAnio[0]).toMatchObject({ anio: anioActual });
    expect(h.porAnio[0].finanzasMetas.ventaTotalUsd).toBe(h.total.finanzasMetas.ventaTotalUsd);
  });

  it('el estado de cuenta global del cliente A lista solo las partidas abiertas, con su monto, abono y saldo', async () => {
    const partidas = await partidasAbiertas(db, { clienteId: clienteA });
    expect(partidas).toHaveLength(3); // f1, f2 y f3: f4 quedó cancelada
    const porMonto = [...partidas].sort((a, b) => Number(b.montoOriginalUsd) - Number(a.montoOriginalUsd));
    expect(porMonto.map((p) => ({ monto: p.montoOriginalUsd, abonado: p.abonadoUsd, saldo: p.saldoUsd, mora: p.mora }))).toEqual([
      { monto: '200.00', abonado: '40.00', saldo: '160.00', mora: 'Al día' },  // f1: devolución de 2 unidades
      { monto: '100.00', abonado: '10.00', saldo: '90.00', mora: 'Al día' },   // f2: descuento comercial del 10 %
      { monto: '100.00', abonado: '0.00', saldo: '100.00', mora: 'Al día' },   // f3: sin notas ni cobros
    ]);
  });

  it('la comparación de periodos contrasta un año vacío (A) contra el año con datos (B) del cliente A', async () => {
    const c = await comparacionPeriodos(db, {
      clienteId: clienteA,
      periodoA: { desde: `${anioActual - 1}-01-01`, hasta: `${anioActual - 1}-12-31` },
      periodoB: { desde: `${anioActual}-01-01`, hasta: hoy },
    });
    expect(c.ventaTotal).toEqual({ a: '0.00', b: '500.00', variacionAbsoluta: '500.00', variacionPct: 100 });
    expect(c.devolucionMonto).toEqual({ a: '0.00', b: '40.00', variacionAbsoluta: '40.00', variacionPct: 100 });
    expect(c.pedidos).toEqual({ a: '0', b: '1', variacionAbsoluta: '1', variacionPct: 100 });
    // El panel global nunca depende del periodo: siempre la deuda y el vencimiento de hoy.
    expect(c.global).toMatchObject({ deudaActualUsd: '350.00', vencimientoMasAntiguo: hoy, ultimaCompra: hoy });
  });

  it('periodosPorDefecto compara el año anterior contra el actual, al mismo día (con el resguardo del 29 de febrero)', () => {
    expect(periodosPorDefecto('2026-10-22')).toEqual({
      periodoA: { desde: '2025-01-01', hasta: '2025-10-22' },
      periodoB: { desde: '2026-01-01', hasta: '2026-10-22' },
    });
    // 2028 es bisiesto y 2027 no: el 29 de febrero retrocede al 28.
    expect(periodosPorDefecto('2028-02-29').periodoA).toEqual({ desde: '2027-01-01', hasta: '2027-02-28' });
  });
});
