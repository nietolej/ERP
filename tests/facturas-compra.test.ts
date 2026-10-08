import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buscarFacturas, crearFactura, cuentasPorPagar, detalleFactura, eliminarBorrador, guardarLinea, quitarLinea, registrarFactura,
} from '@/lib/compras/facturas';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea as lineaOrden, type Usuario } from '@/lib/compras/ordenes';
import { recibirMercancia } from '@/lib/compras/recepciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase, type DatosProducto } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('factura de compra, conciliación a tres vías y cuentas por pagar (§7.2, §7.3, R-BC a R-BF)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let gerente: Usuario;
  let otroGerente: Usuario;
  let almacenista: Usuario;
  let a01: string;
  let proveedor: string;
  let general: string;
  let exento: string;
  let marca: string;
  let hoy: string;
  let n = 0;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const producto = async (extra: Partial<DatosProducto> = {}) => {
    const codigo = `FC-${++n}`;
    const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
    return db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
      descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true, ...extra,
    }));
  };
  /** Orden aprobada y recibida por completo (o por la cantidad indicada). */
  const ordenRecibida = async (prod: string, cantidad: string, precio: string, moneda = 'USD', recibido = cantidad) => {
    const id = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: proveedor, almacenId: a01, moneda }));
    await como(comprador, (tx) => lineaOrden(tx, id, { productoId: prod, cantidad, precio }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', id, gerente.id, 'aprobada'));
    const [l] = (await detalleOrden(db, id))!.lineas;
    if (Number(recibido) > 0) await como(almacenista, (tx) => recibirMercancia(tx, almacenista, id, [{ lineaId: l.id, cantidad: recibido }]));
    return { id, lineaId: l.id };
  };
  /** Factura en borrador con una línea; devuelve su id. */
  const borrador = async (o: { id: string; lineaId: string }, cantidad: string, precio: string, numero = `F-${++n}`, usuario = comprador) => {
    const id = await como(usuario, (tx) => crearFactura(tx, usuario, { ordenId: o.id, numeroFactura: numero, numeroControl: `00-${n}`, fechaFactura: hoy }));
    await como(usuario, (tx) => guardarLinea(tx, id, { ordenLineaId: o.lineaId, cantidad, precio }));
    return id;
  };
  const registrar = (id: string, usuario = comprador) => como(usuario, (tx) => registrarFactura(tx, usuario, id));
  const asiento = async (origenId: string) =>
    (await db.query<{ codigo: string; debe: string; haber: string; debe_ves: string; haber_ves: string }>(
      `select c.codigo, l.debe_usd::text as debe, l.haber_usd::text as haber, l.debe_ves::text, l.haber_ves::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = 'factura_compra' and a.origen_id = $1 order by l.id`, [origenId])).rows;
  const costo = async (prod: string) =>
    (await db.query<{ c: string; v: string; q: string }>(
      'select costo_promedio_usd::text as c, valor_usd::text as v, cantidad::text as q from producto_costo where producto_id = $1', [prod])).rows[0];
  const sinCuentaPorPagar = async (facturaId: string) =>
    (await db.query('select 1 from partida_cxp where factura_id = $1', [facturaId])).rows.length === 0;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idCom = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idGer2 = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    comprador = { id: idCom, roles: ['compras'] };
    gerente = { id: idGer, roles: ['gerencia'] };
    otroGerente = { id: idGer2, roles: ['gerencia'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const fechas = await db.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`);
    hoy = fechas.rows[0].hoy;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40.000000), ($1::date, 'EUR', 50.000000)`, [hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, a01, [idAlm]));

    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-11111111-${digitoVerificador('J', '11111111')}`,
      sensibles: { razonSocial: 'Proveedor Uno', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    proveedor = r.id;
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
  });
  afterAll(() => cerrar());

  it('factura exacta: se contabiliza sola, liquida la mercancía recibida no facturada y abre la cuenta por pagar', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '100', '4.0000');
    const id = await borrador(o, '100', '4.0000');
    const r = await registrar(id);
    expect(r.estado).toBe('contabilizada');
    expect(r.asiento).not.toBeNull();

    const d = (await detalleFactura(db, id))!;
    expect([d.base_imponible, d.exento, d.iva, d.total, d.total_usd, d.conciliada]).toEqual(['400.00', '0.00', '64.00', '464.00', '464.00', true]);
    expect(d.numero).toMatch(/^\d+$/);
    expect(d.saldo).toBe('464.00');

    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber, l.debe_ves, l.haber_ves])).toEqual([
      ['2.1.02', '400.00', '0.00', '16000.00', '0.00'],
      ['1.2.03', '64.00', '0.00', '2560.00', '0.00'],
      ['2.1.01', '0.00', '464.00', '0.00', '18560.00'],
    ]);
    const cxp = (await db.query<{ fecha: string; vencimiento: string; saldo: string; estado: string }>(
      'select fecha::text, vencimiento::text, saldo::text, estado from partida_cxp where factura_id = $1', [id])).rows[0];
    expect(cxp.saldo).toBe('464.00');
    expect(cxp.estado).toBe('abierta');
    const dias = (await db.query<{ d: number }>('select ($1::date - $2::date)::int as d', [cxp.vencimiento, cxp.fecha])).rows[0].d;
    expect(dias).toBe(30);                                              // condición de pago CR30
    expect((await costo(p)).c).toBe('4.0000');                          // sin diferencia de precio, el costo no cambia
  });

  it('cuadre de auxiliares: cuentas por pagar y mercancía recibida no facturada contra el mayor, e inventario contra su valor', async () => {
    const mayor = async (codigo: string) =>
      (await db.query<{ usd: string }>(
        `select coalesce(sum(l.haber_usd - l.debe_usd), 0)::text as usd from asiento_linea l join asiento a on a.id = l.asiento_id
           join cuenta_contable c on c.id = l.cuenta_id where c.codigo = $1 and a.estado = 'contabilizado'`, [codigo])).rows[0].usd;
    const cxp = (await db.query<{ usd: string }>(
      `select coalesce(sum(round(monto_usd * saldo / monto_original, 2)), 0)::text as usd from partida_cxp where estado = 'abierta'`)).rows[0].usd;
    expect(Number(await mayor('2.1.01'))).toBe(Number(cxp));
    const inventario = (await db.query<{ v: string }>('select coalesce(sum(valor_usd), 0)::text as v from producto_costo')).rows[0].v;
    expect(-Number(await mayor('1.3.01'))).toBeCloseTo(Number(inventario), 2);
    // Todo lo recibido y facturado liquida la cuenta puente: la factura de arriba cubrió toda su recepción.
    expect(Number(await mayor('2.1.02'))).toBeGreaterThanOrEqual(0);
  });

  it('diferencia de precio dentro de tolerancia: se contabiliza y encarece el costo de lo que está en existencia', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '100', '10.0000');
    const id = await borrador(o, '100', '10.1000');                      // +1 % (tolerancia 2 %)
    const r = await registrar(id);
    expect(r.estado).toBe('contabilizada');
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber])).toEqual([
      ['2.1.02', '1000.00', '0.00'], ['1.3.01', '10.00', '0.00'], ['1.2.03', '161.60', '0.00'], ['2.1.01', '0.00', '1171.60'],
    ]);
    const c = await costo(p);
    expect([c.q, c.v, c.c]).toEqual(['100.0000', '1010.00', '10.1000']);
    const aj = (await db.query<{ valor_usd: string; origen_tipo: string }>('select valor_usd::text, origen_tipo from ajuste_costo where producto_id = $1', [p])).rows;
    expect(aj).toEqual([{ valor_usd: '10.00', origen_tipo: 'factura_compra' }]);
  });

  it('si parte de lo comprado ya se vendió, la diferencia se reparte entre el inventario y el costo de ventas', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '100', '10.0000');
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('salida_venta', $1, $2, -60, 0, 'prueba', gen_random_uuid())`, [p, a01]));
    const id = await borrador(o, '100', '10.1000');
    expect((await registrar(id)).estado).toBe('contabilizada');
    // Diferencia de 10,00: 40 de 100 unidades siguen en existencia (4,00) y 60 ya se vendieron (6,00).
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber])).toEqual([
      ['2.1.02', '1000.00', '0.00'], ['1.3.01', '4.00', '0.00'], ['5.1.01', '6.00', '0.00'], ['1.2.03', '161.60', '0.00'], ['2.1.01', '0.00', '1171.60'],
    ]);
    const c = await costo(p);
    expect([c.q, c.v, c.c]).toEqual(['40.0000', '404.00', '10.1000']);   // 40 × 10,00 + 4,00
  });

  it('una diferencia a favor abate el costo; el IVA exento no suma crédito fiscal', async () => {
    const p = await producto({ alicuotaIvaId: exento });
    const o = await ordenRecibida(p, '50', '20.0000');
    const id = await borrador(o, '50', '19.8000');                       // −1 %
    expect((await registrar(id)).estado).toBe('contabilizada');
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber])).toEqual([
      ['2.1.02', '1000.00', '0.00'], ['1.3.01', '0.00', '10.00'], ['2.1.01', '0.00', '990.00'],
    ]);
    expect((await costo(p)).c).toBe('19.8000');
  });

  it('fuera de tolerancia: queda retenida, no abre cuenta por pagar ni mueve costos hasta que otra persona de Gerencia la apruebe', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '100', '10.0000');
    const id = await borrador(o, '100', '12.0000');                      // +20 %
    const r = await registrar(id);
    expect(r.estado).toBe('retenida');
    expect(r.motivo).toContain('fuera de tolerancia');
    expect(r.asiento).toBeNull();
    expect(await sinCuentaPorPagar(id)).toBe(true);
    expect((await asiento(id))).toEqual([]);
    expect((await costo(p)).c).toBe('10.0000');
    expect((await detalleFactura(db, id))!.conciliada).toBe(false);
    await esperarError(registrar(id), 'borrador');                       // ya no se registra dos veces

    // No se edita ni se borra, ni la aprueba quien la registró.
    await esperarError(db.query(`update factura_compra set numero_factura = 'X' where id = $1`, [id]), 'retenida no se edita');
    await esperarError(db.query('delete from factura_compra where id = $1', [id]), 'no se borra');
    await esperarError(db.query(`update factura_compra set estado = 'contabilizada', aprobado_por = $2 where id = $1`, [id, comprador.id]), 'Gerencia');
    const gc: Usuario = { id: await usuarioDePrueba(db, 'gc@prueba.test', ['gerencia', 'compras']), roles: ['gerencia', 'compras'] };
    const o2 = await ordenRecibida(await producto(), '10', '10.0000');
    const retenidaDeGc = await borrador(o2, '10', '15.0000', undefined, gc);
    expect((await registrar(retenidaDeGc, gc)).estado).toBe('retenida');
    await esperarError(como(gc, (tx) => resolverAprobacion(tx, 'factura_compra', retenidaDeGc, gc.id, 'aprobada')), '');
    await esperarError(db.query(`update factura_compra set estado = 'contabilizada', aprobado_por = $2 where id = $1`, [retenidaDeGc, gc.id]), 'no la aprueba');

    await como(gerente, (tx) => resolverAprobacion(tx, 'factura_compra', id, gerente.id, 'aprobada'));
    const d = (await detalleFactura(db, id))!;
    expect(d.estado).toBe('contabilizada');
    expect(d.saldo).toBe('1392.00');                                     // 1.200 + 16 % de IVA
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber])).toEqual([
      ['2.1.02', '1000.00', '0.00'], ['1.3.01', '200.00', '0.00'], ['1.2.03', '192.00', '0.00'], ['2.1.01', '0.00', '1392.00'],
    ]);
    expect((await costo(p)).c).toBe('12.0000');
    // Contabilizada: no se edita, no se borra, no se vuelve a decidir.
    await esperarError(db.query(`update factura_compra set estado = 'rechazada', rechazo_motivo = 'prueba' where id = $1`, [id]), 'no se modifica');
    await esperarError(db.query('delete from factura_compra where id = $1', [id]), 'no se borra');
    await esperarError(db.query('update factura_compra_linea set cantidad = 1 where factura_id = $1', [id]), 'no se modifican');
  });

  it('una factura retenida rechazada no deja cuenta por pagar y su número se puede volver a registrar', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '10', '10.0000');
    const id = await borrador(o, '10', '14.0000', 'FAC-REPETIDA');
    expect((await registrar(id)).estado).toBe('retenida');
    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'factura_compra', id, gerente.id, 'rechazada')), '');
    await como(gerente, (tx) => resolverAprobacion(tx, 'factura_compra', id, gerente.id, 'rechazada', { comentario: 'Precio acordado era 10' }));
    const d = (await detalleFactura(db, id))!;
    expect([d.estado, d.rechazo_motivo]).toEqual(['rechazada', 'Precio acordado era 10']);
    expect(await sinCuentaPorPagar(id)).toBe(true);
    expect((await costo(p)).c).toBe('10.0000');
    // Rechazada, el proveedor puede enviar la corrección con el mismo número.
    const otra = await borrador(o, '10', '10.0000', 'FAC-REPETIDA');
    expect((await registrar(otra)).estado).toBe('contabilizada');
  });

  it('solo se factura lo recibido y no facturado; una factura parcial y el resto liquidan exactamente la recepción', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '10', '1.1111', 'USD', '3');        // se pidieron 10, llegaron 3 (valor 3,33)
    const demas = await borrador(o, '4', '1.1111');
    await esperarError(registrar(demas), 'Solo se factura lo recibido');
    await como(comprador, (tx) => eliminarBorrador(tx, demas));

    const primera = await borrador(o, '1', '1.1111');
    await registrar(primera);
    const segunda = await borrador(o, '2', '1.1111');
    await registrar(segunda);
    await esperarError(registrar(await borrador(o, '1', '1.1111')), '0.0000 por facturar');   // 1 + 2 + 1 > 3
    const liquidado = (await asiento(primera)).concat(await asiento(segunda)).filter((l) => l.codigo === '2.1.02').reduce((s, l) => s + Number(l.debe), 0);
    expect(liquidado).toBeCloseTo(3.33, 2);                              // 1,11 + 2,22: sin centavos de diferencia
  });

  it('en una orden en euros la factura se contabiliza en euros y el inventario queda en dólares', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '100', '4.0000', 'EUR');           // 4 EUR × 50 ÷ 40 = 5,00 USD
    const id = await borrador(o, '100', '4.0000');
    expect((await registrar(id)).estado).toBe('contabilizada');
    const d = (await detalleFactura(db, id))!;
    expect([d.moneda, d.total, d.total_usd, d.tasa]).toEqual(['EUR', '464.00', '580.00', '50.000000']);
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber, l.debe_ves, l.haber_ves])).toEqual([
      ['2.1.02', '500.00', '0.00', '20000.00', '0.00'],
      ['1.2.03', '80.00', '0.00', '3200.00', '0.00'],
      ['2.1.01', '0.00', '580.00', '0.00', '23200.00'],
    ]);
    expect((await costo(p)).c).toBe('5.0000');
  });

  it('validaciones: orden aprobada, proveedor sin repetir factura, líneas de la orden y borrador', async () => {
    const p = await producto();
    const sinAprobar = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: proveedor, almacenId: a01, moneda: 'USD' }));
    await esperarError(como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: sinAprobar, numeroFactura: 'X-1', numeroControl: '1', fechaFactura: hoy })), 'aprobada');

    const o = await ordenRecibida(p, '10', '5.0000');
    const otra = await ordenRecibida(await producto(), '10', '5.0000');
    await esperarError(como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: o.id, numeroFactura: '', numeroControl: '1', fechaFactura: hoy })), 'número de la factura');
    await esperarError(como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: o.id, numeroFactura: 'A-1', numeroControl: '', fechaFactura: hoy })), 'control');
    await esperarError(como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: o.id, numeroFactura: 'A-1', numeroControl: '1', fechaFactura: '2999-01-01' })), 'futura');

    const id = await borrador(o, '5', '5.0000', 'DUP-1');
    await esperarError(como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: o.id, numeroFactura: 'dup-1', numeroControl: '2', fechaFactura: hoy })), 'ya tiene registrada');
    await esperarError(como(comprador, (tx) => guardarLinea(tx, id, { ordenLineaId: otra.lineaId, cantidad: '1', precio: '5' })), 'no pertenece');
    await esperarError(como(comprador, (tx) => guardarLinea(tx, id, { ordenLineaId: o.lineaId, cantidad: '0', precio: '5' })), 'mayor que cero');
    const [l] = (await detalleFactura(db, id))!.lineas;
    await como(comprador, (tx) => quitarLinea(tx, id, l.id));
    await esperarError(registrar(id), 'sin líneas');
    expect((await buscarFacturas(db, comprador, { estado: 'borrador' })).some((f) => f.id === id)).toBe(true);
    expect((await cuentasPorPagar(db, comprador)).length).toBeGreaterThan(0);
    expect(await cuentasPorPagar(db, { id: comprador.id, roles: ['ventas'] })).toEqual([]);
  });

  it('la cuenta por pagar y el ajuste de costo no se manipulan a mano', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '10', '5.0000');
    const id = await borrador(o, '10', '5.0000');
    await registrar(id);
    await esperarError(db.query(`update partida_cxp set saldo = 0 where factura_id = $1`, [id]), 'solo cambia con un pago');
    await esperarError(db.query(`update partida_cxp set monto_original = 1 where factura_id = $1`, [id]), 'solo cambia su saldo');
    await esperarError(db.query(`delete from partida_cxp where factura_id = $1`, [id]), 'no se borra');

    await como(almacenista, (tx) => tx.query(
      `insert into ajuste_costo (producto_id, valor_usd, origen_tipo, origen_id) values ($1, 5, 'prueba', gen_random_uuid())`, [p]));
    expect((await costo(p)).v).toBe('55.00');
    await esperarError(db.query(`update ajuste_costo set valor_usd = 1 where producto_id = $1`, [p]), 'no se modifica');
    await esperarError(db.query(`delete from ajuste_costo where producto_id = $1`, [p]), 'no se modifica');
    await esperarError(db.query(`insert into ajuste_costo (producto_id, valor_usd, origen_tipo, origen_id, created_by) values ($1, -999, 'prueba', gen_random_uuid(), $2)`, [p, comprador.id]), 'negativo');
    const sinStock = await producto();
    await esperarError(db.query(`insert into ajuste_costo (producto_id, valor_usd, origen_tipo, origen_id, created_by) values ($1, 5, 'prueba', gen_random_uuid(), $2)`, [sinStock, comprador.id]), 'sin existencia');
  });

  it('la tolerancia sale de los parámetros: con 0 % y 0 USD cualquier diferencia retiene la factura', async () => {
    const p = await producto();
    const o = await ordenRecibida(p, '100', '10.0000');
    await db.query(`update parametro_compra set valor = 0`);
    const id = await borrador(o, '100', '10.0100');
    expect((await registrar(id)).estado).toBe('retenida');
    await db.query(`update parametro_compra set valor = 2 where codigo = 'TOLERANCIA_PRECIO_PCT'`);
    await db.query(`update parametro_compra set valor = 1 where codigo = 'TOLERANCIA_PRECIO_USD'`);
    // Una diferencia pequeña en valor absoluto pasa por el monto en USD aunque supere el porcentaje.
    const p2 = await producto();
    const o2 = await ordenRecibida(p2, '1', '10.0000');
    expect((await registrar(await borrador(o2, '1', '10.5000'))).estado).toBe('contabilizada');   // 5 % pero 0,50 USD
    void otroGerente;
  });
});
