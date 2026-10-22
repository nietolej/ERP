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
  analisisGrupos, catalogoProductos, comparativaMultianual, detalleProductoAnio, kardexProducto, stockPorAlmacen,
} from '@/lib/reportes/productos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('M2 Productos: catálogo de artículos (spec_reportes §5.1, §2, §12)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let mostrador: string;
  let clienteA: string;
  let aceite: string;
  let motivoDevolucion = '';
  let hoy = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });

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
    hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
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
    const grupo = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'ACEITES', 'Aceites'));
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-AC-001', { descripcion: 'Artículo AC-001' }));
    aceite = await db.transaction((tx) => crearProducto(tx, idAlm, 'AC-001', {
      descripcion: 'Aceite de motor', productoBaseId: base.id, grupoId: grupo, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
    await db.transaction(async (tx) => {
      await fijarPrecio(tx, aceite, 'A', '25.00', hoy);
      await fijarPrecio(tx, aceite, 'B', '20.00', hoy);
      await fijarPrecio(tx, aceite, 'D', '15.00', hoy);
    });
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 50, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));

    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;

    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: clienteA, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: aceite, cantidad: '5' }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const { rows: lin } = await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [f.facturaId]);

    const ncId = await como(ventas, (tx) => crearNotaCredito(tx, ventas, {
      facturaId: f.facturaId, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: lin[0].id, cantidad: '2' }],
    }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, ncId));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', ncId, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, ncId, { servicio: new ImprentaSimulada() }));
  });
  afterAll(() => cerrar());

  it('el catálogo trae precios A/D, costo promedio (aparte), stock, unidades vendidas, venta y devolución', async () => {
    const filas = await catalogoProductos(db, { texto: 'AC-001' });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      codigo: 'AC-001', descripcion: 'Aceite de motor', grupo: 'Aceites', marca: 'Genérica',
      precioAUsd: '25.00', precioDUsd: '15.00', costoPromedioUsd: '6.5000',
      stock: '47.0000',            // 50 comprados - 5 despachados + 2 reingresados por la devolución
      unidadesVendidas: '5.0000', ventaUsd: '100.00', devolucionUsd: '40.00',
    });
  });

  it('el filtro de año solo cuenta la venta y la devolución de los años seleccionados, nunca el stock ni el precio', async () => {
    const anioSiguiente = Number(hoy.slice(0, 4)) + 1;
    const filas = await catalogoProductos(db, { texto: 'AC-001', anios: [anioSiguiente] });
    expect(filas[0]).toMatchObject({
      precioAUsd: '25.00', stock: '47.0000', unidadesVendidas: '0.0000', ventaUsd: '0.00', devolucionUsd: '0.00',
    });
  });

  it('la búsqueda por texto no encuentra productos que no coinciden', async () => {
    expect(await catalogoProductos(db, { texto: 'NO-EXISTE' })).toEqual([]);
  });

  it('análisis por código común agrupa el artículo con el total de artículos, venta, devolución, stock valorizado y el líder', async () => {
    const grupos = await analisisGrupos(db, 'codigo_comun');
    const g = grupos.find((x) => x.codigo === 'BASE-AC-001')!;
    expect(g).toMatchObject({
      nombre: 'Artículo AC-001', totalArticulos: 1, unidadesVendidas: '5.0000', ventaUsd: '100.00', devolucionUsd: '40.00',
      stockValorizadoUsd: (47 * 6.5).toFixed(2), // 47 unidades × US$ 6,50 de costo promedio
      productoLider: { codigo: 'AC-001', descripcion: 'Aceite de motor' },
    });
  });

  it('análisis por categoría agrupa bajo "Sin categoría" el artículo que no tiene categoría asignada', async () => {
    const grupos = await analisisGrupos(db, 'categoria');
    const g = grupos.find((x) => x.nombre === 'Sin categoría')!;
    expect(g).toMatchObject({ totalArticulos: 1, ventaUsd: '100.00', productoLider: { codigo: 'AC-001' } });
  });

  it('el detalle del producto trae sus tarjetas, los ratios de devolución, la evolución mensual y el top de clientes', async () => {
    const d = await detalleProductoAnio(db, 'AC-001');
    expect(d).toMatchObject({
      producto: { codigo: 'AC-001', descripcion: 'Aceite de motor', grupo: 'Aceites', marca: 'Genérica' },
      ventaTotalUsd: '100.00', unidadesVendidas: '5.0000', pedidos: 1,
      stockDisponible: '47.0000',
      diasInventario: '15.7', diasSinInventario: 0, // de vw_disponibilidad (misma fuente que el reporte de inventario)
      tasaDevolucionPct: 40,
      ratiosDevolucion: { montoPct: 40, cantidadPct: 40, pedidosPct: 100 },
    });
    expect(d!.topClientes).toEqual([{
      clienteId: clienteA, codigo: 'C00001', razonSocial: 'Repuestos Lara, C.A.', cantidad: '5.0000', montoUsd: '100.00', compras: 1, ultimaCompra: hoy,
    }]);
    const mesHoy = Number(hoy.slice(5, 7));
    const fila = d!.evolucionMensual.find((m) => m.mes === mesHoy)!;
    expect(fila).toMatchObject({ ventaUsd: '100.00', devolucionUsd: '40.00' });
    expect(d!.evolucionMensual.filter((m) => m.mes !== mesHoy).every((m) => m.ventaUsd === '0.00' && m.devolucionUsd === '0.00')).toBe(true);
  });

  it('un código que no existe devuelve null', async () => {
    expect(await detalleProductoAnio(db, 'NO-EXISTE')).toBeNull();
  });

  it('el stock por almacén trae la existencia, lo reservado, lo disponible y si el almacén es vendible', async () => {
    const filas = await stockPorAlmacen(db, aceite);
    expect(filas).toEqual([{
      almacenId: mostrador, codigo: 'MOS', nombre: 'Mostrador', sucursal: 'Barquisimeto',
      cantidad: '47.0000', reservado: '0.0000', disponible: '47.0000', vendible: true,
    }]);
  });

  it('el kardex trae la entrada, la salida por venta y el reingreso de la devolución, con el stock progresivo', async () => {
    const filas = await kardexProducto(db, aceite);
    expect(filas.map((f) => ({ tipo: f.tipo, documento: f.documento, cantidad: f.cantidad, stockAlmacen: f.stockAlmacen, stockTotal: f.stockTotal }))).toEqual([
      { tipo: 'Entrada por compra', documento: 'prueba', cantidad: '50.0000', stockAlmacen: '50.0000', stockTotal: '50.0000' },
      { tipo: 'Salida por venta', documento: 'A-1', cantidad: '-5.0000', stockAlmacen: '45.0000', stockTotal: '45.0000' },
      { tipo: 'Devolución de cliente', documento: 'A-1', cantidad: '2.0000', stockAlmacen: '47.0000', stockTotal: '47.0000' },
    ]);
  });

  it('la comparativa multianual contrasta un año vacío (A) contra el año con ventas (B)', async () => {
    const anioActual = Number(hoy.slice(0, 4));
    const c = await comparativaMultianual(db, aceite, anioActual - 1, anioActual);
    expect(c.venta).toEqual({ a: '0.00', b: '100.00', variacionAbsoluta: '100.00', variacionPct: 100 });
    expect(c.cantidad).toEqual({ a: '0.0000', b: '5.0000', variacionAbsoluta: '5.0000', variacionPct: 100 });
    expect(c.pedidos).toEqual({ a: '0', b: '1', variacionAbsoluta: '1', variacionPct: 100 });
    expect(c.devolucion).toEqual({ a: '0.00', b: '40.00', variacionAbsoluta: '40.00', variacionPct: 100 });
    const mesHoy = Number(hoy.slice(5, 7));
    expect(c.mensual.find((m) => m.mes === mesHoy)).toMatchObject({ ventaA: '0.00', ventaB: '100.00' });
    expect(c.mensual.filter((m) => m.mes !== mesHoy).every((m) => m.ventaA === '0.00' && m.ventaB === '0.00')).toBe(true);
  });
});
