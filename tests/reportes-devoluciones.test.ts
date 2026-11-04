import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import {
  devolucionesPorCliente, devolucionesPorProducto, devolucionesPorVendedor, nivelRiesgo, resumenDevoluciones, tendenciaDevoluciones,
} from '@/lib/reportes/devoluciones';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('M5 Devoluciones (spec_reportes §8, §2, §12)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let aceite: string;
  let vendedorId = '';
  let motivoDevolucion = '';
  let anioActual = 0;

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
  async function devolver(f: { facturaId: string; lineaId: string }, cantidad: string): Promise<void> {
    const id = await como(ventas, (tx) => crearNotaCredito(tx, ventas, {
      facturaId: f.facturaId, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: f.lineaId, cantidad }],
    }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, id));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', id, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, id, { servicio: new ImprentaSimulada() }));
  }

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    ventas = { id: idVen, roles: ['ventas'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const h = (await db.query<{ d: string; a: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as d, extract(year from now() at time zone 'America/Caracas')::int as a`)).rows[0];
    anioActual = h.a;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [h.d]);

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
    const clienteC = await cliente('J-00000030-1', 'Frenos del Centro, C.A.');

    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-AC-001', { descripcion: 'Artículo AC-001' }));
    aceite = await db.transaction((tx) => crearProducto(tx, idAlm, 'AC-001', {
      descripcion: 'Aceite de motor', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
    await db.transaction((tx) => fijarPrecio(tx, aceite, 'B', '20.00', h.d));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 500, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));
    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;

    // A: 50 und (US$ 1.000), devuelve 2 (US$ 40 = 4 %: MODERADO). B: 20 und (US$ 400), devuelve 10 (US$ 200 = 50 %: CRÍTICO).
    // C: 5 und (US$ 100) sin devolución.
    const fa = await facturar(clienteA, '50');
    const fb = await facturar(clienteB, '20');
    await facturar(clienteC, '5');
    await devolver(fa, '2');
    await devolver(fb, '10');
  });
  afterAll(() => cerrar());

  it('tarjetas: monto, unidades, tasa financiera sobre venta bruta, facturas afectadas; sin costo si el parámetro no está cargado', async () => {
    const r = await resumenDevoluciones(db, { anios: [anioActual] });
    expect(r).toMatchObject({
      montoUsd: '240.00', unidades: '12.0000', facturasAfectadas: 2, facturasTotal: 3, umbralTasaPct: 5, tasaSobreUmbral: true,
      costoOperativoUsd: null,
    });
    expect(r.tasaFinancieraPct).toBeCloseTo(16, 5);          // 240 ÷ 1.500
    expect(r.facturasAfectadasPct).toBeCloseTo(66.6667, 3);  // 2 de 3
  });

  it('el costo operativo estimado aparece cuando se carga el parámetro (por nota de devolución)', async () => {
    await db.query(`insert into parametro_reporte (codigo, descripcion, valor, unidad) values ('COSTO_POR_DEVOLUCION_USD', 'Costo por devolución', 2.5, 'usd')`);
    const r = await resumenDevoluciones(db, { anios: [anioActual] });
    expect(r.costoOperativoUsd).toBe('5.00'); // 2 notas × 2,50
  });

  it('tendencia mensual: venta, devolución y % devuelto del mes', async () => {
    const t = await tendenciaDevoluciones(db, { anios: [anioActual] });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ anio: anioActual, ventaUsd: '1500.00', devolucionUsd: '240.00' });
    expect(t[0].devueltoPct).toBeCloseTo(16, 5);
  });

  it('por cliente: solo quienes devolvieron, con su % y nivel de riesgo (>8 % crítico, >3 % moderado)', async () => {
    const filas = await devolucionesPorCliente(db, { anios: [anioActual] });
    expect(filas.map((f) => [f.clienteId, f.ventaUsd, f.devueltoUsd, f.unidades, f.facturasAfectadas, f.riesgo])).toEqual([
      [clienteB, '400.00', '200.00', '10.0000', 1, 'CRÍTICO'],
      [clienteA, '1000.00', '40.00', '2.0000', 1, 'MODERADO'],
    ]);
    expect(filas[0].devolucionPct).toBeCloseTo(50, 5);
    expect(filas[1].devolucionPct).toBeCloseTo(4, 5);
  });

  it('por vendedor: venta bruta, devuelto, venta neta, facturas afectadas y %', async () => {
    const filas = await devolucionesPorVendedor(db, { anios: [anioActual] });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ vendedorId, ventaBrutaUsd: '1500.00', devueltoUsd: '240.00', ventaNetaUsd: '1260.00', facturasAfectadas: 2 });
    expect(filas[0].devolucionPct).toBeCloseTo(16, 5);
  });

  it('por producto: monto devuelto desde la línea de la NC (no cero) y ALERTA DEFECTO con 12 und y 16 % en volumen', async () => {
    const filas = await devolucionesPorProducto(db, { anios: [anioActual] });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      productoId: aceite, codigo: 'AC-001', unidadesVendidas: '75.0000', unidadesDevueltas: '12.0000', devueltoUsd: '240.00', alertaDefecto: true,
    });
    expect(filas[0].devolucionPct).toBeCloseTo(16, 5);
  });

  it('la alerta de defecto exige también las unidades mínimas (parámetro)', async () => {
    await db.query(`update parametro_reporte set valor = 20 where codigo = 'DEFECTO_UNIDADES_MINIMAS'`);
    expect((await devolucionesPorProducto(db, { anios: [anioActual] }))[0].alertaDefecto).toBe(false);
  });

  it('coherencia con M1/M3: lo devuelto por cliente suma lo de la tarjeta', async () => {
    const total = (await devolucionesPorCliente(db, { anios: [anioActual] })).reduce((s, f) => s + Number(f.devueltoUsd), 0);
    expect(total.toFixed(2)).toBe((await resumenDevoluciones(db, { anios: [anioActual] })).montoUsd);
  });

  it('un año sin ventas: ceros y N/A, nunca NaN', async () => {
    const r = await resumenDevoluciones(db, { anios: [anioActual - 5] });
    expect(r).toMatchObject({ montoUsd: '0.00', unidades: '0.0000', tasaFinancieraPct: null, facturasAfectadas: 0, facturasAfectadasPct: null, tasaSobreUmbral: false });
    expect(await devolucionesPorCliente(db, { anios: [anioActual - 5] })).toEqual([]);
    expect(await tendenciaDevoluciones(db, { anios: [anioActual - 5] })).toEqual([]);
  });

  it('nivelRiesgo respeta los umbrales (estrictamente mayor que)', () => {
    expect([nivelRiesgo(8, 8, 3), nivelRiesgo(8.1, 8, 3), nivelRiesgo(3, 8, 3), nivelRiesgo(3.1, 8, 3), nivelRiesgo(null, 8, 3)])
      .toEqual(['MODERADO', 'CRÍTICO', 'NORMAL', 'MODERADO', 'NORMAL']);
  });
});
