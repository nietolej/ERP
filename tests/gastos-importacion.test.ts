import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actualizarGasto, buscarGastos, calcularReparto, crearGasto, detalleGasto, eliminarGasto, recepcionesElegibles,
  registrarGasto, type DatosGasto,
} from '@/lib/compras/gastos-importacion';
import { cuentasPorPagar } from '@/lib/compras/facturas';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea, type Usuario } from '@/lib/compras/ordenes';
import { recibirMercancia } from '@/lib/compras/recepciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase, type DatosProducto } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('gastos de importación y costo en destino (§7.2 regla 3, R-BG a R-BI)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let gerente: Usuario;
  let almacenista: Usuario;
  let a01: string;
  let mercancia: string;       // proveedor de mercancía
  let transporte: string;      // proveedor de servicios
  let inactivo: string;
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
    const codigo = `GI-${++n}`;
    const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
    return db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
      descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true, ...extra,
    }));
  };
  /** Orden aprobada y recibida completa; devuelve el id de la recepción. */
  const recibida = async (items: [string, string, string][], moneda = 'USD', criterio = 'valor') => {
    const id = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: mercancia, almacenId: a01, moneda, criterioReparto: criterio }));
    for (const [p, c, pr] of items) await como(comprador, (tx) => guardarLinea(tx, id, { productoId: p, cantidad: c, precio: pr }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', id, gerente.id, 'aprobada'));
    const lineas = (await detalleOrden(db, id))!.lineas;
    const r = await como(almacenista, (tx) => recibirMercancia(tx, almacenista, id, lineas.map((l) => ({ lineaId: l.id, cantidad: l.cantidad }))));
    return r.id;
  };
  const datos = (recepcionIds: string[], extra: Partial<DatosGasto> = {}): DatosGasto => ({
    proveedorId: transporte, concepto: 'flete', numeroFactura: `FL-${++n}`, numeroControl: `00-${n}`, fechaFactura: hoy, moneda: 'USD',
    base: '100.00', alicuotaIvaId: exento, recepcionIds, ...extra,
  });
  const nuevo = (d: DatosGasto) => como(comprador, (tx) => crearGasto(tx, comprador, d));
  const registrar = (id: string) => como(comprador, (tx) => registrarGasto(tx, comprador, id));
  const vistaPrevia = async (id: string) => (await como(comprador, (tx) => calcularReparto(tx, id))).lineas.map((l) => [l.codigo, l.monto]);
  const costo = async (prod: string) =>
    (await db.query<{ c: string; v: string; q: string }>(
      'select costo_promedio_usd::text as c, valor_usd::text as v, cantidad::text as q from producto_costo where producto_id = $1', [prod])).rows[0];
  const asiento = async (origenId: string) =>
    (await db.query<{ codigo: string; debe: string; haber: string; debe_ves: string; haber_ves: string }>(
      `select c.codigo, l.debe_usd::text as debe, l.haber_usd::text as haber, l.debe_ves::text, l.haber_ves::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = 'gasto_importacion' and a.origen_id = $1 order by l.id`, [origenId])).rows;
  const vender = (prod: string, cantidad: string) => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('salida_venta', $1, $2, $3, 0, 'prueba', gen_random_uuid())`, [prod, a01, `-${cantidad}`]));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idCom = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    comprador = { id: idCom, roles: ['compras'] };
    gerente = { id: idGer, roles: ['gerencia'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    hoy = (await db.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`)).rows[0].hoy;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40.000000), ($1::date, 'EUR', 50.000000)`, [hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, a01, [idAlm]));

    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const nuevoProveedor = async (n8: string, tipo: 'mercancia_local' | 'servicios', activar = true) => {
      const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
        rif: `J-${n8}-${digitoVerificador('J', n8)}`,
        sensibles: { razonSocial: `Proveedor ${n8}`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo, pais: 'VE', conceptoIslrId: null },
        contacto: { telefono: '0212-5550000' },
      }));
      if (activar) await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
      return r.id;
    };
    mercancia = await nuevoProveedor('11111111', 'mercancia_local');
    transporte = await nuevoProveedor('22222222', 'servicios');
    inactivo = await nuevoProveedor('33333333', 'servicios', false);
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
  });
  afterAll(() => cerrar());

  it('el criterio de reparto decide cuánto del gasto toca a cada producto: valor, peso, volumen o cantidad', async () => {
    // A: 10 und × US$ 10 = 100 · 3 kg c/u = 30 kg · 0,002 m³ c/u = 0,02 m³
    // B:  5 und × US$ 40 = 200 · 4 kg c/u = 20 kg · 0,010 m³ c/u = 0,05 m³
    const a = await producto({ pesoKg: '3', empaqueLargoCm: '20', empaqueAnchoCm: '10', empaqueAltoCm: '10', unidadesPorEmpaque: '1' });
    const b = await producto({ pesoKg: '4', empaqueLargoCm: '50', empaqueAnchoCm: '20', empaqueAltoCm: '10', unidadesPorEmpaque: '1' });
    const rec = await recibida([[a, '10', '10.0000'], [b, '5', '40.0000']]);
    // Los cuatro criterios sobre un gasto de US$ 100,00 (la suma de las partes es siempre 100,00).
    const casos: [string, string[]][] = [
      ['valor', ['33.33', '66.67']],      // 100 : 200
      ['peso', ['60.00', '40.00']],       // 30 kg : 20 kg
      ['volumen', ['28.57', '71.43']],    // 0,02 : 0,05 m³
      ['cantidad', ['66.67', '33.33']],   // 10 : 5 unidades
    ];
    for (const [criterio, partes] of casos) {
      const id = await nuevo(datos([rec], { criterioReparto: criterio }));
      const lineas = await vistaPrevia(id);
      expect(lineas.map((l) => l[1])).toEqual(partes);
      expect(partes.reduce((s, p) => s + Math.round(Number(p) * 100), 0)).toBe(10000);
      await como(comprador, (tx) => eliminarGasto(tx, id));
    }
  });

  it('registrar: capitaliza el gasto en el inventario por producto, abre la cuenta por pagar y genera el asiento', async () => {
    const a = await producto({ pesoKg: '3' });
    const b = await producto({ pesoKg: '4' });
    const rec = await recibida([[a, '10', '10.0000'], [b, '5', '40.0000']]);
    const id = await nuevo(datos([rec], { criterioReparto: 'peso', base: '90.00', alicuotaIvaId: general, concepto: 'flete' }));
    const r = await registrar(id);
    expect([r.inventario, r.costoVentas]).toEqual(['90.00', '0.00']);

    const d = (await detalleGasto(db, id))!;
    expect([d.estado, d.base, d.iva, d.total, d.total_usd, d.saldo]).toEqual(['contabilizado', '90.00', '14.40', '104.40', '104.40', '104.40']);
    expect(d.numero).toMatch(/^\d+$/);
    // Peso: A 30 kg, B 20 kg → 54,00 y 36,00
    expect(d.reparto.map((l) => [l.codigo, l.monto, l.monto_inventario, l.monto_costo_ventas])).toEqual([
      [(await db.query<{ codigo: string }>('select codigo from producto where id = $1', [a])).rows[0].codigo, '54.00', '54.00', '0.00'],
      [(await db.query<{ codigo: string }>('select codigo from producto where id = $1', [b])).rows[0].codigo, '36.00', '36.00', '0.00'],
    ]);
    // Costo promedio: (100 + 54) ÷ 10 = 15,40 · (200 + 36) ÷ 5 = 47,20
    expect((await costo(a)).c).toBe('15.4000');
    expect((await costo(b)).c).toBe('47.2000');
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber, l.debe_ves, l.haber_ves])).toEqual([
      ['1.3.01', '90.00', '0.00', '3600.00', '0.00'],
      ['1.2.03', '14.40', '0.00', '576.00', '0.00'],
      ['2.1.01', '0.00', '104.40', '0.00', '4176.00'],
    ]);
    const cxp = (await db.query<{ factura_id: string | null; saldo: string; vencimiento: string; fecha: string }>(
      'select factura_id, saldo::text, vencimiento::text, fecha::text from partida_cxp where gasto_id = $1', [id])).rows[0];
    expect(cxp.factura_id).toBeNull();
    expect(cxp.saldo).toBe('104.40');
    expect((await db.query<{ d: number }>('select ($1::date - $2::date)::int as d', [cxp.vencimiento, cxp.fecha])).rows[0].d).toBe(30);
  });

  it('cuadre de auxiliares: el valor del inventario y las cuentas por pagar coinciden con el mayor', async () => {
    const mayor = async (codigo: string) =>
      (await db.query<{ usd: string }>(
        `select coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd from asiento_linea l join asiento a on a.id = l.asiento_id
           join cuenta_contable c on c.id = l.cuenta_id where c.codigo = $1 and a.estado = 'contabilizado'`, [codigo])).rows[0].usd;
    const inventario = (await db.query<{ v: string }>('select coalesce(sum(valor_usd), 0)::text as v from producto_costo')).rows[0].v;
    // Las recepciones del grupo de pruebas anterior sí contabilizan inventario; las ventas simuladas se hacen después.
    expect(Number(await mayor('1.3.01'))).toBeCloseTo(Number(inventario), 2);
    const cxp = (await db.query<{ usd: string }>(
      `select coalesce(sum(round(monto_usd * saldo / monto_original, 2)), 0)::text as usd from partida_cxp where estado = 'abierta'`)).rows[0].usd;
    expect(-Number(await mayor('2.1.01'))).toBeCloseTo(Number(cxp), 2);
  });

  it('lo que corresponde a unidades ya vendidas va al costo de ventas', async () => {
    const p = await producto();
    const rec = await recibida([[p, '10', '10.0000']]);
    await vender(p, '6');                                        // quedan 4 en existencia
    const id = await nuevo(datos([rec], { base: '50.00' }));
    const r = await registrar(id);
    expect([r.inventario, r.costoVentas]).toEqual(['20.00', '30.00']);
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber])).toEqual([
      ['1.3.01', '20.00', '0.00'], ['5.1.01', '30.00', '0.00'], ['2.1.01', '0.00', '50.00'],
    ]);
    const c = await costo(p);
    expect([c.q, c.v, c.c]).toEqual(['4.0000', '60.00', '15.0000']);    // 4 × 10,00 + 20,00
  });

  it('dos recepciones del mismo producto comparten la existencia: no se capitaliza dos veces', async () => {
    const p = await producto();
    const r1 = await recibida([[p, '5', '10.0000']]);
    const r2 = await recibida([[p, '5', '10.0000']]);
    await vender(p, '4');                                        // quedan 6 de 10
    const id = await nuevo(datos([r1, r2], { base: '100.00' }));
    const r = await registrar(id);
    expect([r.inventario, r.costoVentas]).toEqual(['60.00', '40.00']);
    const d = (await detalleGasto(db, id))!;
    expect(d.reparto.map((l) => [l.monto, l.monto_inventario, l.monto_costo_ventas])).toEqual([['50.00', '30.00', '20.00'], ['50.00', '30.00', '20.00']]);
    expect((await costo(p)).v).toBe('120.00');                   // 6 × 10,00 + 60,00
  });

  it('un gasto en euros se contabiliza en euros y capitaliza su equivalente en dólares', async () => {
    const p = await producto();
    const rec = await recibida([[p, '10', '10.0000']]);
    const id = await nuevo(datos([rec], { moneda: 'EUR', base: '100.00' }));
    const r = await registrar(id);
    expect(r.inventario).toBe('100.00');
    const d = (await detalleGasto(db, id))!;
    expect([d.moneda, d.tasa, d.total, d.total_usd]).toEqual(['EUR', '50.000000', '100.00', '125.00']);
    expect((await asiento(id)).map((l) => [l.codigo, l.debe, l.haber, l.debe_ves, l.haber_ves])).toEqual([
      ['1.3.01', '125.00', '0.00', '5000.00', '0.00'], ['2.1.01', '0.00', '125.00', '0.00', '5000.00'],
    ]);
    expect((await costo(p)).v).toBe('225.00');                   // 100 + 125
  });

  it('sin la medida del criterio no se registra y no queda nada a medias', async () => {
    const con = await producto({ pesoKg: '2' });
    const sin = await producto();
    const rec = await recibida([[con, '4', '10.0000'], [sin, '4', '10.0000']]);
    const d = datos([rec], { criterioReparto: 'peso' });
    const id = await nuevo(d);
    const antes = await costo(con);
    await esperarError(registrar(id), 'peso por unidad');
    await esperarError(registrar(id), 'GI-');
    expect((await costo(con)).v).toBe(antes.v);
    expect((await detalleGasto(db, id))!.estado).toBe('borrador');
    expect((await db.query('select 1 from gasto_importacion_reparto where gasto_id = $1', [id])).rows).toHaveLength(0);
    // Cambiando el criterio del borrador sí se puede registrar.
    await como(comprador, (tx) => actualizarGasto(tx, id, { ...d, criterioReparto: 'valor' }));
    expect((await registrar(id)).inventario).toBe('100.00');
    expect((await detalleGasto(db, id))!.criterio_reparto).toBe('valor');
  });

  it('un gasto registrado no se edita, no se borra y su cuenta por pagar no se manipula', async () => {
    const p = await producto();
    const rec = await recibida([[p, '10', '10.0000']]);
    const id = await nuevo(datos([rec]));
    await registrar(id);
    await esperarError(registrar(id), 'borrador');
    await esperarError(db.query(`update gasto_importacion set base = 1 where id = $1`, [id]), 'no se modifica');
    await esperarError(db.query('delete from gasto_importacion where id = $1', [id]), 'no se borra');
    await esperarError(db.query(`update gasto_importacion_reparto set monto = 1 where gasto_id = $1`, [id]), 'no se modifica');
    await esperarError(db.query(`delete from gasto_importacion_recepcion where gasto_id = $1`, [id]), 'no se modifica');
    await esperarError(db.query(`update partida_cxp set saldo = 0 where gasto_id = $1`, [id]), 'solo cambia con un pago');
    await esperarError(db.query(`delete from partida_cxp where gasto_id = $1`, [id]), 'no se borra');
    await esperarError(como(comprador, (tx) => eliminarGasto(tx, id)), 'borrador');
  });

  it('validaciones: proveedor activo, montos, recepciones emitidas y factura sin repetir', async () => {
    const p = await producto();
    const rec = await recibida([[p, '2', '10.0000']]);
    await esperarError(nuevo(datos([rec], { proveedorId: inactivo })), 'activo');
    await esperarError(nuevo(datos([rec], { base: '0' })), 'mayor que cero');
    await esperarError(nuevo(datos([rec], { base: '1.234' })), 'mayor que cero');
    await esperarError(nuevo(datos([rec], { concepto: 'regalo' })), 'concepto');
    await esperarError(nuevo(datos([])), 'al menos una recepción');
    await esperarError(nuevo(datos(['00000000-0000-4000-8000-000000000000'])), 'no existe o no está emitida');
    await esperarError(nuevo(datos([rec], { numeroFactura: '', numeroControl: '1' })), 'número de la factura');
    await esperarError(nuevo(datos([rec], { fechaFactura: '2999-01-01' })), 'futura');
    const ok = await nuevo(datos([rec], { numeroFactura: 'REP-1' }));
    await esperarError(nuevo(datos([rec], { numeroFactura: 'rep-1' })), 'ya tiene registrada');
    await como(comprador, (tx) => eliminarGasto(tx, ok));
    expect(await nuevo(datos([rec], { numeroFactura: 'rep-1' }))).toBeTruthy();       // borrado el borrador, se puede reutilizar
  });

  it('listas y consultas: recepciones elegibles, gastos, y la cuenta por pagar del gasto aparece con su origen', async () => {
    const recs = await recepcionesElegibles(db);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].texto).toMatch(/^Recepción \d+ · orden \d+/);
    const gastos = await buscarGastos(db, comprador);
    expect(gastos.some((g) => g.estado === 'contabilizado')).toBe(true);
    expect(await buscarGastos(db, { id: comprador.id, roles: ['ventas'] })).toEqual([]);
    const cxp = await cuentasPorPagar(db, comprador);
    expect(cxp.some((c) => c.gasto_id !== null && c.factura_id === null)).toBe(true);
  });
});
