import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asignarFolios, libroDiario, libroMayor, type AsientoDiario } from '@/lib/contabilidad/libros';
import { aprobarAsiento, guardarBorrador, huellaAsiento, type LineaManual } from '@/lib/contabilidad/manual';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

const asientoSint = (n: number, lineas: number, monto = 10): AsientoDiario => ({
  id: `a${n}`, numero: String(n), fecha: '2026-01-01', tipo: 'manual', descripcion: `Asiento ${n}`,
  lineas: Array.from({ length: lineas }, (_, i) => ({ codigo: '1.1.01.01', cuenta: 'Caja', glosa: null, debe: new Decimal(i === 0 ? monto : 0), haber: new Decimal(i === 0 ? 0 : monto / (lineas - 1)) })),
  debe: new Decimal(monto), haber: new Decimal(monto),
});

describe('libro diario: reparto en folios', () => {
  it('un asiento no se parte entre folios y cada folio trae su total y el acumulado', () => {
    // Cada asiento de 3 líneas ocupa 4 renglones: en un folio de 10 caben 2.
    const f = asignarFolios([1, 2, 3, 4, 5].map((n) => asientoSint(n, 3, n * 10)), 10, 7);
    expect(f.map((x) => [x.folio, x.asientos.map((a) => a.numero)])).toEqual([[7, ['1', '2']], [8, ['3', '4']], [9, ['5']]]);
    expect(f.map((x) => x.debe.toFixed(2))).toEqual(['30.00', '70.00', '50.00']);
    expect(f.map((x) => x.debeAcumulado.toFixed(2))).toEqual(['30.00', '100.00', '150.00']);
    expect(f[2].haberAcumulado.toFixed(2)).toBe('150.00');
  });

  it('un asiento más largo que un folio ocupa uno solo, y sin asientos no hay folios', () => {
    const f = asignarFolios([asientoSint(1, 2), asientoSint(2, 12), asientoSint(3, 2)], 5);
    expect(f.map((x) => x.asientos.map((a) => a.numero))).toEqual([['1'], ['2'], ['3']]);
    expect(asignarFolios([])).toEqual([]);
  });

  it('rechaza líneas por folio o folio inicial fuera de rango', () => {
    expect(() => asignarFolios([], 2)).toThrow('entre 5 y 200');
    expect(() => asignarFolios([], 40, 0)).toThrow('folio inicial');
  });
});

describe('libro diario y libro mayor desde el mayor', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador = '';
  let jefe = '';
  const A = '2026-03';

  const asiento = async (fecha: string, lineas: [string, string, string][], aprobar = true) => {
    const ls: LineaManual[] = [];
    for (const [codigo, debe, haber] of lineas) ls.push({ cuentaId: await cuenta(db, codigo), debe, haber });
    const id = await db.transaction(async (tx) => { await tx.query("select set_config('app.usuario_id', $1, true)", [contador]); return guardarBorrador(tx, contador, { fecha, descripcion: `Asiento del ${fecha}`, moneda: 'VES', lineas: ls }); });
    if (aprobar) await db.transaction(async (tx) => { await tx.query("select set_config('app.usuario_id', $1, true)", [jefe]); return aprobarAsiento(tx, id, jefe, await huellaAsiento(tx, id)); });
    return id;
  };

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    contador = await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']);
    jefe = await usuarioDePrueba(db, 'jefe@prueba.test', ['jefe_contabilidad']);
    await db.query('select fn_crear_periodos(2026)');
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series('2026-01-01'::date, '2026-04-30'::date, interval '1 day') d`);
    await asiento('2026-02-10', [['1.1.01.01', '1000', ''], ['3.1.01', '', '1000']]);              // antes del rango
    await asiento(`${A}-05`, [['1.1.01.01', '500', ''], ['4.1.01', '', '500']]);
    await asiento(`${A}-10`, [['5.1.01', '200', ''], ['1.1.01.01', '', '120'], ['1.1.01.02', '', '80']]);
    await asiento(`${A}-20`, [['1.1.01.02', '300', ''], ['4.1.01', '', '300']]);
    await asiento('2026-04-02', [['1.1.01.01', '40', ''], ['4.1.01', '', '40']]);                  // después del rango
    await asiento(`${A}-15`, [['1.1.01.01', '7', ''], ['4.1.01', '', '7']], false);               // borrador: no entra
  });
  afterAll(() => cerrar());

  it('el diario trae solo lo contabilizado del rango, en orden de número, con totales que cuadran', async () => {
    const d = await libroDiario(db, `${A}-01`, `${A}-31`);
    expect(d.asientos).toBe(3);
    const numeros = d.folios.flatMap((f) => f.asientos.map((a) => Number(a.numero)));
    expect(numeros).toEqual([...numeros].sort((x, y) => x - y));
    expect(numeros[1] - numeros[0]).toBe(1);                                                        // correlativos, sin huecos
    expect(d.folios).toHaveLength(1);
    expect([d.debe.toFixed(2), d.haber.toFixed(2), d.cuadra]).toEqual(['1000.00', '1000.00', true]);
    const tres = d.folios[0].asientos[1];
    expect(tres.lineas.map((l) => [l.codigo, l.debe.toFixed(2), l.haber.toFixed(2)])).toEqual([['5.1.01', '200.00', '0.00'], ['1.1.01.01', '0.00', '120.00'], ['1.1.01.02', '0.00', '80.00']]);
  });

  it('con pocas líneas por folio reparte los asientos y el folio inicial numera las hojas', async () => {
    const d = await libroDiario(db, `${A}-01`, `${A}-31`, { lineasPorFolio: 5, folioInicial: 31 });
    expect(d.folios.map((f) => f.folio)).toEqual([31, 32, 33]);
    expect(d.folios[2].debeAcumulado.toFixed(2)).toBe('1000.00');
  });

  it('un rango sin asientos da un libro vacío que cuadra, y un rango inválido se rechaza', async () => {
    const v = await libroDiario(db, '2026-01-01', '2026-01-31');
    expect([v.asientos, v.folios.length, v.cuadra]).toEqual([0, 0, true]);
    await esperarError(libroDiario(db, 'ayer', '2026-01-31'), 'rango de fechas válido');
    await esperarError(libroDiario(db, '2026-02-01', '2026-01-01'), 'no puede ser anterior');
  });

  it('el mayor de una cuenta deudora trae saldo inicial, saldo corrido y saldo final', async () => {
    const m = await libroMayor(db, '1.1.01.01', `${A}-01`, `${A}-31`);
    expect(m.saldoInicial.toFixed(2)).toBe('1000.00');
    expect(m.movimientos.map((x) => [x.debe.toFixed(2), x.haber.toFixed(2), x.saldo.toFixed(2)])).toEqual([['500.00', '0.00', '1500.00'], ['0.00', '120.00', '1380.00']]);
    expect([m.debe.toFixed(2), m.haber.toFixed(2), m.saldoFinal.toFixed(2)]).toEqual(['500.00', '120.00', '1380.00']);
  });

  it('en una cuenta acreedora el saldo crece con el haber', async () => {
    const m = await libroMayor(db, '4.1.01', `${A}-01`, `${A}-31`);
    expect(m.cuenta.naturaleza).toBe('A');
    expect([m.saldoInicial.toFixed(2), m.saldoFinal.toFixed(2)]).toEqual(['0.00', '800.00']);
    expect(m.movimientos.map((x) => x.saldo.toFixed(2))).toEqual(['500.00', '800.00']);
  });

  it('una cuenta padre suma sus subcuentas', async () => {
    const m = await libroMayor(db, '1.1.01', `${A}-01`, `${A}-31`);
    expect(m.subcuentas).toBe(2);
    expect([m.saldoInicial.toFixed(2), m.saldoFinal.toFixed(2)]).toEqual(['1000.00', '1600.00']);   // 1000 + 500 − 120 − 80 + 300
    expect(new Set(m.movimientos.map((x) => x.codigo))).toEqual(new Set(['1.1.01.01', '1.1.01.02']));
  });

  it('el saldo final del mayor coincide con el balance de comprobación de la cuenta', async () => {
    const m = await libroMayor(db, '1.1.01.01', '2026-01-01', '2026-12-31');
    const bal = (await db.query<{ s: string }>(`select saldo_ves::text as s from vw_balance_comprobacion where codigo = '1.1.01.01'`)).rows[0].s;
    expect(m.saldoFinal.toFixed(2)).toBe(Number(bal).toFixed(2));
  });

  it('rechaza una cuenta que no existe y un rango inválido', async () => {
    await esperarError(libroMayor(db, '9.9.99', `${A}-01`, `${A}-31`), 'Seleccione una cuenta');
    await esperarError(libroMayor(db, '1.1.01.01', `${A}-31`, `${A}-01`), 'no puede ser anterior');
  });
});
