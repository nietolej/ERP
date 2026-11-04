import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { registrarCobro } from '@/lib/ventas/cobros';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import {
  antiguedadSaldos, bancosYCanales, cobranzaPorCliente, cobranzaPorVendedor, comportamientoDe, resumenCobranza, tendenciaCobranza,
  velocidadCobro,
} from '@/lib/reportes/cobranzas';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('M4 Cobranzas (spec_reportes §7, §2, §12)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let aceite: string;
  let cuentaVes: string;
  let transferencia = '';
  let vendedorId = '';
  let hoy = '';
  let anioActual = 0;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });

  async function facturar(cliente: string, cantidad: string): Promise<string> {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: aceite, cantidad }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    return f.facturaId;
  }
  /** La partida de CxC no se edita en producción; la prueba retrocede sus fechas para simular facturas antiguas. */
  async function retroceder(facturaId: string, diasEmision: number, diasVencimiento: number): Promise<void> {
    await db.query('alter table partida_cxc disable trigger partida_cxc_reglas');
    await db.query('update partida_cxc set fecha = fecha - $2::int, vencimiento = vencimiento - $3::int where documento_id = $1',
      [facturaId, diasEmision, diasVencimiento]);
    await db.query('alter table partida_cxc enable trigger partida_cxc_reglas');
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
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    ventas = { id: idVen, roles: ['ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const h = (await db.query<{ d: string; a: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as d, extract(year from now() at time zone 'America/Caracas')::int as a`)).rows[0];
    hoy = h.d; anioActual = h.a;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [hoy]);

    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    vendedorId = vend.id;
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
    transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;

    // Cliente A: f1 (US$ 100) cobrada el mismo día (0 días); f2 (US$ 100) emitida hace 40 días y cobrada hoy (40 días).
    const f1 = await facturar(clienteA, '5');
    const f2 = await facturar(clienteA, '5');
    await retroceder(f2, 40, 40);
    await pagarSaldo(clienteA, f1);
    await pagarSaldo(clienteA, f2);
    // Cliente B: f3 (US$ 100) sin cobrar, emitida hace 100 días y vencida hace 50.
    const f3 = await facturar(clienteB, '5');
    await retroceder(f3, 100, 50);
  });
  afterAll(() => cerrar());

  it('tarjetas: cobrado, DSO ponderado con mediana, % a tiempo y efectividad de cobro', async () => {
    const r = await resumenCobranza(db, { anios: [anioActual] });
    expect(r).toMatchObject({
      cobradoUsd: '200.00', pagos: 2, aTiempoPct: 50,
      facturadoUsd: '300.00', pendienteUsd: '100.00',
    });
    expect(r.diasPromedio).toBeCloseTo(20, 5);   // (100×0 + 100×40) ÷ 200
    expect(r.diasMediana).toBeCloseTo(20, 5);
    expect(r.efectividadPct).toBeCloseTo(66.6667, 3); // (300 − 100) ÷ 300
  });

  it('velocidad de cobro: siempre los cuatro tramos, con monto, pagos y % del cobro', async () => {
    const v = await velocidadCobro(db, { anios: [anioActual] });
    expect(v.map((t) => ({ tramo: t.tramo, monto: t.montoUsd, pagos: t.pagos, pct: t.pct }))).toEqual([
      { tramo: 'pronto_pago', monto: '100.00', pagos: 1, pct: 50 },
      { tramo: 'puntual', monto: '0.00', pagos: 0, pct: 0 },
      { tramo: 'mora_leve', monto: '100.00', pagos: 1, pct: 50 },
      { tramo: 'mora_critica', monto: '0.00', pagos: 0, pct: 0 },
    ]);
  });

  it('antigüedad de saldos: la deuda abierta cae en el tramo según se cuente desde el vencimiento o la emisión', async () => {
    const porVencimiento = await antiguedadSaldos(db, { anios: [anioActual] }, 'vencimiento');
    expect(porVencimiento.map((t) => [t.tramo, t.montoUsd, t.facturas])).toEqual([
      ['0-30 días', '0.00', 0], ['31-60 días', '100.00', 1], ['61-90 días', '0.00', 0], ['Más de 90 días', '0.00', 0],
    ]);
    expect(porVencimiento[1].pct).toBe(100);
    const porEmision = await antiguedadSaldos(db, {}, 'emision');
    expect(porEmision.map((t) => [t.tramo, t.montoUsd, t.facturas])).toEqual([
      ['0-30 días', '0.00', 0], ['31-60 días', '0.00', 0], ['61-90 días', '0.00', 0], ['Más de 90 días', '100.00', 1],
    ]);
  });

  it('tendencia mensual: el cobro de hoy cae en un solo mes con sus días promedio', async () => {
    const t = await tendenciaCobranza(db, { anios: [anioActual] });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ anio: anioActual, montoUsd: '200.00' });
    expect(t[0].diasPromedio).toBeCloseTo(20, 5);
  });

  it('por vendedor: monto, cobros, días promedio y mediana, % a tiempo, % mora y deuda de su cartera', async () => {
    const filas = await cobranzaPorVendedor(db, { anios: [anioActual] });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      vendedorId, cobradoUsd: '200.00', cobros: 2, aTiempoPct: 50, moraPct: 50, deudaUsd: '100.00',
    });
    expect(filas[0].diasPromedio).toBeCloseTo(20, 5);
    expect(filas[0].diasMediana).toBeCloseTo(20, 5);
  });

  it('por cliente: incluye a quien tiene deuda sin cobros, y filtra por categoría y por texto', async () => {
    const todos = await cobranzaPorCliente(db, { anios: [anioActual] });
    expect(todos.map((c) => [c.clienteId, c.cobradoUsd, c.deudaUsd, c.comportamiento])).toEqual([
      [clienteA, '200.00', '0.00', 'Puntual'],
      [clienteB, '0.00', '100.00', 'Sin cobros'],
    ]);
    expect(todos[0].asesor).toBe('Pedro Pérez');
    expect((await cobranzaPorCliente(db, { anios: [anioActual], categoria: 'con_deuda' })).map((c) => c.clienteId)).toEqual([clienteB]);
    expect((await cobranzaPorCliente(db, { anios: [anioActual], categoria: 'mora_critica' }))).toEqual([]);
    expect((await cobranzaPorCliente(db, { anios: [anioActual], texto: 'lara' })).map((c) => c.clienteId)).toEqual([clienteA]);
  });

  it('bancos y canales: monto, transacciones y participación por cuenta y por instrumento', async () => {
    const b = await bancosYCanales(db, { anios: [anioActual] });
    expect(b.porCuenta).toHaveLength(1);
    expect(b.porCuenta[0]).toMatchObject({ montoUsd: '200.00', transacciones: 2, participacionPct: 100 });
    expect(b.porCuenta[0].nombre).toContain('Banco Nacional Bs');
    expect(b.porInstrumento.map((i) => [i.montoUsd, i.transacciones, i.participacionPct])).toEqual([['200.00', 2, 100]]);
  });

  it('un año sin cobros muestra ceros y N/A, nunca NaN', async () => {
    const r = await resumenCobranza(db, { anios: [anioActual - 5] });
    expect(r).toMatchObject({ cobradoUsd: '0.00', pagos: 0, diasPromedio: null, diasMediana: null, aTiempoPct: null, efectividadPct: null });
  });

  it('seguridad por fila: un vendedor sin cartera no ve cobros ajenos', async () => {
    const otro = await db.transaction((tx) => crearVendedor(tx, ventas.id, { nombre: 'Otro Vendedor', tipo: 'interno' }));
    const r = await resumenCobranza(db, { anios: [anioActual], vendedorId: otro.id });
    expect(r).toMatchObject({ cobradoUsd: '0.00', pagos: 0, facturadoUsd: '0.00' });
  });

  it('comportamiento por días de pago promedio: ≤30 puntual, 31-60 mora leve, más de 60 mora crítica', () => {
    expect([comportamientoDe(30), comportamientoDe(30.1), comportamientoDe(60), comportamientoDe(61), comportamientoDe(null)])
      .toEqual(['Puntual', 'Mora leve', 'Mora leve', 'Mora crítica', 'Sin cobros']);
  });
});
