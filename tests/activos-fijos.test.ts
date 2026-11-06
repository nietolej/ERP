import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fijarFechaArranque } from '@/lib/apertura/apertura';
import {
  activosSinDepreciar, confirmarVidaUtil, cuotaDelMes, depreciarMes, listarCategorias, mesesDesde, registrarActivoApertura, saldoAuxiliarActivos, solicitarBaja, type PlanActivo,
  type UsuarioActivo,
} from '@/lib/contabilidad/activos';
import { cuadreAuxiliares } from '@/lib/contabilidad/cierre';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const d = (v: string | number) => new Decimal(v);
const plan = (o: Partial<PlanActivo> = {}): PlanActivo => ({
  costoVes: d(100), costoUsd: d(10), residualVes: d(0), residualUsd: d(0), depAperturaVes: d(0), depAperturaUsd: d(0), vidaUtilMeses: 3, mesesApertura: 0, ...o,
});

describe('depreciación en línea recta: cuota del mes', () => {
  it('reparte el valor depreciable entre los meses y la última cuota ajusta el resto', () => {
    let ves = d(0);
    let usd = d(0);
    const cuotas: string[] = [];
    for (let previas = 0; previas < 3; previas++) {
      const c = cuotaDelMes(plan(), previas, ves, usd)!;
      cuotas.push(c.ves.toFixed(2));
      ves = ves.plus(c.ves);
      usd = usd.plus(c.usd);
      expect(c.ultima).toBe(previas === 2);
    }
    expect(cuotas).toEqual(['33.33', '33.33', '33.34']);
    expect([ves.toFixed(2), usd.toFixed(2)]).toEqual(['100.00', '10.00']);                  // nunca pasa del costo
    expect(cuotaDelMes(plan(), 3, ves, usd)).toBeNull();                                    // sin meses ni importes por depreciar
  });

  it('respeta el valor residual y lo ya depreciado al arranque', () => {
    const c = cuotaDelMes(plan({ residualVes: d(10), residualUsd: d(1), depAperturaVes: d(30), depAperturaUsd: d(3), vidaUtilMeses: 12, mesesApertura: 6 }), 0, d(0), d(0))!;
    expect([c.ves.toFixed(2), c.usd.toFixed(2)]).toEqual(['10.00', '1.00']);                // (100 − 10 − 30) ÷ 6 meses que le quedan
    expect(cuotaDelMes(plan({ residualVes: d(100), residualUsd: d(10) }), 0, d(0), d(0))).toBeNull();   // todo el costo es residual
  });

  it('cuenta los meses desde el inicio de la depreciación', () => {
    expect(mesesDesde('2026-03-01', 2026, 3)).toBe(0);
    expect(mesesDesde('2026-03-01', 2026, 5)).toBe(2);
    expect(mesesDesde('2025-11-01', 2026, 2)).toBe(3);
  });
});

describe('activos fijos (R-EB a R-EE)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador: UsuarioActivo;
  let gerente: UsuarioActivo;
  let ventas: UsuarioActivo;
  let q = { anio: 0, mes: 0, ini: '' };      // el mes de arranque: dos meses atrás
  let p = { anio: 0, mes: 0 };               // el mes pasado
  const act = { comp: '', mob: '', maq: '' };
  let cat: Record<string, string> = {};

  const como = <T,>(u: UsuarioActivo, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const lineas = async (origenTipo: string, origenId: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 order by l.id`, [origenTipo, origenId])).rows;
  const decidir = (id: string, u: UsuarioActivo, decision: 'aprobada' | 'rechazada', tipo = 'activo_fijo') =>
    como(u, (tx) => resolverAprobacion(tx, tipo, id, u.id, decision, decision === 'rechazada' ? { comentario: 'No corresponde' } : {}));
  const estado = async (id: string) => (await db.query<{ estado: string }>('select estado from activo_fijo where id = $1', [id])).rows[0].estado;
  const periodoId = async (m: { anio: number; mes: number }) => (await db.query<{ id: string }>('select id from periodo_contable where anio = $1 and mes = $2', [m.anio, m.mes])).rows[0].id;
  const nuevo = (descripcion: string, categoria: string, extra: Record<string, string | number> = {}) => como(contador, (tx) => registrarActivoApertura(tx, contador, {
    descripcion, categoriaId: cat[categoria], fechaAdquisicion: '2025-01-15', costoVes: '12000.00', costoUsd: '300.00', ...extra,
  }));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    contador = { id: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']), roles: ['contabilidad'] };
    gerente = { id: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']), roles: ['gerencia'] };
    ventas = { id: await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']), roles: ['ventas'] };
    const f = (await db.query<{ a1: number; m1: number; i1: string; a2: number; m2: number }>(
      `with h as (select date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as m)
       select extract(year from m - interval '2 month')::int as a1, extract(month from m - interval '2 month')::int as m1, (m - interval '2 month')::date::text as i1,
              extract(year from m - interval '1 month')::int as a2, extract(month from m - interval '1 month')::int as m2 from h`)).rows[0];
    q = { anio: f.a1, mes: f.m1, ini: f.i1 };
    p = { anio: f.a2, mes: f.m2 };
    for (const a of new Set([q.anio, p.anio, new Date().getFullYear()])) await db.query('select fn_crear_periodos($1)', [a]);
    await db.query(
      `insert into tasa_cambio (fecha, moneda, tasa)
       select x::date, 'USD', 40 from unnest(array[$1::date, ($1::date + interval '1 month - 1 day')::date, ($1::date + interval '2 month - 1 day')::date, (now() at time zone 'America/Caracas')::date]) x`, [q.ini]);
    cat = Object.fromEntries((await listarCategorias(db)).map((c) => [c.codigo, c.id]));
  });
  afterAll(() => cerrar());

  it('las categorías traen sus cuentas y una vida útil de ejemplo que el contador debe confirmar', async () => {
    const cats = await listarCategorias(db);
    expect(cats.map((c) => [c.codigo, c.cuenta_activo, c.vida_util_meses, c.validada_por])).toEqual([
      ['COMP', '1.4.04', 48, null], ['EDIF', '1.4.06', 240, null], ['MAQ', '1.4.05', 120, null], ['MOB', '1.4.01', 120, null], ['VEH', '1.4.03', 60, null],
    ]);
    await esperarError(como(ventas, (tx) => confirmarVidaUtil(tx, ventas, cat.MAQ, 60)), 'Solo Contabilidad o Gerencia');
    await esperarError(como(contador, (tx) => confirmarVidaUtil(tx, contador, cat.MAQ, 0)), 'meses enteros');
    await como(contador, (tx) => confirmarVidaUtil(tx, contador, cat.COMP, 48));          // la confirma sin cambiarla
    await como(contador, (tx) => confirmarVidaUtil(tx, contador, cat.MAQ, 2));            // la cambia (queda quién y cuándo)
    const v = (await listarCategorias(db)).filter((c) => c.validada_por);
    expect(v.map((c) => [c.codigo, c.vida_util_meses, c.validada_por])).toEqual([['COMP', 48, 'Usuario de prueba'], ['MAQ', 2, 'Usuario de prueba']]);
  });

  it('sin fecha de arranque no se registra un activo existente', async () => {
    await esperarError(nuevo('Computador de oficina', 'COMP'), 'fecha de arranque');
    await como(gerente, (tx) => fijarFechaArranque(tx, gerente, q.ini));
  });

  it('se registra con datos válidos y nace pendiente; lo aprueba Gerencia, otra persona', async () => {
    await esperarError(como(ventas, (tx) => registrarActivoApertura(tx, ventas, { descripcion: 'X', categoriaId: cat.COMP, fechaAdquisicion: '2025-01-15', costoVes: '1', costoUsd: '1' })), 'Solo Contabilidad o Gerencia');
    await esperarError(nuevo('Computador', 'COMP', { costoVes: '0' }), 'mayor que cero');
    await esperarError(nuevo('Computador', 'COMP', { dep_ves: 'x', depAperturaVes: 'x' }), 'monto con hasta 2 decimales');
    await esperarError(nuevo('Computador', 'COMP', { depAperturaVes: '13000.00', depAperturaUsd: '1' }), 'violates check');
    act.comp = await nuevo('Computador de oficina', 'COMP');
    act.mob = await nuevo('Escritorios', 'MOB', { costoVes: '6000.00', costoUsd: '150.00', mesesDepreciados: 12, depAperturaVes: '600.00', depAperturaUsd: '15.00' });
    act.maq = await nuevo('Montacargas', 'MAQ', { costoVes: '1000.01', costoUsd: '25.01' });
    expect(await estado(act.comp)).toBe('pendiente');
    await esperarError(como(contador, (tx) => resolverAprobacion(tx, 'activo_fijo', act.comp, contador.id, 'aprobada')), 'o');
    await esperarError(db.query(`update activo_fijo set estado = 'activo', aprobado_por = created_by where id = $1`, [act.comp]), 'distinta de quien registró');
    expect((await db.query<{ codigo: string }>('select codigo from activo_fijo order by codigo')).rows.map((r) => r.codigo)).toEqual(['AF00001', 'AF00002', 'AF00003']);
  });

  it('al aprobar se contabiliza el costo y la depreciación acumulada contra «Saldos de apertura»', async () => {
    for (const a of [act.comp, act.mob, act.maq]) await decidir(a, gerente, 'aprobada');
    expect([await estado(act.comp), await estado(act.mob)]).toEqual(['activo', 'activo']);
    expect(await lineas('activo_fijo_apertura', act.comp)).toEqual([
      { codigo: '1.4.04', debe_ves: '12000.00', haber_ves: '0.00', debe_usd: '300.00', haber_usd: '0.00' },
      { codigo: '3.9.01', debe_ves: '0.00', haber_ves: '12000.00', debe_usd: '0.00', haber_usd: '300.00' },
    ]);
    expect(await lineas('activo_fijo_apertura', act.mob)).toEqual([
      { codigo: '1.4.01', debe_ves: '6000.00', haber_ves: '0.00', debe_usd: '150.00', haber_usd: '0.00' },
      { codigo: '1.4.02', debe_ves: '0.00', haber_ves: '600.00', debe_usd: '0.00', haber_usd: '15.00' },
      { codigo: '3.9.01', debe_ves: '0.00', haber_ves: '5400.00', debe_usd: '0.00', haber_usd: '135.00' },
    ]);
    const a = await saldoAuxiliarActivos(db);
    expect([a.costoVes.toFixed(2), a.depVes.toFixed(2)]).toEqual([a.mayorCostoVes.toFixed(2), a.mayorDepVes.toFixed(2)]);
    expect([a.costoUsd.toFixed(2), a.depUsd.toFixed(2)]).toEqual([a.mayorCostoUsd.toFixed(2), a.mayorDepUsd.toFixed(2)]);
  });

  it('un activo no se modifica ni se borra', async () => {
    await esperarError(db.query(`update activo_fijo set costo_ves = 1 where id = $1`, [act.comp]), 'no se modifican');
    await esperarError(db.query('delete from activo_fijo'), 'se da de baja');
  });

  it('el cierre ve los activos sin depreciar del mes', async () => {
    expect(await activosSinDepreciar(db, q.anio, q.mes)).toHaveLength(3);
  });

  it('no se deprecia un mes que no terminó, ni se salta un mes', async () => {
    const hoy = new Date();
    await esperarError(como(contador, (tx) => depreciarMes(tx, contador, hoy.getFullYear(), hoy.getMonth() + 1)), 'ya terminó');
    await esperarError(como(ventas, (tx) => depreciarMes(tx, ventas, q.anio, q.mes)), 'Solo Contabilidad o Gerencia');
    await esperarError(como(contador, (tx) => depreciarMes(tx, contador, p.anio, p.mes)), 'Deprecie primero los meses anteriores');
  });

  it('deprecia el mes en un asiento por categoría, con cuotas en bolívares y en dólares', async () => {
    const r = await como(contador, (tx) => depreciarMes(tx, contador, q.anio, q.mes));
    expect([r.activos, r.totalVes, r.totalUsd]).toEqual([3, '800.01', '20.01']);          // 250,00 + 50,00 + 500,01 y 6,25 + 1,25 + 12,51
    const asiento = (await db.query<{ id: string }>(`select id from asiento where origen_tipo = 'depreciacion_mensual' and origen_id = $1`, [await periodoId(q)])).rows[0].id;
    const ls = (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
      `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id where l.asiento_id = $1 order by l.id`, [asiento])).rows;
    expect(ls).toEqual([
      { codigo: '6.2.04', debe_ves: '800.01', haber_ves: '0.00', debe_usd: '20.01', haber_usd: '0.00' },
      { codigo: '1.4.02', debe_ves: '0.00', haber_ves: '800.01', debe_usd: '0.00', haber_usd: '20.01' },
    ]);
    await esperarError(como(contador, (tx) => depreciarMes(tx, contador, q.anio, q.mes)), 'ya está depreciado');
    expect(await activosSinDepreciar(db, q.anio, q.mes)).toEqual([]);
  });

  it('la última cuota ajusta el resto y el activo queda depreciado; no pasa del valor depreciable', async () => {
    await como(contador, (tx) => depreciarMes(tx, contador, p.anio, p.mes));
    const m = (await db.query<{ ves: string; usd: string }>(`select sum(monto_ves)::text as ves, sum(monto_usd)::text as usd from depreciacion_activo where activo_id = $1`, [act.maq])).rows[0];
    expect([m.ves, m.usd]).toEqual(['1000.01', '25.01']);
    expect(await estado(act.maq)).toBe('depreciado');
    expect(await estado(act.comp)).toBe('activo');
    await esperarError(db.query(`update depreciacion_activo set monto_ves = 1`), 'no se modifica');
    await esperarError(db.query('delete from depreciacion_activo'), 'no se modifica');
  });

  it('los auxiliares de activos cuadran con el mayor en el cierre, en bolívares y en dólares', async () => {
    const af = (await cuadreAuxiliares(db)).filter((x) => x.nombre.startsWith('Activos fijos'));
    expect(af.map((x) => [x.nombre, x.moneda, x.ok])).toEqual([
      ['Activos fijos: costo', 'VES', true], ['Activos fijos: costo', 'USD', true], ['Activos fijos: depreciación acumulada', 'VES', true], ['Activos fijos: depreciación acumulada', 'USD', true],
    ]);
  });

  it('la baja saca el costo y la depreciación acumulada y lleva la diferencia a pérdida, con aprobación de Gerencia', async () => {
    const hoy = (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;
    await esperarError(como(ventas, (tx) => solicitarBaja(tx, ventas, { activoId: act.comp, fecha: hoy, motivo: 'Dañado' })), 'Solo Contabilidad o Gerencia');
    await esperarError(como(contador, (tx) => solicitarBaja(tx, contador, { activoId: act.comp, fecha: '2999-01-01', motivo: 'Dañado' })), 'no puede ser futura');
    await esperarError(como(contador, (tx) => solicitarBaja(tx, contador, { activoId: act.comp, fecha: hoy, motivo: '' })), 'motivo');
    const baja = await como(contador, (tx) => solicitarBaja(tx, contador, { activoId: act.comp, fecha: hoy, motivo: 'Equipo dañado sin reparación' }));
    await esperarError(como(contador, (tx) => solicitarBaja(tx, contador, { activoId: act.comp, fecha: hoy, motivo: 'Otra vez' })), 'duplicate key');
    await esperarError(como(contador, (tx) => resolverAprobacion(tx, 'baja_activo_fijo', baja, contador.id, 'aprobada')), 'o');
    await decidir(baja, gerente, 'aprobada', 'baja_activo_fijo');
    expect(await estado(act.comp)).toBe('dado_de_baja');
    expect(await lineas('baja_activo_fijo', baja)).toEqual([
      { codigo: '1.4.02', debe_ves: '500.00', haber_ves: '0.00', debe_usd: '12.50', haber_usd: '0.00' },          // 2 cuotas de Bs 250
      { codigo: '6.2.05', debe_ves: '11500.00', haber_ves: '0.00', debe_usd: '287.50', haber_usd: '0.00' },
      { codigo: '1.4.04', debe_ves: '0.00', haber_ves: '12000.00', debe_usd: '0.00', haber_usd: '300.00' },
    ]);
    const af = (await cuadreAuxiliares(db)).filter((x) => x.nombre.startsWith('Activos fijos'));
    expect(af.every((x) => x.ok)).toBe(true);
    await esperarError(como(contador, (tx) => solicitarBaja(tx, contador, { activoId: act.comp, fecha: hoy, motivo: 'Ya dado de baja' })), 'activo vigente');
  });
});
