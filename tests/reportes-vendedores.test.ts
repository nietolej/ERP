import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { aprobarLoteMetas, crearLoteMetas } from '@/lib/maestros/metas';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import { analiticaEstrategicaVendedor, catalogoVendedores, comparativaMultianualVendedor, vistaGeneralVendedor } from '@/lib/reportes/vendedores';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('M3 Vendedores: catálogo (spec_reportes §6.1, §2, §12)', () => {
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
  let vendedorId: string;
  const emailVendedor = 'ventas@prueba.test';
  let motivoDevolucion = '';
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

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, emailVendedor, ['ventas']);
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
       values ('entrada_compra', $1, $2, 50, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));

    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;

    // Cliente A: 5 unidades (US$ 100), con una devolución de 2 unidades (US$ 40).
    const facturaA = await facturar(clienteA, '5');
    const { rows: lin } = await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [facturaA]);
    const ncId = await como(ventas, (tx) => crearNotaCredito(tx, ventas, {
      facturaId: facturaA, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: lin[0].id, cantidad: '2' }],
    }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, ncId));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', ncId, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, ncId, { servicio: new ImprentaSimulada() }));

    // Cliente B: 3 unidades (US$ 60), sin devolución.
    await facturar(clienteB, '3');

    // Meta del vendedor para el año en curso.
    const idSupMeta = await usuarioDePrueba(db, 'supervisor2@prueba.test', ['supervisor_ventas']);
    await db.transaction((tx) => crearLoteMetas(tx, idSupMeta, 'manual', [{ fila: 1, tipo: 'vendedor', entidadId: vendedorId, anio: anioActual, mes: null, monto: '50' }]));
    const { rows: lote } = await db.query<{ id: string }>(`select id from meta_lote order by created_at desc limit 1`);
    await db.transaction((tx) => aprobarLoteMetas(tx, lote[0].id, idGer));
  });
  afterAll(() => cerrar());

  it('el catálogo trae cobertura de cartera, concentración top 3, venta, % devoluciones y cumplimiento de meta', async () => {
    const filas = await catalogoVendedores(db, { anios: [anioActual] });
    const v = filas.find((f) => f.codigo === 'V001')!;
    expect(v).toMatchObject({
      nombre: 'Pedro Pérez', contacto: emailVendedor,
      clientesAtendidos: 2, facturas: 2, coberturaCarteraPct: 100, concentracionTop3Pct: 100,
      ventaTotalUsd: '160.00', devolucionesPct: 25,
      metaUsd: '50.00', cumplimientoMetaPct: 320,
    });
  });

  it('ordenar por clientes atendidos', async () => {
    const filas = await catalogoVendedores(db, { anios: [anioActual], orden: 'clientes' });
    expect(filas[0].codigo).toBe('V001');
  });

  it('la búsqueda por texto no encuentra vendedores que no coinciden', async () => {
    expect(await catalogoVendedores(db, { texto: 'NO-EXISTE' })).toEqual([]);
  });
});

describe('M3 Vendedores: detalle, pestaña "Vista general / anual" (spec_reportes §6.2)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let clienteC: string;
  let aceite: string;
  let vendedorId: string;
  let motivoDevolucion = '';
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

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas2@prueba.test', ['ventas']);
    const idSup = await usuarioDePrueba(db, 'supervisor3@prueba.test', ['supervisor_ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion2@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']);
    ventas = { id: idVen, roles: ['ventas'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

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
    clienteA = await cliente('J-00000011-5', 'Repuestos Lara, C.A.');
    clienteB = await cliente('J-00000021-2', 'Autopartes Sur, C.A.');
    clienteC = await cliente('J-00000031-0', 'Frenos Centro, C.A.');

    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-AC-002', { descripcion: 'Artículo AC-002' }));
    aceite = await db.transaction((tx) => crearProducto(tx, idAlm, 'AC-002', {
      descripcion: 'Aceite de motor', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
    await db.transaction((tx) => fijarPrecio(tx, aceite, 'B', '20.00', hoy));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 50, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));

    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;

    // Cliente A: 5 unidades (US$ 100), con una devolución de 2 unidades (US$ 40).
    const facturaA = await facturar(clienteA, '5');
    const { rows: lin } = await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [facturaA]);
    const ncId = await como(ventas, (tx) => crearNotaCredito(tx, ventas, {
      facturaId: facturaA, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: lin[0].id, cantidad: '2' }],
    }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, ncId));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', ncId, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, ncId, { servicio: new ImprentaSimulada() }));

    // Cliente B: 3 unidades (US$ 60), sin devolución.
    await facturar(clienteB, '3');

    // Meta del vendedor para el año en curso: solo anual (sin desglose mensual), para probar el reparto entre 12.
    const idSupMeta = await usuarioDePrueba(db, 'supervisor4@prueba.test', ['supervisor_ventas']);
    await db.transaction((tx) => crearLoteMetas(tx, idSupMeta, 'manual', [{ fila: 1, tipo: 'vendedor', entidadId: vendedorId, anio: anioActual, mes: null, monto: '120' }]));
    const { rows: lote } = await db.query<{ id: string }>(`select id from meta_lote order by created_at desc limit 1`);
    await db.transaction((tx) => aprobarLoteMetas(tx, lote[0].id, idGer));
  });
  afterAll(() => cerrar());

  it('venta total, facturas, clientes atendidos, pedido promedio, meta y devoluciones', async () => {
    const v = await vistaGeneralVendedor(db, vendedorId, [anioActual]);
    expect(v).toMatchObject({
      ventaTotalUsd: '160.00', facturas: 2, clientesAtendidos: 2, pedidoPromedioUsd: '80.00',
      metaUsd: '120.00', cumplimientoMetaPct: expect.closeTo(133.33, 1), devolucionesPct: 25,
    });
  });

  it('reparte la meta anual entre los 12 meses cuando no hay meta mensual cargada', async () => {
    const v = await vistaGeneralVendedor(db, vendedorId, [anioActual]);
    const mesActual = Number(hoy.slice(5, 7));
    const fila = v.mensual.find((m) => m.mes === mesActual)!;
    expect(fila.metaUsd).toBe('10.00');
    expect(Number(fila.ventaUsd)).toBe(160);
  });

  it('sugiere la alerta de deuda sin vencer cuando la cartera del vendedor tiene saldo pendiente', async () => {
    const v = await vistaGeneralVendedor(db, vendedorId, [anioActual]);
    expect(v.insight.tipo).toBe('deuda');
    expect(v.insight.mensaje).toContain('Deuda activa');
  });

  it('la comparativa multianual contrasta un año vacío (A) contra el año con ventas (B)', async () => {
    const c = await comparativaMultianualVendedor(db, vendedorId, anioActual - 1, anioActual);
    expect(c.venta).toEqual({ a: '0.00', b: '160.00', variacionAbsoluta: '160.00', variacionPct: 100 });
    expect(c.facturas).toEqual({ a: '0', b: '2', variacionAbsoluta: '2', variacionPct: 100 });
    expect(c.clientesAtendidos).toEqual({ a: '0', b: '2', variacionAbsoluta: '2', variacionPct: 100 });
    expect(c.devolucion).toEqual({ a: '0.00', b: '40.00', variacionAbsoluta: '40.00', variacionPct: 100 });
    const mesHoy = Number(hoy.slice(5, 7));
    expect(c.mensual.find((m) => m.mes === mesHoy)).toMatchObject({ ventaA: '0.00', ventaB: '160.00' });
    expect(c.mensual.filter((m) => m.mes !== mesHoy).every((m) => m.ventaA === '0.00' && m.ventaB === '0.00')).toBe(true);
  });
});

describe('M3 Vendedores: detalle, pestaña "Analítica estratégica & cartera dormida" (spec_reportes §6.2)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let clienteC: string;
  let aceite: string;
  let vendedorId: string;
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

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente5@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas5@prueba.test', ['ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion5@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen5@prueba.test', ['almacen']);
    ventas = { id: idVen, roles: ['ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

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
    clienteA = await cliente('J-00000012-3', 'Repuestos Lara, C.A.');
    clienteB = await cliente('J-00000022-0', 'Autopartes Sur, C.A.');
    // Cliente C queda asignado al vendedor pero nunca compra: cartera dormida sin historial.
    clienteC = await cliente('J-00000032-8', 'Frenos Centro, C.A.');

    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-AC-003', { descripcion: 'Artículo AC-003' }));
    aceite = await db.transaction((tx) => crearProducto(tx, idAlm, 'AC-003', {
      descripcion: 'Aceite de motor', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
    await db.transaction((tx) => fijarPrecio(tx, aceite, 'B', '20.00', hoy));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 50, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));

    // Cliente A: 5 unidades (US$ 100). Cliente B: 3 unidades (US$ 60). Cliente C: sin compras.
    await facturar(clienteA, '5');
    await facturar(clienteB, '3');
  });
  afterAll(() => cerrar());

  it('cobertura de cartera y concentración top 3 sobre los 3 clientes asignados', async () => {
    const a = await analiticaEstrategicaVendedor(db, vendedorId, [anioActual]);
    expect(a.coberturaCarteraPct).toBeCloseTo(66.67, 1);
    expect(a.concentracionTop3Pct).toBe(100);
  });

  it('marca al cliente sin compras en el periodo como cartera dormida, sin historial', async () => {
    const a = await analiticaEstrategicaVendedor(db, vendedorId, [anioActual]);
    expect(a.tasaFugaPct).toBeCloseTo(33.33, 1);
    expect(a.dormidos).toHaveLength(1);
    expect(a.dormidos[0]).toMatchObject({
      id: clienteC, ventaHistoricaUsd: '0.00', ultimaCompra: null, diasSinComprar: null, enRiesgo: false,
    });
  });
});
