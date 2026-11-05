import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/tipos';
import { estimarIgtfCobro, igtfDeCobro, reporteIgtf } from '@/lib/ventas/igtf';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { anularCobro, cuadreCxC, registrarCobro } from '@/lib/ventas/cobros';
import type { Usuario } from '@/lib/ventas/pedidos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * IGTF percibido (spec §11.3; migración 0046). Tasa: USD a Bs 40; IGTF al 3 %. La empresa es agente de percepción; se percibe aparte,
 * además del cobro, cuando el cobro es en divisas con un instrumento que genera IGTF.
 */
describe('IGTF percibido en los cobros (R-DA a R-DC)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let cobranzas: Usuario;
  let cliente = '';
  let usd = '';
  let ves = '';
  let zelle = '';
  let transferencia = '';
  let OTRO = '';
  let hoy = '';
  let anio = 0;
  let mes = 0;
  let n = 0;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const cobrar = (cuenta: string, instrumento: string, monto: string) =>
    como(cobranzas, (tx) => registrarCobro(tx, cobranzas, { clienteId: cliente, fecha: hoy, instrumentoId: instrumento, cuentaBancariaId: cuenta, monto, referencia: `R-${++n}`, aplicaciones: [] }));
  const lineas = async (origenTipo: string, id: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [origenTipo, id])).rows
    .map((l) => [l.codigo.startsWith('1.1.') ? 'BANCO' : l.codigo, l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd]);
  const igtfId = async (cobro: string) => (await db.query<{ id: string }>('select id from igtf_cobro where cobro_id = $1', [cobro])).rows[0].id;
  const agente = (si: boolean) => db.query('update empresa set agente_percepcion_igtf = $1', [si]);

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    const idTes = await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    cobranzas = { id: idCob, roles: ['cobranzas'] };
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const f = (await db.query<{ hoy: string; a: number; m: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as hoy, extract(year from (now() at time zone 'America/Caracas'))::int as a, extract(month from (now() at time zone 'America/Caracas'))::int as m`)).rows[0];
    hoy = f.hoy; anio = f.a; mes = f.m;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40)`, [hoy]);
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_percepcion_igtf) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', true)`);
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const c = await db.transaction((tx) => crearCliente(tx, idFac, {
      rif: 'J-00000010-7', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
    }));
    await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
    cliente = c.id;
    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    const tes: Usuario = { id: idTes, roles: ['tesoreria'] };
    usd = (await como(tes, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-0000-22' }))).id;
    ves = (await como(tes, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    const instrumentos = await listarInstrumentos(db);
    zelle = instrumentos.find((i) => i.codigo === 'ZELLE')!.id;
    transferencia = instrumentos.find((i) => i.codigo === 'TRANSFERENCIA')!.id;
  });
  afterAll(() => cerrar());

  it('un cobro en divisas con un instrumento que genera IGTF percibe el 3 % aparte, como pasivo por enterar', async () => {
    const e = await estimarIgtfCobro(db, { cuentaBancariaId: usd, instrumentoId: zelle, fecha: hoy, monto: '1000' });
    expect(e).toMatchObject({ aplica: true, porcentaje: '3', monto: '30.00', moneda: 'USD' });
    const r = await cobrar(usd, zelle, '500');
    expect(r.igtf).toBe('15.00');
    const ig = (await igtfDeCobro(db, r.id))!;
    expect([ig.monto, ig.porcentaje, ig.base, ig.moneda, ig.revertido]).toEqual(['15.00', '3.0000', '500.00', 'USD', false]);
    expect(await lineas('igtf_cobro', await igtfId(r.id))).toEqual([
      ['BANCO', '600.00', '0.00', '15.00', '0.00'],
      ['2.1.06', '0.00', '600.00', '0.00', '15.00'],
    ]);
    // El cobro conserva su asiento: entra el cobro completo como anticipo, sin el IGTF.
    expect(await lineas('cobro', r.id)).toEqual([
      ['BANCO', '20000.00', '0.00', '500.00', '0.00'],
      ['2.1.08', '0.00', '20000.00', '0.00', '500.00'],
    ]);
    expect((await cuadreCxC(db)).cuadra).toBe(true);
  });

  it('no se percibe en bolívares, con un instrumento que no lo genera ni si la empresa no es agente', async () => {
    expect((await estimarIgtfCobro(db, { cuentaBancariaId: ves, instrumentoId: zelle, fecha: hoy, monto: '1000' })).motivo).toContain('bolívares');
    expect((await estimarIgtfCobro(db, { cuentaBancariaId: usd, instrumentoId: transferencia, fecha: hoy, monto: '1000' })).motivo).toContain('instrumento');
    for (const [cuenta, instrumento, monto] of [[ves, zelle, '4000'], [usd, transferencia, '100']] as const) {
      const r = await cobrar(cuenta, instrumento, monto);
      expect(r.igtf).toBeNull();
      expect(await igtfDeCobro(db, r.id)).toBeNull();
    }
    await agente(false);
    try {
      expect((await estimarIgtfCobro(db, { cuentaBancariaId: usd, instrumentoId: zelle, fecha: hoy, monto: '1000' })).motivo).toContain('no es agente');
      const r = await cobrar(usd, zelle, '100');
      expect(r.igtf).toBeNull();
    } finally {
      await agente(true);
    }
  });

  it('el IGTF percibido queda inmutable', async () => {
    const r = await cobrar(usd, zelle, '200');
    await esperarError(db.query('update igtf_cobro set monto = 1 where cobro_id = $1', [r.id]), 'no se modifica');
    await esperarError(db.query('delete from igtf_cobro where cobro_id = $1', [r.id]), 'no se borra');
  });

  it('anular el cobro revierte también el IGTF y el mayor sigue cuadrado', async () => {
    const r = await cobrar(usd, zelle, '100');
    const porEnterar = async () => (await db.query<{ s: string }>(
      `select coalesce(sum(l.haber_usd - l.debe_usd), 0)::text as s from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
        join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '2.1.06'`)).rows[0].s;
    const antes = Number(await porEnterar());
    await como(cobranzas, (tx) => anularCobro(tx, cobranzas, r.id, { motivoId: OTRO, detalle: 'Cobro duplicado' }));
    expect((await igtfDeCobro(db, r.id))!.revertido).toBe(true);
    expect(antes - Number(await porEnterar())).toBe(3);
    const g = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
    expect([Number(g.ves), Number(g.usd)]).toEqual([0, 0]);
  });

  it('el reporte del mes muestra lo percibido (sin lo revertido), lo pagado y el saldo por enterar', async () => {
    const rep = await reporteIgtf(db, anio, mes);
    expect(rep.percibido.length).toBe(3);                                 // cobros de US$ 500, 200 y 100 (este último anulado)
    expect(rep.percibido.filter((x) => x.revertido)).toHaveLength(1);
    // 15 + 6 vigentes = US$ 21 = Bs 840 (el de US$ 3 anulado no suma)
    expect(rep.totalPercibidoVes).toBe('840.00');
    expect(rep.porEnterarVes).toBe('840.00');
    expect(rep.pagado).toEqual([]);
    expect((await reporteIgtf(db, anio === 2000 ? 2001 : anio - 1, 1)).percibido).toEqual([]);
  });
});
