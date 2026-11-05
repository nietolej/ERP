import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aprobarAsiento, guardarBorrador, huellaAsiento, type LineaManual } from '@/lib/contabilidad/manual';
import {
  construirCambiosPatrimonio, construirResultados, construirSituacion, estadosDelMes, rangoDeMes, saldosAl, type FilaCuenta, type Par,
} from '@/lib/contabilidad/estados';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

const par = (ves: number | string, usd: number | string = Number(ves) / 40): Par => ({ ves: new Decimal(ves), usd: new Decimal(usd) });
const fila = (codigo: string, tipo: FilaCuenta['tipo'], neto: number, nombre = codigo): FilaCuenta => ({ codigo, nombre, tipo, neto: par(neto) });
const v = (p: Par) => p.ves.toFixed(2);

describe('estados financieros: agrupación pura', () => {
  it('el balance agrupa corriente y no corriente, trae el resultado abierto al patrimonio y cuadra', () => {
    const s = construirSituacion([
      fila('1.1.01.01', 'activo', 108200), fila('1.4.01', 'activo', 12000), fila('1.4.02', 'activo', -100),            // activo (debe − haber)
      fila('2.1.09', 'pasivo', -1500),                                                                                   // pasivo (haber → negativo)
      fila('3.1.01', 'patrimonio', -100000),
      fila('4.1.01', 'ingreso', -50000), fila('5.1.01', 'costo', 20000), fila('6.2.02', 'gasto', 11400),               // resultado: 50.000 − 20.000 − 11.400 = 18.600
      fila('1.2.03', 'activo', 0),                                                                                       // saldo cero: no aparece
    ]);
    expect(s.activoCorriente.lineas.map((l) => l.codigo)).toEqual(['1.1.01.01']);
    expect(s.activoNoCorriente.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['1.4.01', '12000.00'], ['1.4.02', '-100.00']]);
    expect(v(s.totalActivo)).toBe('120100.00');
    expect(v(s.totalPasivo)).toBe('1500.00');
    expect(v(s.resultadoEjercicio)).toBe('18600.00');
    expect(v(s.totalPatrimonio)).toBe('118600.00');
    expect(s.cuadra).toBe(true);
    expect(s.totalActivo.usd.toFixed(2)).toBe('3002.50');
  });

  it('un balance que no cuadra se señala con su diferencia', () => {
    const s = construirSituacion([fila('1.1.01.01', 'activo', 100), fila('3.1.01', 'patrimonio', -90)]);
    expect(s.cuadra).toBe(false);
    expect(v(s.diferencia)).toBe('10.00');
  });

  it('el estado de resultados sigue la estructura de §12.5 y no pierde ninguna cuenta, ni las fuera de la estructura base', () => {
    const filas = [
      fila('4.1.01', 'ingreso', -50000), fila('4.1.02', 'ingreso', 2000), fila('4.1.03', 'ingreso', 1000), fila('4.1.09', 'ingreso', -500),   // 4.1.09: cuenta nueva de ventas
      fila('4.2.01', 'ingreso', -800), fila('4.2.02', 'ingreso', -200),
      fila('5.1.01', 'costo', 20000), fila('5.1.02', 'costo', 50),
      fila('6.1.01', 'gasto', 3000), fila('6.2.02', 'gasto', 4000), fila('6.2.01', 'gasto', 100), fila('6.3.01', 'gasto', 500), fila('6.3.02', 'gasto', 300),
      fila('6.3.03', 'gasto', 5), fila('6.4.01', 'gasto', 1500), fila('6.9.01', 'gasto', 70),                                              // 6.9.01: gasto fuera de la estructura
    ];
    const r = construirResultados(filas);
    expect(v(r.ventasBrutas.total)).toBe('50500.00');
    expect(v(r.devoluciones.total)).toBe('2000.00');
    expect(v(r.descuentos.total)).toBe('1000.00');
    expect(v(r.ventasNetas)).toBe('47500.00');
    expect(v(r.costoVentas.total)).toBe('20050.00');
    expect(v(r.utilidadBruta)).toBe('27450.00');
    expect(r.margenBrutoPct).toBe('57.79');
    expect(v(r.gastosVenta.total)).toBe('3000.00');
    expect(v(r.gastosAdministracion.total)).toBe('4100.00');
    expect(v(r.otrosGastos.total)).toBe('70.00');
    expect(v(r.utilidadOperativa)).toBe('20280.00');
    expect(v(r.diferencialCambiario.total)).toBe('500.00');
    expect(v(r.gastosFinancieros.total)).toBe('505.00');
    expect(v(r.otrosIngresos.total)).toBe('200.00');
    expect(v(r.utilidadAntesIslr)).toBe('20475.00');
    expect(v(r.utilidadNeta)).toBe('18975.00');
    // Todas las cuentas de resultados están en el estado: la utilidad neta es exactamente ingresos − costos − gastos.
    const directa = filas.reduce((s, f) => s.minus(f.neto.ves), new Decimal(0));
    expect(r.utilidadNeta.ves.toFixed(2)).toBe(directa.toFixed(2));
  });

  it('sin ventas no hay margen y todo sale en cero', () => {
    const r = construirResultados([]);
    expect(r.margenBrutoPct).toBeNull();
    expect(v(r.utilidadNeta)).toBe('0.00');
  });

  it('los cambios en el patrimonio concilian saldo inicial + resultado + movimientos = saldo final', () => {
    const inicio = [fila('3.1.01', 'patrimonio', -100000), fila('4.1.01', 'ingreso', -1000)];
    const fin = [fila('3.1.01', 'patrimonio', -110000), fila('3.2.01', 'patrimonio', -500), fila('4.1.01', 'ingreso', -4000)];
    const c = construirCambiosPatrimonio(inicio, fin, par(3000));
    const [ini, res, mov, cierre] = c.filas;
    expect(v(ini.total)).toBe('101000.00');
    expect(v(res.total)).toBe('3000.00');
    expect(v(mov.total)).toBe('10500.00');                       // aporte de 10.000 y reserva de 500
    expect(v(cierre.total)).toBe('114500.00');
    expect(ini.total.ves.plus(res.total.ves).plus(mov.total.ves).toFixed(2)).toBe(cierre.total.ves.toFixed(2));
    expect(v(mov.valores.capital)).toBe('10000.00');
  });

  it('el rango de un mes cubre sus días y el mes anterior cruza el año', () => {
    expect(rangoDeMes(2024, 2)).toMatchObject({ desde: '2024-02-01', hasta: '2024-02-29', anterior: { anio: 2024, mes: 1 } });
    expect(rangoDeMes(2026, 1).anterior).toEqual({ anio: 2025, mes: 12 });
    expect(() => rangoDeMes(2026, 13)).toThrow('mes y un año válidos');
  });
});

describe('estados financieros desde el mayor', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador = '';
  let jefe = '';
  let p = { anio: 0, mes: 0, dia: '' };       // el mes pasado
  let q = { anio: 0, mes: 0, dia: '' };       // el mes anterior al pasado

  const asiento = async (fecha: string, lineas: [string, string, string][]) => {
    const ls: LineaManual[] = [];
    for (const [codigo, debe, haber] of lineas) ls.push({ cuentaId: await cuenta(db, codigo), debe, haber });
    const id = await db.transaction(async (tx) => { await tx.query("select set_config('app.usuario_id', $1, true)", [contador]); return guardarBorrador(tx, contador, { fecha, descripcion: 'Asiento de prueba', moneda: 'VES', lineas: ls }); });
    await db.transaction(async (tx) => { await tx.query("select set_config('app.usuario_id', $1, true)", [jefe]); return aprobarAsiento(tx, id, jefe, await huellaAsiento(tx, id)); });
  };

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    contador = await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']);
    jefe = await usuarioDePrueba(db, 'jefe@prueba.test', ['jefe_contabilidad']);
    const f = (await db.query<{ a1: number; m1: number; d1: string; a2: number; m2: number; d2: string; hoy: string }>(
      `with h as (select date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as m)
       select extract(year from m - interval '2 month')::int as a1, extract(month from m - interval '2 month')::int as m1, (m - interval '2 month' + interval '14 days')::date::text as d1,
              extract(year from m - interval '1 month')::int as a2, extract(month from m - interval '1 month')::int as m2, (m - interval '1 month' + interval '14 days')::date::text as d2,
              (now() at time zone 'America/Caracas')::date::text as hoy from h`)).rows[0];
    q = { anio: f.a1, mes: f.m1, dia: f.d1 };
    p = { anio: f.a2, mes: f.m2, dia: f.d2 };
    for (const a of new Set([q.anio, p.anio])) await db.query('select fn_crear_periodos($1)', [a]);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series($1::date - 70, $1::date, interval '1 day') d`, [f.hoy]);

    // Dos meses atrás: aporte de capital y compra de un equipo.
    await asiento(q.dia, [['1.1.01.01', '100000', ''], ['3.1.01', '', '100000']]);
    await asiento(q.dia, [['1.4.01', '12000', ''], ['1.1.01.01', '', '12000']]);
    // El mes pasado: ventas, devolución, descuento, costo, gastos, diferencial, otros ingresos, ISLR y depreciación.
    await asiento(p.dia, [['1.1.01.01', '50000', ''], ['4.1.01', '', '50000']]);
    await asiento(p.dia, [['4.1.02', '2000', ''], ['1.1.01.01', '', '2000']]);
    await asiento(p.dia, [['4.1.03', '1000', ''], ['1.1.01.01', '', '1000']]);
    await asiento(p.dia, [['5.1.01', '20000', ''], ['1.1.01.01', '', '20000']]);
    await asiento(p.dia, [['6.1.01', '3000', ''], ['6.2.02', '4000', ''], ['6.3.01', '500', ''], ['1.1.01.01', '', '7500']]);
    await asiento(p.dia, [['1.1.01.01', '800', ''], ['4.2.01', '', '800']]);
    await asiento(p.dia, [['6.3.02', '300', ''], ['1.1.01.01', '', '300']]);
    await asiento(p.dia, [['1.1.01.01', '200', ''], ['4.2.02', '', '200']]);
    await asiento(p.dia, [['6.4.01', '1500', ''], ['2.1.09', '', '1500']]);
    await asiento(p.dia, [['6.2.01', '100', ''], ['1.4.02', '', '100']]);
  });
  afterAll(() => cerrar());

  it('el estado de resultados del mes pasado, en bolívares y en dólares', async () => {
    const e = await estadosDelMes(db, p.anio, p.mes);
    const r = e.resultados.periodo;
    expect([v(r.ventasBrutas.total), v(r.devoluciones.total), v(r.descuentos.total), v(r.ventasNetas)]).toEqual(['50000.00', '2000.00', '1000.00', '47000.00']);
    expect([v(r.costoVentas.total), v(r.utilidadBruta), r.margenBrutoPct]).toEqual(['20000.00', '27000.00', '57.45']);
    expect([v(r.gastosVenta.total), v(r.gastosAdministracion.total), v(r.utilidadOperativa)]).toEqual(['3000.00', '4100.00', '19900.00']);
    expect([v(r.diferencialCambiario.total), v(r.gastosFinancieros.total), v(r.otrosIngresos.total), v(r.utilidadAntesIslr)]).toEqual(['500.00', '500.00', '200.00', '20100.00']);
    expect([v(r.islr.total), v(r.utilidadNeta)]).toEqual(['1500.00', '18600.00']);
    expect(r.utilidadNeta.usd.toFixed(2)).toBe('465.00');                 // 18.600 / 40
    expect(r.ventasNetas.usd.toFixed(2)).toBe('1175.00');
  });

  it('comparativos del estado de resultados: el mes anterior (sin movimientos) y el acumulado del año', async () => {
    const e = await estadosDelMes(db, p.anio, p.mes);
    expect(v(e.resultados.mesAnterior.utilidadNeta)).toBe('0.00');
    if (q.anio === p.anio) expect(v(e.resultados.acumuladoAnio.utilidadNeta)).toBe('18600.00');
  });

  it('el estado de situación al cierre del mes pasado cuadra y compara con el mes anterior', async () => {
    const e = await estadosDelMes(db, p.anio, p.mes);
    const s = e.situacion.actual;
    expect(s.activoCorriente.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['1.1.01.01', '108200.00']]);
    expect(s.activoNoCorriente.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['1.4.01', '12000.00'], ['1.4.02', '-100.00']]);
    expect(v(s.totalActivo)).toBe('120100.00');
    expect([v(s.totalPasivo), v(s.resultadoEjercicio), v(s.totalPatrimonio)]).toEqual(['1500.00', '18600.00', '118600.00']);
    expect(s.cuadra).toBe(true);
    expect(s.totalActivo.usd.toFixed(2)).toBe('3002.50');
    expect(s.diferencia.usd.toFixed(2)).toBe('0.00');
    const a = e.situacion.mesAnterior;
    expect([v(a.totalActivo), v(a.totalPatrimonio), a.cuadra]).toEqual(['100000.00', '100000.00', true]);
    expect(v(e.situacion.cierreAnioAnterior.totalActivo)).toBe(q.anio < p.anio || p.mes === 12 ? '100000.00' : '0.00');
  });

  it('el estado de cambios en el patrimonio concilia con el balance', async () => {
    const e = await estadosDelMes(db, p.anio, p.mes);
    const [ini, res, mov, fin] = e.patrimonio.filas;
    expect([v(ini.total), v(res.total), v(mov.total), v(fin.total)]).toEqual(['100000.00', '18600.00', '0.00', '118600.00']);
    expect(v(fin.total)).toBe(v(e.situacion.actual.totalPatrimonio));
    expect(v(ini.valores.capital)).toBe('100000.00');
    expect(v(fin.valores.ejercicio)).toBe('18600.00');
  });

  it('los asientos de cierre del ejercicio no cuentan como resultado del periodo, y el resultado pasa al patrimonio sin descuadrar', async () => {
    // Un asiento de cierre ya contabilizado (se inserta sin disparadores: el cierre real lo hace el cierre mensual): ingresos y gastos contra 3.3.02.
    const [ing, g, acum] = [
      [['4.1.01', 50000, 0], ['4.2.01', 800, 0], ['4.2.02', 200, 0]],
      [['4.1.02', 0, 2000], ['4.1.03', 0, 1000], ['5.1.01', 0, 20000], ['6.1.01', 0, 3000], ['6.2.02', 0, 4000], ['6.3.01', 0, 500], ['6.3.02', 0, 300], ['6.4.01', 0, 1500], ['6.2.01', 0, 100]],
      [['3.3.02', 0, 18600]],
    ] as [string, number, number][][];
    await db.query('set session_replication_role = replica');
    const a = (await db.query<{ id: string }>(
      `insert into asiento (fecha, tipo, descripcion, created_by, estado, numero, contabilizado_at, periodo_id)
       values ($1::date, 'cierre', 'Cierre de prueba', $2, 'contabilizado', 999999, now(), (fn_periodo_de($1::date, 'manual')).id) returning id`, [p.dia, contador])).rows[0].id;
    for (const [codigo, debe, haber] of [...ing, ...g, ...acum]) {
      await db.query(
        `insert into asiento_linea (asiento_id, cuenta_id, debe_ves, haber_ves, debe_usd, haber_usd, moneda_original, monto_original, tasa) values ($1, $2, $3, $4, $3 / 40.0, $4 / 40.0, 'VES', $3 + $4, 1)`, [a, await cuenta(db, codigo), debe, haber]);
    }
    await db.query('set session_replication_role = origin');
    const e = await estadosDelMes(db, p.anio, p.mes);
    expect(v(e.resultados.periodo.utilidadNeta)).toBe('18600.00');                 // el cierre no mueve el resultado del periodo
    const s = e.situacion.actual;
    expect(v(s.resultadoEjercicio)).toBe('0.00');                                  // ya no hay resultado abierto…
    expect(s.patrimonio.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['3.1.01', '100000.00'], ['3.3.02', '18600.00']]);   // …está en el patrimonio
    expect([v(s.totalPatrimonio), s.cuadra]).toEqual(['118600.00', true]);
    const [ini, res, mov, fin] = e.patrimonio.filas;
    expect([v(ini.total), v(res.total), v(mov.total), v(fin.total)]).toEqual(['100000.00', '18600.00', '0.00', '118600.00']);
    expect(v(mov.valores.acumuladas)).toBe('18600.00');
    expect(v(mov.valores.ejercicio)).toBe('-18600.00');
  });

  it('un corte sin movimientos devuelve un balance vacío que cuadra, y una fecha inválida se rechaza', async () => {
    const vacio = await saldosAl(db, '2000-01-01');
    expect(vacio).toEqual([]);
    expect(construirSituacion(vacio).cuadra).toBe(true);
    await esperarError(saldosAl(db, 'ayer'), 'fecha válida');
  });
});
