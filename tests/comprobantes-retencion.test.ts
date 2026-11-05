import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import { crearFactura, guardarLinea, registrarFactura } from '@/lib/compras/facturas';
import { crearNota } from '@/lib/compras/notas-proveedor';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea as lineaOrden, type Usuario } from '@/lib/compras/ordenes';
import { recibirMercancia } from '@/lib/compras/recepciones';
import type { Db } from '@/lib/db/tipos';
import {
  ajustesPorEmitir, detalleComprobante, emitirPeriodo, listarComprobantes, pendientes, plazoComprobante, resumenComprobantes,
} from '@/lib/fiscal/comprobantes';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { crearGastoProveedor } from '@/lib/gastos/gastos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Comprobantes de retención de IVA e ISLR (spec §11.2; migración 0045). Empresa agente de retención de IVA y de ISLR. Tasa: USD a Bs 40.
 */
describe('comprobantes de retención (R-CX a R-CZ)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let contador: Usuario;
  let gerente: Usuario;
  let almacenista: Usuario;
  let proveedorIva = '';
  let proveedorIslr = '';
  let general = '';
  let alquiler = '';
  let hoy = '';
  let anio = 0;
  let mes = 0;
  let n = 0;
  let almacenArchivos: ReturnType<typeof almacenEnDisco>;

  const como = <T,>(u: { id: string }, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const soporte = () => ({ almacen: almacenArchivos, nombre: `s${++n}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% ${n}\n`) });
  /** Factura de gasto aprobada (retiene IVA y, si el proveedor tiene concepto, ISLR). */
  const gasto = async (proveedorId: string, base: string, fecha = hoy) => {
    const g = await como(comprador, (tx) => crearGastoProveedor(tx, comprador, {
      proveedorId, categoriaId: alquiler, descripcion: 'Gasto de prueba', numeroFactura: `CR-${++n}`, numeroControl: `00-${n}`, fechaFactura: fecha, moneda: 'VES', base, alicuotaIvaId: general,
    }, soporte()));
    await como(gerente, (tx) => resolverAprobacion(tx, 'gasto_proveedor', g.id, gerente.id, 'aprobada'));
    return g.id;
  };
  const proveedor = async (n8: string, concepto: string | null) => {
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const conceptoId = concepto ? (await db.query<{ id: string }>('select id from concepto_islr where codigo = $1', [concepto])).rows[0].id : null;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: `Proveedor ${n8}`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'servicios', pais: 'VE', conceptoIslrId: conceptoId },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    return r.id;
  };

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    almacenArchivos = almacenEnDisco(await mkdtemp(path.join(tmpdir(), 'comprobantes-')));
    const ids = {
      com: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']),
      con: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']),
      ger: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']),
      alm: await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']),
    };
    comprador = { id: ids.com, roles: ['compras'] };
    contador = { id: ids.con, roles: ['contabilidad'] };
    gerente = { id: ids.ger, roles: ['gerencia'] };
    almacenista = { id: ids.alm, roles: ['almacen'] };
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const f = (await db.query<{ hoy: string; a: number; m: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as hoy, extract(year from (now() at time zone 'America/Caracas'))::int as a, extract(month from (now() at time zone 'America/Caracas'))::int as m`)).rows[0];
    hoy = f.hoy; anio = f.a; mes = f.m;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series($1::date - 40, $1::date, interval '1 day') d`, [hoy]);
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_retencion_iva, agente_retencion_islr) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', true, true)`);
    await db.query(`insert into concepto_islr (codigo, descripcion) values ('SERV', 'Servicios')`);
    await db.query(
      `insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, base_minima_ut, sustraendo_ut, vigente_desde)
       select id, 'J', true, 5, 0, 0, '2026-01-01' from concepto_islr where codigo = 'SERV'`);
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    alquiler = (await db.query<{ id: string }>(`select id from categoria_gasto where codigo = 'ALQUILER'`)).rows[0].id;
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    const a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, a01, [ids.alm]));
    proveedorIva = await proveedor('77770001', null);
    proveedorIslr = await proveedor('77770002', 'SERV');

    // Dos gastos solo con retención de IVA, uno con IVA e ISLR; y una factura de mercancía con nota de crédito (ajuste por emitir).
    await gasto(proveedorIva, '1000.00');                      // IVA 160 → retiene 120
    await gasto(proveedorIslr, '500.00');                      // IVA 80 → retiene 60; ISLR 5 % de 500 = 25
    await gasto(proveedorIva, '200.00');                       // IVA 32 → retiene 24
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-CR1', { descripcion: 'Artículo CR1' }));
    const prod = await db.transaction((tx) => crearProducto(tx, ids.alm, 'CR-001', {
      descripcion: 'Producto CR-001', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
    const orden = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: proveedorIva, almacenId: a01, moneda: 'USD' }));
    await como(comprador, (tx) => lineaOrden(tx, orden, { productoId: prod, cantidad: '100', precio: '4.0000' }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, orden));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', orden, gerente.id, 'aprobada'));
    const [lo] = (await detalleOrden(db, orden))!.lineas;
    await como(almacenista, (tx) => recibirMercancia(tx, almacenista, orden, [{ lineaId: lo.id, cantidad: '100' }]));
    const fid = await como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: orden, numeroFactura: 'FC-CR', numeroControl: '00-CR', fechaFactura: hoy }));
    await como(comprador, (tx) => guardarLinea(tx, fid, { ordenLineaId: lo.id, cantidad: '100', precio: '4.0000' }));
    await como(comprador, (tx) => registrarFactura(tx, comprador, fid));                     // IVA US$ 64 → retiene 48 US$ (Bs 1.920)
    const fl = (await db.query<{ id: string }>('select id from factura_compra_linea where factura_id = $1', [fid])).rows[0].id;
    const nota = await como(comprador, (tx) => crearNota(tx, comprador, {
      facturaId: fid, tipo: 'nota_credito', clase: 'ajuste_precio', numeroDocumento: 'NC-CR', numeroControl: '00-NCR', fecha: hoy, motivo: 'Descuento', lineas: [{ facturaLineaId: fl, monto: '40.00' }],
    }));
    await como(gerente, (tx) => resolverAprobacion(tx, 'nota_proveedor', nota.id, gerente.id, 'aprobada'));
  });
  afterAll(() => cerrar());

  it('el plazo es el segundo día hábil del mes siguiente', () => {
    expect(plazoComprobante(2026, 10)).toBe('2026-11-03');      // 1 de noviembre es domingo: lunes 2 y martes 3
    expect(plazoComprobante(2026, 4)).toBe('2026-05-04');       // 1 de mayo es viernes: viernes 1 y lunes 4
    expect(plazoComprobante(2026, 12)).toBe('2027-01-04');
  });

  it('lista las retenciones del mes sin comprobante y aparta las que revierte una nota de crédito', async () => {
    const p = await pendientes(db, anio, mes);
    expect(p.filter((x) => x.impuesto === 'iva')).toHaveLength(4);        // tres gastos y la factura de mercancía
    expect(p.filter((x) => x.impuesto === 'islr')).toHaveLength(1);
    expect(p.every((x) => x.rif && x.documento)).toBe(true);
    const a = await ajustesPorEmitir(db, anio, mes);
    expect(a.map((x) => [x.impuesto, x.documento, x.monto])).toEqual([['iva', 'NC-CR', '-4.80']]);
  });

  it('solo Contabilidad o Gerencia emiten, y el lote del mes numera con AAAAMM + 8 dígitos correlativos por impuesto', async () => {
    await esperarError(como(comprador, (tx) => emitirPeriodo(tx, comprador, anio, mes)), 'Solo Contabilidad o Gerencia');
    const r = await como(contador, (tx) => emitirPeriodo(tx, contador, anio, mes));
    expect(r).toEqual({ emitidos: 5, porImpuesto: { iva: 4, islr: 1 } });
    const prefijo = `${anio}${String(mes).padStart(2, '0')}`;
    const lista = await listarComprobantes(db, anio, mes);
    const iva = lista.filter((c) => c.impuesto === 'iva').map((c) => c.numero);
    const islr = lista.filter((c) => c.impuesto === 'islr').map((c) => c.numero);
    expect(iva).toEqual([1, 2, 3, 4].map((i) => `${prefijo}${String(i).padStart(8, '0')}`));
    expect(islr).toEqual([`${prefijo}00000001`]);
    expect(lista.every((c) => c.numero.length === 14)).toBe(true);
    expect(await pendientes(db, anio, mes)).toEqual([]);
  });

  it('no se emite dos veces la misma retención y un comprobante no se modifica ni se borra', async () => {
    await esperarError(como(contador, (tx) => emitirPeriodo(tx, contador, anio, mes)), 'No hay retenciones pendientes');
    const c = (await listarComprobantes(db, anio, mes))[0];
    await esperarError(db.query(`update comprobante_retencion set numero = '20260100000099' where id = $1`, [c.id]), 'no se modifica ni se borra');
    await esperarError(db.query('delete from comprobante_retencion where id = $1', [c.id]), 'no se modifica ni se borra');
    const r = (await db.query<{ id: string }>('select retencion_id as id from comprobante_retencion where id = $1', [c.id])).rows[0].id;
    await esperarError(como(contador, (tx) => tx.query(`insert into comprobante_retencion (retencion_id, impuesto, periodo, numero, proveedor_id, fecha_emision, emitido_por)
      select id, impuesto, '000000', '00000000000000', proveedor_id, current_date, $2 from retencion_compra where id = $1`, [r, contador.id])), 'duplicate');
  });

  it('la retención que revierte una nota de crédito no se numera', async () => {
    const r = (await db.query<{ id: string }>('select id from retencion_compra where nota_id is not null limit 1')).rows[0].id;
    await esperarError(como(contador, (tx) => tx.query(`insert into comprobante_retencion (retencion_id, impuesto, periodo, numero, proveedor_id, fecha_emision, emitido_por)
      select id, impuesto, '000000', '00000000000000', proveedor_id, current_date, $2 from retencion_compra where id = $1`, [r, contador.id])), 'ajustes por emitir');
  });

  it('un lote que falla no consume números: el siguiente continúa sin huecos', async () => {
    await gasto(proveedorIva, '100.00');                                     // retiene 12
    await expect(db.transaction(async (tx) => {
      await tx.query("select set_config('app.usuario_id', $1, true)", [contador.id]);
      await emitirPeriodo(tx, contador, anio, mes);
      throw new Error('falla después de numerar');
    })).rejects.toThrow('falla después');
    await como(contador, (tx) => emitirPeriodo(tx, contador, anio, mes));
    const iva = (await listarComprobantes(db, anio, mes, 'iva')).map((c) => Number(c.numero.slice(6)));
    expect(iva).toEqual([1, 2, 3, 4, 5]);
  });

  it('el comprobante trae al agente, al sujeto retenido, el documento y el cálculo', async () => {
    const lista = await listarComprobantes(db, anio, mes);
    const islr = (await detalleComprobante(db, lista.find((c) => c.impuesto === 'islr')!.id))!;
    expect([islr.agente_rif, islr.agente_razon, islr.base, islr.porcentaje, islr.monto, islr.concepto, islr.emitido_por]).toEqual(
      ['J-12345678-4', 'Distribuciones Hanei Motors, C.A.', '500.00', '5.0000', '25.00', 'SERV · Servicios', 'Usuario de prueba']);
    expect(islr.numero_control).toMatch(/^00-/);
    const iva = (await detalleComprobante(db, lista.find((c) => c.impuesto === 'iva')!.id))!;
    expect([iva.base, iva.porcentaje, iva.monto, iva.iva_documento]).toEqual(['160.00', '75.0000', '120.00', '160.00']);
  });

  it('el resumen junta pendientes, emitidos, ajustes y plazo', async () => {
    const r = await resumenComprobantes(db, anio, mes);
    expect(r.emitidos).toHaveLength(6);
    expect(r.pendientes).toEqual([]);
    expect(r.ajustes).toHaveLength(1);
    expect(r.plazo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
