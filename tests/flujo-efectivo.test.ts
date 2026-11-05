import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirFlujoEfectivo, flujoEfectivoDelMes, type FilaCuenta, type Par } from '@/lib/contabilidad/estados';
import { aprobarAsiento, guardarBorrador, huellaAsiento, type LineaManual } from '@/lib/contabilidad/manual';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, usuarioDePrueba } from './apoyo';

const par = (ves: number | string, usd: number | string = Number(ves) / 40): Par => ({ ves: new Decimal(ves), usd: new Decimal(usd) });
const fila = (codigo: string, tipo: FilaCuenta['tipo'], neto: number, nombre = codigo): FilaCuenta => ({ codigo, nombre, tipo, neto: par(neto) });
const v = (p: Par) => p.ves.toFixed(2);

describe('flujo de efectivo (método indirecto): construcción pura', () => {
  // Movimiento (debe − haber) del mes: ventas a crédito y de contado, inventario y proveedores, equipo, préstamo largo y aporte.
  const mov = [
    fila('1.1.02.01', 'activo', 3900),                         // efectivo
    fila('1.2.01', 'activo', 2000),                            // cuentas por cobrar: aumentan (restan efectivo)
    fila('1.3.01', 'activo', 900),                             // inventario: aumenta
    fila('1.4.01', 'activo', 700),                             // equipo comprado
    fila('1.4.02', 'activo', -50),                             // depreciación del mes
    fila('2.1.01', 'pasivo', -600),                            // proveedores: aumentan (suman efectivo)
    fila('2.2.01', 'pasivo', -3000),                           // préstamo a largo plazo
    fila('3.1.01', 'patrimonio', -1000),                       // aporte
    fila('4.1.01', 'ingreso', -3300),                          // ventas
    fila('6.2.01', 'gasto', 50),                               // depreciación
    fila('6.2.02', 'gasto', 400),                              // alquiler pagado
    fila('1.2.03', 'activo', 0),                               // sin movimiento: no aparece
  ];

  it('suma utilidad, partidas sin efectivo y capital de trabajo, inversión y financiamiento, y concilia con la variación del efectivo', () => {
    const f = construirFlujoEfectivo(mov, par(2850), par(1000), par(4900));        // utilidad: 3.300 − 50 − 400
    expect(v(f.depreciacion)).toBe('50.00');
    expect(f.capitalTrabajo.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['1.2.01', '-2000.00'], ['1.3.01', '-900.00'], ['2.1.01', '600.00']]);
    expect(v(f.efectivoOperacion)).toBe('600.00');                                // 2.850 + 50 − 2.000 − 900 + 600
    expect(f.inversion.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['1.4.01', '-700.00']]);
    expect(f.financiamiento.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['2.2.01', '3000.00'], ['', '1000.00']]);
    expect(f.financiamiento.lineas[1].nombre).toContain('Aportes');
    expect([v(f.variacion), v(f.efectivoInicial), v(f.efectivoFinal)]).toEqual(['3900.00', '1000.00', '4900.00']);
    expect(f.cuadra).toBe(true);
    expect(f.diferencia.usd.toFixed(2)).toBe('0.00');
  });

  it('si el efectivo del balance no coincide con lo que explica el flujo, la diferencia se muestra', () => {
    const f = construirFlujoEfectivo(mov, par(2850), par(1000), par(5600));
    expect(f.cuadra).toBe(false);
    expect(v(f.diferencia)).toBe('-700.00');
  });

  it('sin movimientos el flujo es cero y cuadra', () => {
    const f = construirFlujoEfectivo([], par(0), par(0), par(0));
    expect([v(f.variacion), f.cuadra, f.capitalTrabajo.lineas.length]).toEqual(['0.00', true, 0]);
  });
});

describe('flujo de efectivo desde el mayor', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador = '';
  let jefe = '';
  let p = { anio: 0, mes: 0, dia: '' };       // el mes pasado
  let q = { anio: 0, mes: 0, dia: '' };       // dos meses atrás

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
    // El mes pasado: ventas de contado, costo, gasto, ISLR por pagar y depreciación.
    await asiento(p.dia, [['1.1.01.01', '50000', ''], ['4.1.01', '', '50000']]);
    await asiento(p.dia, [['5.1.01', '20000', ''], ['1.1.01.01', '', '20000']]);
    await asiento(p.dia, [['6.2.02', '4000', ''], ['1.1.01.01', '', '4000']]);
    await asiento(p.dia, [['6.4.01', '1500', ''], ['2.1.09', '', '1500']]);
    await asiento(p.dia, [['6.2.01', '100', ''], ['1.4.02', '', '100']]);
  });
  afterAll(() => cerrar());

  it('dos meses atrás: el aporte es financiamiento, el equipo es inversión y el efectivo cuadra', async () => {
    const { periodo } = await flujoEfectivoDelMes(db, q.anio, q.mes);
    expect(v(periodo.utilidadNeta)).toBe('0.00');
    expect(periodo.financiamiento.lineas.map((l) => [l.nombre.slice(0, 7), v(l.valor)])).toEqual([['Aportes', '100000.00']]);
    expect(periodo.inversion.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['1.4.01', '-12000.00']]);
    expect([v(periodo.efectivoInicial), v(periodo.variacion), v(periodo.efectivoFinal)]).toEqual(['0.00', '88000.00', '88000.00']);
    expect(periodo.cuadra).toBe(true);
  });

  it('el mes pasado: utilidad, depreciación y capital de trabajo explican la variación del efectivo, en bolívares y en dólares', async () => {
    const { periodo } = await flujoEfectivoDelMes(db, p.anio, p.mes);
    expect(v(periodo.utilidadNeta)).toBe('24400.00');                       // 50.000 − 20.000 − 4.000 − 100 − 1.500
    expect(v(periodo.depreciacion)).toBe('100.00');
    expect(periodo.capitalTrabajo.lineas.map((l) => [l.codigo, v(l.valor)])).toEqual([['2.1.09', '1500.00']]);
    expect(v(periodo.efectivoOperacion)).toBe('26000.00');
    expect([v(periodo.efectivoInicial), v(periodo.variacion), v(periodo.efectivoFinal)]).toEqual(['88000.00', '26000.00', '114000.00']);
    expect(periodo.variacion.usd.toFixed(2)).toBe('650.00');                // 26.000 / 40
    expect(periodo.cuadra).toBe(true);
    expect(periodo.diferencia.usd.toFixed(2)).toBe('0.00');
  });

  it('el acumulado del año parte del efectivo del cierre del año anterior', async () => {
    const { acumuladoAnio } = await flujoEfectivoDelMes(db, p.anio, p.mes);
    expect(acumuladoAnio.cuadra).toBe(true);
    expect(v(acumuladoAnio.efectivoFinal)).toBe('114000.00');
    if (q.anio === p.anio) {
      expect([v(acumuladoAnio.efectivoInicial), v(acumuladoAnio.variacion)]).toEqual(['0.00', '114000.00']);
      expect(v(acumuladoAnio.utilidadNeta)).toBe('24400.00');
    }
  });

  it('los saldos de apertura son el efectivo inicial del periodo, no un flujo', async () => {
    // Un asiento de apertura ya contabilizado (se inserta sin disparadores, como lo hace la apertura): efectivo contra «Saldos de apertura».
    await db.query('set session_replication_role = replica');
    const a = (await db.query<{ id: string }>(
      `insert into asiento (fecha, tipo, descripcion, created_by, estado, numero, contabilizado_at, periodo_id)
       values ($1::date, 'automatico', 'Saldo inicial de prueba', $2, 'contabilizado', 999998, now(), (fn_periodo_de($1::date, 'manual')).id) returning id`, [p.dia, contador])).rows[0].id;
    for (const [codigo, debe, haber] of [['1.1.01.01', 5000, 0], ['3.9.01', 0, 5000]] as [string, number, number][]) {
      await db.query(
        `insert into asiento_linea (asiento_id, cuenta_id, debe_ves, haber_ves, debe_usd, haber_usd, moneda_original, monto_original, tasa) values ($1, $2, $3, $4, $3 / 40.0, $4 / 40.0, 'VES', $3 + $4, 1)`, [a, await cuenta(db, codigo), debe, haber]);
    }
    await db.query('set session_replication_role = origin');
    const { periodo } = await flujoEfectivoDelMes(db, p.anio, p.mes);
    expect([v(periodo.efectivoInicial), v(periodo.variacion), v(periodo.efectivoFinal)]).toEqual(['93000.00', '26000.00', '119000.00']);
    expect(periodo.financiamiento.lineas).toEqual([]);                      // el saldo de apertura no aparece como aporte
    expect(periodo.cuadra).toBe(true);
  });
});
