import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { aprobarLoteMetas, crearLoteMetas } from '@/lib/maestros/metas';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { registrarCobro } from '@/lib/ventas/cobros';
import { facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import {
  clientesActivos90Dias, cobranzaPendiente, productosEnQuiebre, ventaMensualConMeta, ventaMes,
} from '@/lib/reportes/inicio';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('Inicio: vw_venta_documento y tarjetas comerciales (spec_reportes §2, §3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let mostrador: string;
  let clienteA: string;
  let aceite: string;
  let cuentaVes: string;
  let transferencia = '';
  let hoy = '';
  let anio = 0;
  let mes = 0;
  let facturaId = '';
  let partidaId = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    ventas = { id: idVen, roles: ['ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const h = (await db.query<{ d: string; a: number; m: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as d,
              extract(year from now() at time zone 'America/Caracas')::int as a,
              extract(month from now() at time zone 'America/Caracas')::int as m`)).rows[0];
    hoy = h.d; anio = h.a; mes = h.m;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [hoy]);

    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const c = await db.transaction((tx) => crearCliente(tx, idFac, {
      rif: 'J-00000010-7', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: { vendedorId: vend.id },
    }));
    await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
    clienteA = c.id;

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

    // Factura emitida hoy: Bs 4.000 (US$ 100 a la tasa de hoy), sin IVA (exento).
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: clienteA, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: aceite, cantidad: '5' }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    facturaId = f.facturaId;
    const { rows: p } = await db.query<{ id: string }>('select id from partida_cxc where documento_id = $1', [facturaId]);
    partidaId = p[0].id;

    // Meta global del mes en curso, aprobada por un usuario distinto de quien la creó (segregación de funciones).
    await db.transaction((tx) => crearLoteMetas(tx, idSup, 'manual', [{ fila: 1, tipo: 'global', anio, mes, monto: '500' }]));
    const { rows: lote } = await db.query<{ id: string }>(`select id from meta_lote order by created_at desc limit 1`);
    await db.transaction((tx) => aprobarLoteMetas(tx, lote[0].id, idGer));
  });
  afterAll(() => cerrar());

  it('vw_venta_documento calcula la base en USD de la factura, sin IVA ni IGTF', async () => {
    const { rows } = await db.query<{ cliente_id: string; base_usd: string; total_usd: string; saldo_usd: string; cancelada: boolean }>(
      'select cliente_id, base_usd::text, total_usd::text, saldo_usd::text, cancelada from vw_venta_documento where id = $1', [facturaId]);
    expect(rows[0]).toMatchObject({ cliente_id: clienteA, base_usd: '100.00', total_usd: '100.00', saldo_usd: '100.00', cancelada: false });
  });

  it('ventaMes, clientes activos, cobranza pendiente y productos en quiebre reflejan la factura emitida', async () => {
    expect((await ventaMes(db)).ventaUsd).toBe('100.00');
    expect(await clientesActivos90Dias(db)).toBe(1);
    expect(await cobranzaPendiente(db)).toEqual({ deudaUsd: '100.00', vencidoUsd: '0.00' });
    // Sin movimientos de disponibilidad registrados para hoy, el producto no entra en RIESGO_QUIEBRE.
    expect(await productosEnQuiebre(db)).toBe(0);
  });

  it('el gráfico de venta mensual trae 6 meses, con la venta del mes en curso y su meta global', async () => {
    const serie = await ventaMensualConMeta(db, 6);
    expect(serie).toHaveLength(6);
    const actual = serie.at(-1)!;
    expect(actual).toMatchObject({ anio, mes, ventaUsd: '100.00', metaUsd: '500.00' });
    expect(serie.slice(0, 5).every((m) => m.metaUsd === null)).toBe(true);
  });

  it('al liquidar la factura, vw_venta_documento la marca cancelada con su fecha y la deuda baja a cero', async () => {
    await como(cobranzas, (tx) => registrarCobro(tx, cobranzas, {
      clienteId: clienteA, fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, monto: '4000',
      aplicaciones: [{ partidaId, monto: '4000', liquida: true }],
    }));
    const { rows } = await db.query<{ saldo_usd: string; cancelada: boolean; fecha_cancelacion: string | null }>(
      'select saldo_usd::text, cancelada, fecha_cancelacion::text from vw_venta_documento where id = $1', [facturaId]);
    expect(rows[0]).toMatchObject({ saldo_usd: '0.00', cancelada: true, fecha_cancelacion: hoy });
    expect(await cobranzaPendiente(db)).toEqual({ deudaUsd: '0.00', vencidoUsd: '0.00' });
  });
});
