import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImprentaSimulada, PROVEEDOR_SIMULADO, servicioImprenta, type ServicioNumeroControl } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import {
  anularFactura, asignarControlPendiente, buscarFacturas, detalleFactura, facturarNotas, notasPorFacturar,
} from '@/lib/ventas/facturas';
import { agregarLinea, anularNotaEntrega, crearPedido, detalleDocumento, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('factura de venta, número de control, cuentas por cobrar y asiento (§6.1, §6.3, §11.1, R-AY a R-BB)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let otroVentas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let gerente: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let clienteCredito: string;
  let pastilla: string;      // US$ 10, IVA general
  let aceite: string;        // US$ 20, exento
  let OTRO = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const stock = (prod: string, cantidad: string, costo: string) => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('entrada_compra', $1, $2, $3, $4, 'prueba', gen_random_uuid())`, [prod, mostrador, cantidad, costo]));
  /** Nota de entrega ya despachada de un cliente con las líneas indicadas. */
  async function notaDespachada(cliente: string, lineas: [string, string][], vendedor: Usuario = ventas) {
    const pedido = await como(vendedor, (tx) => crearPedido(tx, vendedor, { clienteId: cliente, almacenId: mostrador }));
    for (const [p, c] of lineas) await como(vendedor, (tx) => agregarLinea(tx, vendedor, pedido, { productoId: p, cantidad: c }));
    await como(vendedor, (tx) => emitirPedido(tx, vendedor, pedido));
    const nota = await como(vendedor, (tx) => generarNotaEntrega(tx, vendedor, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    return nota;
  }
  const facturar = (ids: string[], servicio?: ServicioNumeroControl) => como(facturacion, (tx) => facturarNotas(tx, facturacion, ids, { servicio: servicio ?? new ImprentaSimulada() }));
  const anular = (id: string, detalle = 'Prueba') => como(facturacion, (tx) => anularFactura(tx, facturacion, id, { motivoId: OTRO, detalle }, { servicio: new ImprentaSimulada() }));
  const asiento = async (evento: string, id: string) =>
    (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
      `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = $1 and a.origen_id = $2 order by l.id`, [evento, id])).rows;
  const saldoMayorCxC = async () =>
    (await db.query<{ ves: string; usd: string }>(
      `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves, coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd
         from asiento_linea l join asiento a on a.id = l.asiento_id join cuenta_contable c on c.id = l.cuenta_id
        where c.codigo = '1.2.01' and a.estado = 'contabilizado'`)).rows[0];
  const auxiliarCxC = async () =>
    (await db.query<{ ves: string; usd: string }>(
      `select coalesce(sum(saldo), 0)::text as ves, coalesce(sum(round(monto_usd * saldo / monto_original, 2)), 0)::text as usd
         from partida_cxc where estado = 'abierta'`)).rows[0];

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idVen2 = await usuarioDePrueba(db, 'ventas2@prueba.test', ['ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    gerente = { id: idGer, roles: ['gerencia'] };
    ventas = { id: idVen, roles: ['ventas'] };
    otroVentas = { id: idVen2, roles: ['ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend1 = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const vend2 = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Ana Gómez', tipo: 'interno', usuarioId: idVen2 }));
    const cliente = async (rif: string, nombre: string, vendedor: string, condicion: string, limite: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, idFac, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
        comercial: { vendedorId: vendedor },
      }));
      const cond = (await db.query<{ id: string }>('select id from condicion_pago where codigo = $1', [condicion])).rows[0].id;
      await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: cond, limiteCreditoUsd: limite, nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    clienteA = await cliente('J-00000010-7', 'Repuestos Lara, C.A.', vend1.id, 'CONTADO', '0');
    clienteB = await cliente('J-00000020-4', 'Autopartes Sur, C.A.', vend2.id, 'CR30', '1000');
    clienteCredito = await cliente('J-00000030-1', 'Frenos del Centro, C.A.', vend1.id, 'CR30', '300');

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
    };
    pastilla = await nuevo('PF-001', general);
    aceite = await nuevo('AC-001', exento);
    const hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
    await db.transaction(async (tx) => {
      await fijarPrecio(tx, pastilla, 'B', '10.00', hoy);
      await fijarPrecio(tx, aceite, 'B', '20.00', hoy);
    });
    await stock(pastilla, '500', '4.00');
    await stock(aceite, '500', '6.50');
  });
  afterAll(() => cerrar());

  it('factura una nota despachada: precios a la tasa BCV, número de control, partida de CxC y asiento', async () => {
    const nota = await notaDespachada(clienteA, [[pastilla, '10'], [aceite, '2']]);
    const r = await facturar([nota]);
    expect(r.contingencia).toBe(false);
    expect(r.numeroControl).toBe('00-00000001');

    const f = (await detalleFactura(db, r.facturaId))!;
    expect(f.estado).toBe('emitido');
    expect([f.serie, f.numero]).toEqual(['A', r.numero]);
    expect(f.imprenta).toBe(PROVEEDOR_SIMULADO);
    expect(f.tasa).toBe('40.000000');
    expect(f.lineas.map((l) => [l.codigo, l.cantidad, l.precio_unitario, l.alicuota_pct, l.base, l.iva, l.total])).toEqual([
      ['PF-001', '10.0000', '400.0000', '16.00', '4000.00', '640.00', '4640.00'],
      ['AC-001', '2.0000', '800.0000', '0.00', '1600.00', '0.00', '1600.00'],
    ]);
    expect([f.subtotal, f.base_imponible, f.exento, f.iva, f.igtf, f.total, f.total_usd]).toEqual(
      ['5600.00', '4000.00', '1600.00', '640.00', '0.00', '6240.00', '156.00']);
    expect(f.desglose).toEqual([{ alicuota_pct: '16.00', base: '4000.00', iva: '640.00' }, { alicuota_pct: '0.00', base: '1600.00', iva: '0.00' }]);
    expect(f.cliente_rif).toBe('J-00000010-7');
    expect(f.empresa_rif).toBe('J-12345678-4');
    expect(f.notas.map((n) => n.id)).toEqual([nota]);

    // La nota queda cubierta por la factura y la partida abre con su saldo.
    const { rows: n } = await db.query<{ factura_id: string }>('select factura_id from documento_venta where id = $1', [nota]);
    expect(n[0].factura_id).toBe(r.facturaId);
    const { rows: p } = await db.query<{ monto_original: string; monto_usd: string; saldo: string; estado: string; fecha: string; vencimiento: string; moneda: string }>(
      `select monto_original::text, monto_usd::text, saldo::text, estado, fecha::text, vencimiento::text, moneda from partida_cxc where documento_id = $1`, [r.facturaId]);
    expect(p[0]).toMatchObject({ monto_original: '6240.00', monto_usd: '156.00', saldo: '6240.00', estado: 'abierta', moneda: 'VES' });
    expect(p[0].vencimiento).toBe(p[0].fecha);                              // contado

    expect(await asiento('factura_venta', r.facturaId)).toEqual([
      { codigo: '1.2.01', debe_ves: '6240.00', haber_ves: '0.00', debe_usd: '156.00', haber_usd: '0.00' },
      { codigo: '4.1.01', debe_ves: '0.00', haber_ves: '5600.00', debe_usd: '0.00', haber_usd: '140.00' },
      { codigo: '2.1.03', debe_ves: '0.00', haber_ves: '640.00', debe_usd: '0.00', haber_usd: '16.00' },
    ]);
  });

  it('una factura emitida no se edita ni se borra; su partida y su número tampoco', async () => {
    const nota = await notaDespachada(clienteA, [[pastilla, '1']]);
    const r = await facturar([nota]);
    await esperarError(db.query(`update documento_venta set total = 1 where id = $1`, [r.facturaId]), 'no se edita');
    await esperarError(db.query(`update documento_venta set numero_control = '99-99999999' where id = $1`, [r.facturaId]), 'no se edita');
    await esperarError(db.query(`update documento_venta set contingencia = true, contingencia_motivo = 'x manual' where id = $1`, [r.facturaId]), 'no se edita');
    await esperarError(db.query(`delete from documento_venta where id = $1`, [r.facturaId]), 'no se borra');
    await esperarError(db.query(`update documento_venta_linea set cantidad = 9 where documento_id = $1`, [r.facturaId]), 'no se modifican');
    await esperarError(db.query(`update partida_cxc set saldo = 0 where documento_id = $1`, [r.facturaId]), 'solo cambia con un cobro');
    await esperarError(db.query(`update partida_cxc set monto_original = 1 where documento_id = $1`, [r.facturaId]), 'solo cambia su saldo');
    await esperarError(db.query(`delete from partida_cxc where documento_id = $1`, [r.facturaId]), 'no se borra');
    await esperarError(db.query(`update documento_venta set estado = 'borrador' where id = $1`, [r.facturaId]), 'no vuelve a borrador');
    // La nota facturada no se anula mientras esté cubierta por su factura.
    await esperarError(como(ventas, (tx) => anularNotaEntrega(tx, ventas, nota, { motivoId: OTRO, detalle: 'Prueba' })), 'ya salió');
  });

  it('números correlativos de factura y de control; se facturan juntas varias notas del mismo cliente', async () => {
    const n1 = await notaDespachada(clienteA, [[pastilla, '2']]);
    const n2 = await notaDespachada(clienteA, [[aceite, '1']]);
    const a = await facturar([n1, n2]);
    const n3 = await notaDespachada(clienteA, [[pastilla, '1']]);
    const b = await facturar([n3]);
    expect(Number(b.numero)).toBe(Number(a.numero) + 1);
    expect(Number(b.numeroControl!.slice(3))).toBe(Number(a.numeroControl!.slice(3)) + 1);
    const f = (await detalleFactura(db, a.facturaId))!;
    expect(f.lineas.map((l) => [l.linea, l.codigo])).toEqual([[1, 'PF-001'], [2, 'AC-001']]);
    expect(f.notas).toHaveLength(2);
    expect(f.total).toBe('1728.00');                                        // 2 × 400 × 1,16 = 928,00 + 1 × 800 (exento)
  });

  it('valida las notas que se facturan', async () => {
    await esperarError(facturar([]), 'al menos una');
    await esperarError(facturar(['00000000-0000-0000-0000-000000000000']), 'no existe');
    // Sin despachar.
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: clienteA, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: pastilla, cantidad: '1' }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const sinSalir = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await esperarError(facturar([sinSalir]), 'todavía no ha salido');
    // Ya facturada y de clientes distintos.
    const a = await notaDespachada(clienteA, [[pastilla, '1']]);
    const b = await notaDespachada(clienteB, [[pastilla, '1']], otroVentas);
    await esperarError(facturar([a, b]), 'un mismo cliente');
    await facturar([a]);
    await esperarError(facturar([a]), 'ya está facturada');
    // Anulada.
    await como(ventas, (tx) => anularNotaEntrega(tx, ventas, sinSalir, { motivoId: OTRO, detalle: 'Prueba' }));
    await esperarError(facturar([sinSalir]), 'anulada');
  });

  it('sin empresa configurada o sin tasa del día no se factura, y no queda nada a medias', async () => {
    const nota = await notaDespachada(clienteA, [[pastilla, '1']]);
    const antes = (await db.query<{ n: number }>(`select count(*)::int as n from documento_venta where tipo = 'factura'`)).rows[0].n;
    const guardada = (await db.query<{ rif: string; razon_social: string; domicilio_fiscal: string }>('select rif, razon_social, domicilio_fiscal from empresa')).rows[0];
    await db.query('delete from empresa');
    await esperarError(facturar([nota]), 'Configure la empresa');
    await db.query('insert into empresa (rif, razon_social, domicilio_fiscal) values ($1, $2, $3)', [guardada.rif, guardada.razon_social, guardada.domicilio_fiscal]);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from documento_venta where tipo = 'factura'`)).rows[0].n).toBe(antes);
    await facturar([nota]);
  });

  describe('contingencia (§11.1)', () => {
    const caido: ServicioNumeroControl = {
      proveedor: 'PROVEEDOR CAÍDO', esReal: true,
      solicitar: async () => { throw new Error('tiempo de espera agotado'); },
      anular: async () => undefined,
    };

    it('si el servicio de imprenta falla, la factura se emite en contingencia con su motivo y el control se asigna después', async () => {
      const nota = await notaDespachada(clienteA, [[pastilla, '1']]);
      const r = await facturar([nota], caido);
      expect(r.contingencia).toBe(true);
      expect(r.numeroControl).toBeNull();
      const f = (await detalleFactura(db, r.facturaId))!;
      expect([f.estado, f.contingencia, f.numero_control]).toEqual(['emitido', true, null]);
      expect(f.contingencia_motivo).toContain('tiempo de espera agotado');
      expect((await buscarFacturas(db, facturacion, { estado: 'contingencia' })).map((x) => x.id)).toContain(r.facturaId);
      // La contabilidad y la cuenta por cobrar no esperan al número de control.
      expect((await asiento('factura_venta', r.facturaId)).length).toBe(3);

      await esperarError(como(facturacion, (tx) => asignarControlPendiente(tx, facturacion, r.facturaId, { servicio: caido })), 'No se pudo obtener');
      const control = await como(facturacion, (tx) => asignarControlPendiente(tx, facturacion, r.facturaId, { servicio: new ImprentaSimulada() }));
      expect(control).toMatch(/^00-\d{8}$/);
      const despues = (await detalleFactura(db, r.facturaId))!;
      expect([despues.contingencia, despues.numero_control, despues.contingencia_motivo, despues.imprenta]).toEqual([false, control, null, PROVEEDOR_SIMULADO]);
      await esperarError(como(facturacion, (tx) => asignarControlPendiente(tx, facturacion, r.facturaId, { servicio: new ImprentaSimulada() })), 'no está pendiente');
    });

    it('en producción no hay simulador: la factura va a contingencia hasta que exista un proveedor real', async () => {
      const entorno = process.env.NODE_ENV;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      try {
        expect(() => servicioImprenta()).toThrow('No hay un proveedor de imprenta');
        const nota = await notaDespachada(clienteA, [[pastilla, '1']]);
        const r = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota]));
        expect(r.contingencia).toBe(true);
        expect((await detalleFactura(db, r.facturaId))!.contingencia_motivo).toContain('No hay un proveedor de imprenta');
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = entorno;
      }
      expect(servicioImprenta().esReal).toBe(false);
      expect(servicioImprenta().proveedor).toBe(PROVEEDOR_SIMULADO);
    });
  });

  describe('anulación (§6.2, regla 8)', () => {
    it('anula con motivo: asiento inverso, partida anulada y la nota queda libre para facturarse de nuevo', async () => {
      const nota = await notaDespachada(clienteA, [[pastilla, '3']]);
      const r = await facturar([nota]);
      await esperarError(como(facturacion, (tx) => anularFactura(tx, facturacion, r.facturaId, { motivoId: OTRO, detalle: ' ' })), 'Explique');
      await anular(r.facturaId, 'Se facturó al cliente equivocado');

      const f = (await detalleFactura(db, r.facturaId))!;
      expect(f.estado).toBe('anulado');
      expect(f.anulado_motivo).toBe('Otro motivo (explicar): Se facturó al cliente equivocado');
      expect([f.saldo, f.partida_estado]).toEqual(['0.00', 'anulada']);
      expect(await asiento('anulacion_factura', r.facturaId)).toEqual([
        { codigo: '4.1.01', debe_ves: '1200.00', haber_ves: '0.00', debe_usd: '30.00', haber_usd: '0.00' },
        { codigo: '2.1.03', debe_ves: '192.00', haber_ves: '0.00', debe_usd: '4.80', haber_usd: '0.00' },
        { codigo: '1.2.01', debe_ves: '0.00', haber_ves: '1392.00', debe_usd: '0.00', haber_usd: '34.80' },
      ]);
      await esperarError(anular(r.facturaId), 'emitida');
      await esperarError(db.query(`update documento_venta set observaciones = 'x' where id = $1`, [r.facturaId]), 'anulado no se modifica');

      // La nota vuelve a poder facturarse: factura nueva, número nuevo (el anulado no se reutiliza).
      const otra = await facturar([nota]);
      expect(Number(otra.numero)).toBeGreaterThan(Number(r.numero));
      expect(otra.numeroControl).not.toBe(r.numeroControl);
    });

    it('si el periodo contable está cerrado no se anula y no queda nada a medias', async () => {
      const nota = await notaDespachada(clienteA, [[pastilla, '1']]);
      const r = await facturar([nota]);
      await db.query(`update periodo_contable set estado = 'cerrado'`);
      await esperarError(anular(r.facturaId), 'eriodo');
      await db.query(`update periodo_contable set estado = 'abierto'`);
      const f = (await detalleFactura(db, r.facturaId))!;
      expect([f.estado, f.partida_estado]).toEqual(['emitido', 'abierta']);
    });

    it('una factura con cobros o notas de crédito aplicados no se anula', async () => {
      const nota = await notaDespachada(clienteA, [[pastilla, '1']]);
      const r = await facturar([nota]);
      await db.query(`select set_config('app.cxc_interno', '1', false)`);
      await db.query(`update partida_cxc set saldo = saldo - 10 where documento_id = $1`, [r.facturaId]);   // un cobro parcial (llega en su fase)
      await db.query(`select set_config('app.cxc_interno', '', false)`);
      await esperarError(anular(r.facturaId), 'cobros o notas de crédito');
      // Se deshace el cobro simulado para no descuadrar el auxiliar frente al mayor en las demás pruebas.
      await db.query(`select set_config('app.cxc_interno', '1', false)`);
      await db.query(`update partida_cxc set saldo = monto_original where documento_id = $1`, [r.facturaId]);
      await db.query(`select set_config('app.cxc_interno', '', false)`);
    });
  });

  describe('cuentas por cobrar y crédito', () => {
    it('el auxiliar de CxC cuadra con el mayor, en VES y en USD (criterio de aceptación de la Fase 2)', async () => {
      const mayor = await saldoMayorCxC();
      const aux = await auxiliarCxC();
      expect(aux.ves).toBe(mayor.ves);
      expect(aux.usd).toBe(mayor.usd);
      expect(Number(mayor.ves)).toBeGreaterThan(0);
    });

    it('el vencimiento sale de la condición de pago del cliente', async () => {
      const nota = await notaDespachada(clienteB, [[pastilla, '1']], otroVentas);
      const r = await facturar([nota]);
      const { rows } = await db.query<{ dias: number }>(`select (vencimiento - fecha)::int as dias from partida_cxc where documento_id = $1`, [r.facturaId]);
      expect(rows[0].dias).toBe(30);
    });

    it('la exposición de crédito cuenta las cuentas por cobrar y no suma dos veces la nota facturada', async () => {
      const exposicion = async () => (await db.query<{ e: string }>('select fn_exposicion_credito_usd($1)::text as e', [clienteCredito])).rows[0].e;
      expect(await exposicion()).toBe('0');
      const nota = await notaDespachada(clienteCredito, [[pastilla, '10']]);        // 10 × 10 × 1,16 = 116,00
      expect(await exposicion()).toBe('116.00');
      const r = await facturar([nota]);                                              // ahora es cuenta por cobrar
      expect(await exposicion()).toBe('116.00');
      await anular(r.facturaId);                                                     // la nota vuelve a contar como nota
      expect(await exposicion()).toBe('116.00');
      const otra = await facturar([nota]);
      expect(await exposicion()).toBe('116.00');
      await anular(otra.facturaId);
    });
  });

  describe('permisos y consulta', () => {
    it('quien solo vende ve las facturas de su cartera y las notas por facturar de sus clientes', async () => {
      const mia = await notaDespachada(clienteA, [[pastilla, '1']]);
      const ajena = await notaDespachada(clienteB, [[pastilla, '1']], otroVentas);
      const porFacturar = async (u: Usuario) => (await notasPorFacturar(db, u)).map((n) => n.id);
      expect(await porFacturar(ventas)).toContain(mia);
      expect(await porFacturar(ventas)).not.toContain(ajena);
      expect(await porFacturar(facturacion)).toEqual(expect.arrayContaining([mia, ajena]));
      expect(await notasPorFacturar(db, almacenista)).toEqual([]);

      const rm = await facturar([mia]);
      const ra = await facturar([ajena]);
      const ids = async (u: Usuario) => (await buscarFacturas(db, u, {})).map((f) => f.id);
      expect(await ids(ventas)).toContain(rm.facturaId);
      expect(await ids(ventas)).not.toContain(ra.facturaId);
      expect(await ids(facturacion)).toEqual(expect.arrayContaining([rm.facturaId, ra.facturaId]));
      expect(await buscarFacturas(db, almacenista, {})).toEqual([]);
      expect(await notasPorFacturar(db, gerente)).toBeDefined();
      void (await detalleDocumento(db, mia));
    });
  });
});
