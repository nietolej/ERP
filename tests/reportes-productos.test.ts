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
import { catalogoProductos } from '@/lib/reportes/productos';
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
});
