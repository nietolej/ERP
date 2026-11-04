import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearFactura, detalleFactura, guardarLinea, registrarFactura } from '@/lib/compras/facturas';
import { crearGasto, registrarGasto } from '@/lib/compras/gastos-importacion';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea as lineaOrden, type Usuario } from '@/lib/compras/ordenes';
import { recibirMercancia } from '@/lib/compras/recepciones';
import { retencionesDe } from '@/lib/compras/retenciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Retenciones de IVA e ISLR al contabilizar compras (spec §7.2 regla 4, §11.0, §11.2; migración 0037).
 * Referencias: IVA 16 %, retención 75 % (100 % si se marca), UT Bs 43 y tasa Bs 40 por USD → 1 UT = US$ 1,075.
 */
describe('retenciones de IVA e ISLR en facturas de compra y gastos de importación (R-BX, R-BY)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let gerente: Usuario;
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

  const proveedor = async (clave: string, concepto: string | null) => {
    const n8 = String(11110000 + Object.keys(prov).length + 1);
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
    const codigo = `RT-${++n}`;
    const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
    return db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
      descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
  };
  /** Orden aprobada y recibida completa. */
  const recibida = async (proveedorId: string, cantidad: string, precio: string) => {
    const p = await producto();
    const id = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId, almacenId: a01, moneda: 'USD' }));
    await como(comprador, (tx) => lineaOrden(tx, id, { productoId: p, cantidad, precio }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', id, gerente.id, 'aprobada'));
    const [l] = (await detalleOrden(db, id))!.lineas;
    const r = await como(almacenista, (tx) => recibirMercancia(tx, almacenista, id, [{ lineaId: l.id, cantidad }]));
    return { ordenId: id, lineaId: l.id, recepcionId: r.id };
  };
  /** Factura exacta contra su recepción, ya registrada: devuelve su id. */
  const facturar = async (proveedorId: string, cantidad: string, precio: string, retencionIvaTotal = false) => {
    const o = await recibida(proveedorId, cantidad, precio);
    const id = await como(comprador, (tx) => crearFactura(tx, comprador, {
      ordenId: o.ordenId, numeroFactura: `RF-${++n}`, numeroControl: `00-${n}`, fechaFactura: hoy, retencionIvaTotal,
    }));
    await como(comprador, (tx) => guardarLinea(tx, id, { ordenLineaId: o.lineaId, cantidad, precio }));
    return id;
  };
  const registrar = (id: string) => como(comprador, (tx) => registrarFactura(tx, comprador, id));
  const asiento = async (tipo: string, origenId: string) =>
    (await db.query<{ codigo: string; debe: string; haber: string; debe_ves: string; haber_ves: string }>(
      `select c.codigo, l.debe_usd::text as debe, l.haber_usd::text as haber, l.debe_ves::text, l.haber_ves::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = $1 and a.origen_id = $2 order by l.id`, [tipo, origenId])).rows;
  const saldo = async (columna: 'factura_id' | 'gasto_id', id: string) =>
    (await db.query<{ saldo: string; usd: string }>(`select saldo::text, monto_usd::text as usd from partida_cxp where ${columna} = $1`, [id])).rows[0];

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
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40.000000)`, [hoy]);
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_retencion_iva, agente_retencion_islr)
                    values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', true, true)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, a01, [idAlm]));
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));

    // Conceptos de ISLR de prueba (Contabilidad los carga; no vienen precargados): SERV 5 % con mínimo de 10 UT; SUS 5 % con sustraendo de 2 UT; SIN sin tarifa.
    for (const c of ['SERV', 'SUS', 'SIN']) await db.query('insert into concepto_islr (codigo, descripcion) values ($1, $2)', [c, `Concepto ${c}`]);
    const tarifa = (c: string, minimo: number, sustraendo: number) => db.query(
      `insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, base_minima_ut, sustraendo_ut, vigente_desde)
       select id, 'J', true, 5, $2, $3, '2026-01-01' from concepto_islr where codigo = $1`, [c, minimo, sustraendo]);
    await tarifa('SERV', 10, 0);
    await tarifa('SUS', 0, 2);
    await proveedor('iva', null);
    await proveedor('serv', 'SERV');
    await proveedor('sus', 'SUS');
    await proveedor('sin', 'SIN');
  });
  afterAll(() => cerrar());

  it('IVA: retiene 75 % del IVA, la cuenta por pagar nace por el neto y el asiento acredita 2.1.04', async () => {
    const id = await facturar(prov.iva, '100', '4.0000');                // base 400, IVA 64
    const r = await registrar(id);
    expect(r.estado).toBe('contabilizada');
    expect(await retencionesDe(db, { facturaId: id })).toEqual([
      { impuesto: 'iva', base: '64.00', porcentaje: '75.0000', sustraendo: '0.00', monto: '48.00', monto_usd: '48.00', iva_total: false, concepto: null },
    ]);
    expect((await detalleFactura(db, id))!.saldo).toBe('416.00');          // 464 − 48
    expect((await asiento('factura_compra', id)).map((l) => [l.codigo, l.debe, l.haber, l.debe_ves, l.haber_ves])).toEqual([
      ['2.1.02', '400.00', '0.00', '16000.00', '0.00'],
      ['1.2.03', '64.00', '0.00', '2560.00', '0.00'],
      ['2.1.01', '0.00', '416.00', '0.00', '16640.00'],
      ['2.1.04', '0.00', '48.00', '0.00', '1920.00'],
    ]);
    expect((await saldo('factura_id', id)).usd).toBe('416.00');
  });

  it('IVA al 100 %: si se marca, retiene todo el IVA', async () => {
    const id = await facturar(prov.iva, '50', '4.0000', true);            // base 200, IVA 32
    await registrar(id);
    const [r] = await retencionesDe(db, { facturaId: id });
    expect([r.porcentaje, r.monto, r.iva_total]).toEqual(['100.0000', '32.00', true]);
    expect((await saldo('factura_id', id)).saldo).toBe('200.00');          // 232 − 32
  });

  it('ISLR: porcentaje de la tarifa vigente sobre la base sin IVA, además del IVA; acredita 2.1.05', async () => {
    const id = await facturar(prov.serv, '100', '4.0000');                // base 400: 5 % = 20; IVA 64 → 48
    await registrar(id);
    const ret = await retencionesDe(db, { facturaId: id });
    expect(ret.map((r) => [r.impuesto, r.base, r.porcentaje, r.sustraendo, r.monto, r.concepto])).toEqual([
      ['islr', '400.00', '5.0000', '0.00', '20.00', 'SERV'],
      ['iva', '64.00', '75.0000', '0.00', '48.00', null],
    ]);
    expect((await asiento('factura_compra', id)).map((l) => [l.codigo, l.haber])).toEqual([
      ['2.1.02', '0.00'], ['1.2.03', '0.00'], ['2.1.01', '396.00'], ['2.1.04', '48.00'], ['2.1.05', '20.00'],
    ]);
    expect((await saldo('factura_id', id)).saldo).toBe('396.00');          // 464 − 48 − 20
  });

  it('ISLR: bajo el mínimo en UT no se retiene (1 UT = US$ 1,075, el mínimo son 10 UT)', async () => {
    const id = await facturar(prov.serv, '2', '4.0000');                  // base 8 < 10,75
    await registrar(id);
    expect((await retencionesDe(db, { facturaId: id })).map((r) => r.impuesto)).toEqual(['iva']);
  });

  it('ISLR: el sustraendo en UT se resta de la retención', async () => {
    const id = await facturar(prov.sus, '100', '4.0000');                 // 5 % de 400 = 20 − 2 UT (2,15) = 17,85
    await registrar(id);
    const islr = (await retencionesDe(db, { facturaId: id })).find((r) => r.impuesto === 'islr')!;
    expect([islr.sustraendo, islr.monto]).toEqual(['2.15', '17.85']);
  });

  it('ISLR: un concepto asignado sin tarifa vigente no se contabiliza ni se omite en silencio', async () => {
    const id = await facturar(prov.sin, '10', '4.0000');
    await esperarError(registrar(id), 'Falta la tarifa de ISLR vigente');
    const d = (await detalleFactura(db, id))!;
    expect(d.estado).toBe('borrador');                                     // la transacción se revirtió completa
    expect((await db.query('select 1 from partida_cxp where factura_id = $1', [id])).rows).toHaveLength(0);
  });

  it('una empresa que no es agente no retiene nada: la cuenta por pagar es el total', async () => {
    await agente(false, false);
    const id = await facturar(prov.serv, '100', '4.0000');
    await registrar(id);
    expect(await retencionesDe(db, { facturaId: id })).toEqual([]);
    expect((await saldo('factura_id', id)).saldo).toBe('464.00');
    await agente(true, true);
  });

  it('gasto de importación: retiene IVA e ISLR y la cuenta por pagar nace por el neto', async () => {
    const o = await recibida(prov.iva, '10', '1.0000');
    const id = await como(comprador, (tx) => crearGasto(tx, comprador, {
      proveedorId: prov.serv, concepto: 'flete', numeroFactura: `FL-${++n}`, numeroControl: `00-${n}`, fechaFactura: hoy, moneda: 'USD',
      base: '1000.00', alicuotaIvaId: general, recepcionIds: [o.recepcionId],
    }));
    await como(comprador, (tx) => registrarGasto(tx, comprador, id));       // IVA 160 → 120; ISLR 5 % de 1.000 = 50
    expect((await retencionesDe(db, { gastoId: id })).map((r) => [r.impuesto, r.monto])).toEqual([['islr', '50.00'], ['iva', '120.00']]);
    expect((await asiento('gasto_importacion', id)).filter((l) => Number(l.haber) > 0).map((l) => [l.codigo, l.haber])).toEqual([
      ['2.1.01', '990.00'], ['2.1.04', '120.00'], ['2.1.05', '50.00'],
    ]);
    expect((await saldo('gasto_id', id)).saldo).toBe('990.00');            // 1.160 − 170
  });

  it('cuadre: las cuentas por pagar abiertas y las retenciones por enterar coinciden con el mayor, y el mayor cuadra', async () => {
    const mayor = async (codigo: string) =>
      (await db.query<{ usd: string }>(
        `select coalesce(sum(l.haber_usd - l.debe_usd), 0)::text as usd from asiento_linea l join asiento a on a.id = l.asiento_id
           join cuenta_contable c on c.id = l.cuenta_id where c.codigo = $1 and a.estado = 'contabilizado'`, [codigo])).rows[0].usd;
    const cxp = (await db.query<{ usd: string }>(
      `select coalesce(sum(round(monto_usd * saldo / monto_original, 2)), 0)::text as usd from partida_cxp where estado = 'abierta'`)).rows[0].usd;
    expect(Number(await mayor('2.1.01'))).toBe(Number(cxp));
    for (const [cuenta, impuesto] of [['2.1.04', 'iva'], ['2.1.05', 'islr']] as const) {
      const ret = (await db.query<{ usd: string }>('select coalesce(sum(monto_usd), 0)::text as usd from retencion_compra where impuesto = $1', [impuesto])).rows[0].usd;
      expect(Number(await mayor(cuenta))).toBe(Number(ret));
    }
    const c = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
    expect([Number(c.ves), Number(c.usd)]).toEqual([0, 0]);
  });

  it('una retención practicada no se edita ni se borra', async () => {
    await esperarError(db.query('update retencion_compra set monto = 1'), 'no se modifica ni se borra');
    await esperarError(db.query('delete from retencion_compra'), 'no se modifica ni se borra');
  });

  it('las tarifas de ISLR no se editan ni se borran, y su vigencia no se solapa', async () => {
    await esperarError(db.query(`update concepto_islr_tarifa set porcentaje = 9`), 'no se edita');
    await esperarError(db.query('delete from concepto_islr_tarifa'), 'no se borra');
    await esperarError(db.query(
      `insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, vigente_desde)
       select id, 'J', true, 3, '2026-06-01' from concepto_islr where codigo = 'SERV'`), 'se solapa');
    // Cerrar la vigencia sí se permite, y entonces la nueva tarifa rige desde su fecha.
    await db.query(`update concepto_islr_tarifa set vigente_hasta = '2026-05-31' where concepto_id = (select id from concepto_islr where codigo = 'SERV')`);
    await db.query(`insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, vigente_desde)
                    select id, 'J', true, 3, '2026-06-01' from concepto_islr where codigo = 'SERV'`);
    const id = await facturar(prov.serv, '100', '4.0000');
    await registrar(id);
    const islr = (await retencionesDe(db, { facturaId: id })).find((r) => r.impuesto === 'islr')!;
    expect([islr.porcentaje, islr.monto]).toEqual(['3.0000', '12.00']);    // 3 % de 400
  });
});
