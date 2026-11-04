import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crearFactura, guardarLinea, registrarFactura } from '@/lib/compras/facturas';
import { buscarNotas, crearNota, detalleNota, lineasCorregibles, type DatosNota } from '@/lib/compras/notas-proveedor';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea as lineaOrden, type Usuario } from '@/lib/compras/ordenes';
import { cuadreCxP, partidasPorPagar } from '@/lib/compras/pagos';
import { recibirMercancia } from '@/lib/compras/recepciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Notas de crédito y de débito del proveedor, devolución de mercancía y su efecto en inventario, cuentas por pagar y retenciones
 * (spec §7.1, §7.2; migración 0039). Tasa: USD a Bs 40. Las facturas son en USD con IVA general de 16 %: 100 unidades a US$ 4 = base 400,
 * IVA 64, total 464 (Bs 18.560).
 */
describe('notas del proveedor: devolución, ajuste de precio y débito (R-CD a R-CF)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let gerente: Usuario;
  let otroGerente: Usuario;
  let almacenista: Usuario;
  let a01 = '';
  let general = '';
  let marca = '';
  let hoy = '';
  let n = 0;
  const prov: Record<string, string> = {};

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const agente = (iva: boolean, islr: boolean) => db.query('update empresa set agente_retencion_iva = $1, agente_retencion_islr = $2', [iva, islr]);

  const proveedor = async (clave: string, concepto: string | null = null) => {
    const n8 = String(33330000 + Object.keys(prov).length + 1);
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const conceptoId = concepto ? (await db.query<{ id: string }>('select id from concepto_islr where codigo = $1', [concepto])).rows[0].id : null;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: `Proveedor ${clave}`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: conceptoId },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    prov[clave] = r.id;
  };
  const producto = async () => {
    const codigo = `NP-${++n}`;
    const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
    return db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
      descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
  };
  /** Orden aprobada y recibida por completo. */
  const comprar = async (clave: string, prod: string, cantidad: string, precio: string) => {
    const orden = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: prov[clave], almacenId: a01, moneda: 'USD' }));
    await como(comprador, (tx) => lineaOrden(tx, orden, { productoId: prod, cantidad, precio }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, orden));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', orden, gerente.id, 'aprobada'));
    const [l] = (await detalleOrden(db, orden))!.lineas;
    await como(almacenista, (tx) => recibirMercancia(tx, almacenista, orden, [{ lineaId: l.id, cantidad }]));
    return { orden, lineaOrden: l.id };
  };
  /** Compra y factura contabilizada de `cantidad` × `precio`; devuelve la factura, su partida, su línea y el producto. */
  const facturar = async (clave: string, cantidad = '100', precio = '4.0000', prodExistente?: string) => {
    const prod = prodExistente ?? await producto();
    const o = await comprar(clave, prod, cantidad, precio);
    const id = await como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: o.orden, numeroFactura: `NF-${++n}`, numeroControl: `00-${n}`, fechaFactura: hoy }));
    await como(comprador, (tx) => guardarLinea(tx, id, { ordenLineaId: o.lineaOrden, cantidad, precio }));
    await como(comprador, (tx) => registrarFactura(tx, comprador, id));
    const partida = (await db.query<{ id: string }>('select id from partida_cxp where factura_id = $1', [id])).rows[0].id;
    const linea = (await db.query<{ id: string }>('select id from factura_compra_linea where factura_id = $1', [id])).rows[0].id;
    return { id, partida, linea, prod };
  };
  const datos = (f: { id: string; linea: string }, tipo: DatosNota['tipo'], clase: DatosNota['clase'], valor: string, extra: Partial<DatosNota> = {}): DatosNota => ({
    facturaId: f.id, tipo, clase, numeroDocumento: `NC-${++n}`, numeroControl: `00-${n}`, fecha: hoy, motivo: 'Mercancía en mal estado',
    lineas: [clase === 'devolucion' ? { facturaLineaId: f.linea, cantidad: valor } : { facturaLineaId: f.linea, monto: valor }], ...extra,
  });
  const registrar = (d: DatosNota, u = comprador) => como(u, (tx) => crearNota(tx, u, d));
  const aprobar = (id: string, u = gerente) => como(u, (tx) => resolverAprobacion(tx, 'nota_proveedor', id, u.id, 'aprobada'));
  const emitir = async (d: DatosNota) => { const r = await registrar(d); await aprobar(r.id); return r.id; };
  const partida = async (id: string) =>
    (await db.query<{ saldo: string; saldo_ves: string; saldo_usd: string; estado: string }>(
      'select saldo::text, saldo_ves::text, saldo_usd::text, estado from partida_cxp where id = $1', [id])).rows[0];
  const asiento = async (notaId: string) =>
    (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
      `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = 'nota_proveedor' and a.origen_id = $1 and a.tipo = 'automatico' order by l.id`, [notaId])).rows
      .map((l) => [l.codigo, l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd]);
  const costo = async (prod: string) =>
    (await db.query<{ q: string; v: string; c: string }>('select cantidad::text as q, valor_usd::text as v, costo_promedio_usd::text as c from producto_costo where producto_id = $1', [prod])).rows[0];
  const retenciones = async (notaId: string) =>
    (await db.query<{ impuesto: string; monto: string; signo: number }>('select impuesto, monto::text, signo from retencion_compra where nota_id = $1 order by impuesto', [notaId])).rows
      .map((r) => [r.impuesto, r.monto, r.signo]);
  const mayor = async (codigo: string, lado: 'haber' | 'debe') =>
    Number((await db.query<{ usd: string }>(
      `select coalesce(sum(l.${lado}_usd - l.${lado === 'haber' ? 'debe' : 'haber'}_usd), 0)::text as usd from asiento_linea l join asiento a on a.id = l.asiento_id
         join cuenta_contable c on c.id = l.cuenta_id where c.codigo = $1 and a.estado = 'contabilizado'`, [codigo])).rows[0].usd);
  const cuadra = async (conInventario = true) => {
    expect((await cuadreCxP(db)).cuadra).toBe(true);
    const g = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
    expect([Number(g.ves), Number(g.usd)]).toEqual([0, 0]);
    for (const [cuenta, impuesto] of [['2.1.04', 'iva'], ['2.1.05', 'islr']] as const) {
      const ret = (await db.query<{ usd: string }>('select coalesce(sum(monto_usd * signo), 0)::text as usd from retencion_compra where impuesto = $1', [impuesto])).rows[0].usd;
      expect(await mayor(cuenta, 'haber')).toBe(Number(ret));
    }
    if (conInventario) {
      const inv = (await db.query<{ v: string }>('select coalesce(sum(valor_usd), 0)::text as v from producto_costo')).rows[0].v;
      expect(await mayor('1.3.01', 'debe')).toBeCloseTo(Number(inv), 2);
    }
  };

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
    hoy = (await db.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`)).rows[0].hoy;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40.000000)`, [hoy]);
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_retencion_iva, agente_retencion_islr)
                    values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', false, false)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, a01, [idAlm]));
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    await db.query(`insert into concepto_islr (codigo, descripcion) values ('SERV', 'Servicios')`);
    await db.query(`insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, vigente_desde)
                    select id, 'J', true, 5, '2026-01-01' from concepto_islr where codigo = 'SERV'`);
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await proveedor(c);
    await proveedor('serv', 'SERV');
  });
  afterEach(() => agente(false, false));                                    // ninguna prueba deja a la empresa como agente
  afterAll(() => cerrar());

  it('registrar no mueve nada; al aprobar sale la mercancía y la nota de crédito reduce la cuenta por pagar', async () => {
    const f = await facturar('a');
    const r = await registrar(datos(f, 'nota_credito', 'devolucion', '25'));
    expect(await partida(f.partida)).toEqual({ saldo: '464.00', saldo_ves: '18560.00', saldo_usd: '464.00', estado: 'abierta' });
    expect((await costo(f.prod)).q).toBe('100.0000');
    const d = (await detalleNota(db, r.id))!;
    expect([d.estado, d.asiento, d.total, d.iva, d.base_imponible]).toEqual(['pendiente', null, '116.00', '16.00', '100.00']);

    await aprobar(r.id);
    expect((await detalleNota(db, r.id))!.estado).toBe('aprobada');
    expect(await costo(f.prod)).toEqual({ q: '75.0000', v: '300.00', c: '4.0000' });          // salieron 25 al costo promedio
    expect(await partida(f.partida)).toEqual({ saldo: '348.00', saldo_ves: '13920.00', saldo_usd: '348.00', estado: 'abierta' });
    expect(await asiento(r.id)).toEqual([
      ['2.1.01', '4640.00', '0.00', '116.00', '0.00'],
      ['1.3.01', '0.00', '4000.00', '0.00', '100.00'],
      ['1.2.03', '0.00', '640.00', '0.00', '16.00'],
    ]);
    const mov = (await db.query<{ tipo: string; cantidad: string }>(`select tipo, cantidad::text from movimiento_inventario where origen_tipo = 'nota_proveedor' and origen_id = $1`, [r.id])).rows;
    expect(mov).toEqual([{ tipo: 'devolucion_proveedor', cantidad: '-25.0000' }]);
    await cuadra();
  });

  it('devolución: si la mercancía costaba más que el crédito, la diferencia va a costo de ventas (debe)', async () => {
    const f = await facturar('a', '100', '4.0000');
    await comprar('a', f.prod, '100', '6.0000');                           // el costo promedio sube a US$ 5
    expect((await costo(f.prod)).c).toBe('5.0000');
    const id = await emitir(datos(f, 'nota_credito', 'devolucion', '25')); // crédito US$ 100 por mercancía que costó 125
    expect(await asiento(id)).toEqual([
      ['2.1.01', '4640.00', '0.00', '116.00', '0.00'],
      ['5.1.01', '1000.00', '0.00', '25.00', '0.00'],
      ['1.3.01', '0.00', '5000.00', '0.00', '125.00'],
      ['1.2.03', '0.00', '640.00', '0.00', '16.00'],
    ]);
    await cuadra();
  });

  it('devolución: si la mercancía costaba menos que el crédito, la diferencia va a costo de ventas (haber)', async () => {
    const f = await facturar('a', '100', '4.0000');
    await comprar('a', f.prod, '100', '2.0000');                           // el costo promedio baja a US$ 3
    const id = await emitir(datos(f, 'nota_credito', 'devolucion', '25')); // crédito US$ 100 por mercancía que costó 75
    expect(await asiento(id)).toEqual([
      ['2.1.01', '4640.00', '0.00', '116.00', '0.00'],
      ['1.3.01', '0.00', '3000.00', '0.00', '75.00'],
      ['5.1.01', '0.00', '1000.00', '0.00', '25.00'],
      ['1.2.03', '0.00', '640.00', '0.00', '16.00'],
    ]);
    await cuadra();
  });

  it('nota de crédito por ajuste de precio: abarata el inventario que sigue en existencia y reduce el IVA crédito', async () => {
    const f = await facturar('b');
    const id = await emitir(datos(f, 'nota_credito', 'ajuste_precio', '40'));   // descuento de US$ 40 + IVA 6,40
    expect(await costo(f.prod)).toEqual({ q: '100.0000', v: '360.00', c: '3.6000' });
    expect(await partida(f.partida)).toEqual({ saldo: '417.60', saldo_ves: '16704.00', saldo_usd: '417.60', estado: 'abierta' });
    expect(await asiento(id)).toEqual([
      ['2.1.01', '1856.00', '0.00', '46.40', '0.00'],
      ['1.3.01', '0.00', '1600.00', '0.00', '40.00'],
      ['1.2.03', '0.00', '256.00', '0.00', '6.40'],
    ]);
    await cuadra();
  });

  it('nota de débito: abre su propia cuenta por pagar, encarece el inventario y suma IVA crédito', async () => {
    const f = await facturar('b');
    const id = await emitir(datos(f, 'nota_debito', 'ajuste_precio', '40', { motivo: 'Ajuste de precio a mayor' }));
    expect(await costo(f.prod)).toEqual({ q: '100.0000', v: '440.00', c: '4.4000' });
    expect(await partida(f.partida)).toMatchObject({ saldo: '464.00' });                    // la factura no cambia
    expect(await asiento(id)).toEqual([
      ['1.3.01', '1600.00', '0.00', '40.00', '0.00'],
      ['1.2.03', '256.00', '0.00', '6.40', '0.00'],
      ['2.1.01', '0.00', '1856.00', '0.00', '46.40'],
    ]);
    const nd = (await db.query<{ saldo: string; saldo_ves: string; fecha: string; venc: string; moneda: string }>(
      `select saldo::text, saldo_ves::text, fecha::text, vencimiento::text as venc, moneda from partida_cxp where nota_id = $1`, [id])).rows[0];
    expect([nd.saldo, nd.saldo_ves, nd.moneda]).toEqual(['46.40', '1856.00', 'USD']);
    const dias = (await db.query<{ d: number }>('select ($1::date - $2::date)::int as d', [nd.venc, nd.fecha])).rows[0].d;
    expect(dias).toBe(30);                                                                 // condición de pago del proveedor
    expect((await partidasPorPagar(db, prov.b)).some((p) => p.factura.startsWith('ND '))).toBe(true);
    await cuadra();
  });

  it('retención de IVA: la nota la ajusta en proporción y reduce lo retenido por enterar', async () => {
    await agente(true, false);
    const f = await facturar('c');                                         // IVA 64, retención 48, cuenta por pagar 416
    expect(await partida(f.partida)).toMatchObject({ saldo: '416.00' });
    const id = await emitir(datos(f, 'nota_credito', 'devolucion', '25')); // IVA de la nota 16 → retención 12
    expect(await retenciones(id)).toEqual([['iva', '12.00', -1]]);
    expect(await partida(f.partida)).toEqual({ saldo: '312.00', saldo_ves: '12480.00', saldo_usd: '312.00', estado: 'abierta' });   // 416 − (116 − 12)
    expect(await asiento(id)).toEqual([
      ['2.1.01', '4160.00', '0.00', '104.00', '0.00'],
      ['2.1.04', '480.00', '0.00', '12.00', '0.00'],
      ['1.3.01', '0.00', '4000.00', '0.00', '100.00'],
      ['1.2.03', '0.00', '640.00', '0.00', '16.00'],
    ]);
    await cuadra();
    await agente(false, false);
  });

  it('retención de IVA e ISLR: la nota de débito suma lo retenido y la de crédito resta, en proporción a la base', async () => {
    await agente(true, true);
    const f = await facturar('serv');                                      // ISLR 5 % de 400 = 20; IVA 48; cuenta por pagar 396
    expect(await partida(f.partida)).toMatchObject({ saldo: '396.00' });
    const nc = await emitir(datos(f, 'nota_credito', 'devolucion', '25')); // base 100 → ISLR 5; IVA 16 → 12
    expect(await retenciones(nc)).toEqual([['islr', '5.00', -1], ['iva', '12.00', -1]]);
    expect(await partida(f.partida)).toMatchObject({ saldo: '297.00' });   // 396 − (116 − 12 − 5)
    const nd = await emitir(datos(f, 'nota_debito', 'ajuste_precio', '40'));      // base 40 → ISLR 2; IVA 6,40 → 4,80
    expect(await retenciones(nd)).toEqual([['islr', '2.00', 1], ['iva', '4.80', 1]]);
    // Tras devolver 25 de 100, quedan 75 en existencia: de los 40 del ajuste, 30 van al inventario y 10 al costo de ventas.
    expect(await asiento(nd)).toEqual([
      ['1.3.01', '1200.00', '0.00', '30.00', '0.00'],
      ['5.1.01', '400.00', '0.00', '10.00', '0.00'],
      ['1.2.03', '256.00', '0.00', '6.40', '0.00'],
      ['2.1.01', '0.00', '1584.00', '0.00', '39.60'],                      // 46,40 − 4,80 − 2,00
      ['2.1.04', '0.00', '192.00', '0.00', '4.80'],
      ['2.1.05', '0.00', '80.00', '0.00', '2.00'],
    ]);
    await cuadra();
    await agente(false, false);
  });

  it('una nota de crédito no puede exceder el saldo por pagar de su factura', async () => {
    const f = await facturar('d');
    await db.transaction(async (tx) => {                                   // se simula que la factura ya se pagó casi toda
      await tx.query("select set_config('app.cxp_interno', '1', true)");
      await tx.query(`update partida_cxp set saldo = 10, saldo_ves = 400, saldo_usd = 10 where id = $1`, [f.partida]);
    });
    await esperarError(registrar(datos(f, 'nota_credito', 'devolucion', '25')), 'excede el saldo por pagar');
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.cxp_interno', '1', true)");
      await tx.query(`update partida_cxp set saldo = 464, saldo_ves = 18560, saldo_usd = 464 where id = $1`, [f.partida]);
    });
  });

  it('no se devuelve más de lo facturado ni se acredita más de lo facturado, contando lo ya pendiente o aprobado', async () => {
    const f = await facturar('e');
    await registrar(datos(f, 'nota_credito', 'devolucion', '90'));
    await esperarError(registrar(datos(f, 'nota_credito', 'devolucion', '20')), 'solo se pueden devolver 10');
    await esperarError(registrar(datos(f, 'nota_credito', 'ajuste_precio', '100')), 'no puede pasar de');   // 400 − 360 ya acreditados = 40
    const l = (await lineasCorregibles(db, f.id))[0];
    expect([l.devuelto, l.acreditado]).toEqual(['90.0000', '360.00']);
  });

  it('aprobar: no la aprueba quien la registró; otra persona de Gerencia sí; rechazar no mueve nada', async () => {
    const f = await facturar('f');
    const r = await registrar(datos(f, 'nota_credito', 'devolucion', '10'), gerente);
    await expect(aprobar(r.id, gerente)).rejects.toThrow();
    expect((await detalleNota(db, r.id))!.estado).toBe('pendiente');
    expect((await costo(f.prod)).q).toBe('100.0000');
    await aprobar(r.id, otroGerente);
    expect((await detalleNota(db, r.id))!.estado).toBe('aprobada');

    const x = await registrar(datos(f, 'nota_credito', 'devolucion', '5'));
    await como(gerente, (tx) => resolverAprobacion(tx, 'nota_proveedor', x.id, gerente.id, 'rechazada', { comentario: 'No corresponde' }));
    const d = (await detalleNota(db, x.id))!;
    expect([d.estado, d.rechazo_motivo, d.asiento]).toEqual(['rechazada', 'No corresponde', null]);
    expect((await costo(f.prod)).q).toBe('90.0000');                       // solo salieron las 10 aprobadas
    // Lo rechazado vuelve a estar disponible.
    expect((await lineasCorregibles(db, f.id))[0].devuelto).toBe('10.0000');
  });

  it('validaciones: factura inexistente, nota de débito por devolución, número repetido, fecha futura y motivo', async () => {
    const f = await facturar('g');
    await esperarError(registrar(datos({ id: '00000000-0000-4000-8000-000000000000', linea: f.linea }, 'nota_credito', 'devolucion', '1')), 'no existe');
    await esperarError(registrar(datos(f, 'nota_debito', 'devolucion', '1')), 'solo ajusta precio');
    await esperarError(registrar(datos(f, 'nota_credito', 'devolucion', '1', { fecha: '2999-01-01' })), 'no puede ser futura');
    await esperarError(registrar(datos(f, 'nota_credito', 'devolucion', '1', { motivo: 'x' })), 'motivo');
    await esperarError(registrar(datos(f, 'nota_credito', 'devolucion', '0')), 'mayor que cero');
    await registrar(datos(f, 'nota_credito', 'devolucion', '1', { numeroDocumento: 'DUP-1' }));
    await esperarError(registrar(datos(f, 'nota_credito', 'devolucion', '1', { numeroDocumento: 'dup-1' })), 'nota_proveedor_documento_unico');
  });

  it('una nota y sus líneas no se editan ni se borran', async () => {
    const id = (await db.query<{ id: string }>(`select id from nota_proveedor where estado = 'aprobada' limit 1`)).rows[0].id;
    await esperarError(db.query(`update nota_proveedor set motivo = 'otro motivo' where id = $1`, [id]), 'no se edita');
    await esperarError(db.query('delete from nota_proveedor where id = $1', [id]), 'no se borra');
    await esperarError(db.query('update nota_proveedor_linea set base = 1 where nota_id = $1', [id]), 'no se modifican');
    await esperarError(db.query(`update retencion_compra set monto = 1 where nota_id is not null`), 'no se modifica');
  });

  it('listados y numeración: cada tipo tiene su correlativo sin huecos', async () => {
    const todas = await buscarNotas(db, comprador, {});
    expect(todas.length).toBeGreaterThan(8);
    const creditos = todas.filter((x) => x.tipo === 'nota_credito').map((x) => Number(x.numero)).sort((a, b) => a - b);
    expect(creditos).toEqual(creditos.map((_, i) => i + 1));
    expect((await buscarNotas(db, comprador, { estado: 'rechazada' })).every((x) => x.estado === 'rechazada')).toBe(true);
    expect(await buscarNotas(db, { id: comprador.id, roles: ['ventas'] }, {})).toEqual([]);
  });

  it('ajuste de precio con parte de la mercancía ya vendida: lo vendido va a costo de ventas', async () => {
    const f = await facturar('c');
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('salida_venta', $1, $2, -50, 0, 'prueba', gen_random_uuid())`, [f.prod, a01]));
    const id = await emitir(datos(f, 'nota_credito', 'ajuste_precio', '40'));   // quedan 50 de 100: 20 al inventario, 20 al costo de ventas
    expect(await asiento(id)).toEqual([
      ['2.1.01', '1856.00', '0.00', '46.40', '0.00'],
      ['1.3.01', '0.00', '800.00', '0.00', '20.00'],
      ['5.1.01', '0.00', '800.00', '0.00', '20.00'],
      ['1.2.03', '0.00', '256.00', '0.00', '6.40'],
    ]);
    await cuadra(false);
  });

  it('cuadre final: cuentas por pagar, anticipos y retenciones contra el mayor, y el mayor cuadra', async () => {
    await cuadra(false);
  });
});
