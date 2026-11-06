import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checklistCierre } from '@/lib/contabilidad/cierre';
import { contabilizar } from '@/lib/contabilidad/motor';
import { calcularRevaluacion, efectoDe, estadoRevaluacion, proponerRevaluacion, registroVigente, type UsuarioReval } from '@/lib/contabilidad/revaluacion';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { crearCuentaBancaria } from '@/lib/maestros/cuentas-bancarias';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const d = (v: string | number) => new Decimal(v);

describe('revaluación cambiaria: el efecto de revaluar', () => {
  it('un activo gana si vale más y un pasivo gana si vale menos', () => {
    expect(efectoDe('activo', d(100), d(4000), d(50))).toEqual({ revaluado: d(5000), efecto: d(1000) });
    expect(efectoDe('activo', d(100), d(4000), d(38)).efecto.toFixed(2)).toBe('-200.00');
    expect(efectoDe('pasivo', d(100), d(4000), d(50)).efecto.toFixed(2)).toBe('-1000.00');
    expect(efectoDe('pasivo', d(100), d(4000), d(38)).efecto.toFixed(2)).toBe('200.00');
  });
});

describe('revaluación cambiaria mensual (R-DY a R-EA)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador: UsuarioReval;
  let jefe: UsuarioReval;
  let ventas: UsuarioReval;
  let m = { anio: 0, mes: 0, dia5: '', fin: '', siguiente: '' };
  let banco = { id: '', contable: '' };

  const como = <T,>(u: UsuarioReval, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const deposito = (fecha: string, usd: string) => db.transaction((tx) => contabilizar(tx, {
    evento: 'mov_entrada_prueba', fecha, descripcion: 'Depósito en dólares', origen: { tipo: 'prueba', id: randomUUID() }, moneda: 'USD', importes: { monto: usd }, cuentas: { banco: banco.contable }, usuarioId: contador.id,
  }));
  const lineas = async (asientoId: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id where l.asiento_id = $1 order by l.id`, [asientoId])).rows;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const id = async (email: string, rol: string) => ({ id: await usuarioDePrueba(db, email, [rol]), roles: [rol] });
    contador = await id('contador@prueba.test', 'contabilidad');
    jefe = await id('jefe@prueba.test', 'jefe_contabilidad');
    ventas = await id('ventas@prueba.test', 'ventas');
    const f = (await db.query<{ a: number; m: number; d5: string; fin: string; sig: string }>(
      `with h as (select date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as p)
       select extract(year from p - interval '1 month')::int as a, extract(month from p - interval '1 month')::int as m, (p - interval '1 month' + interval '4 days')::date::text as d5,
              (p - 1)::text as fin, p::text as sig from h`)).rows[0];
    m = { anio: f.a, mes: f.m, dia5: f.d5, fin: f.fin, siguiente: f.sig };
    for (const a of new Set([Number(f.d5.slice(0, 4)), Number(f.sig.slice(0, 4))])) await db.query('select fn_crear_periodos($1)', [a]);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40), ($2, 'USD', 50)`, [m.dia5, m.fin]);

    const b = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    const t = { id: await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']), roles: ['tesoreria'] };
    const c = await como(t, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: b, numero: '0102-0000-22' }));
    banco = { id: c.id, contable: (await db.query<{ id: string }>('select cuenta_contable_id as id from cuenta_bancaria where id = $1', [c.id])).rows[0].id };
    const puente = (await db.query<{ id: string }>(`select id from cuenta_contable where codigo = '3.9.01'`)).rows[0].id;
    await db.query(
      `insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa) values
         ('mov_entrada_prueba', 1, 'D', null, 'banco', 'monto', 'Entrada al banco'), ('mov_entrada_prueba', 2, 'H', $1, null, 'monto', 'Contrapartida')`, [puente]);
    await deposito(m.dia5, '100.00');                          // US$ 100 a 40 = Bs 4.000 en libros; al cierre, a 50 valen Bs 5.000
  });
  afterAll(() => cerrar());

  it('calcula la ganancia de un banco en dólares a la tasa del último día del mes', async () => {
    const c = await calcularRevaluacion(db, m.anio, m.mes);
    expect(c.tasa).toBe('50.000000');
    expect(c.items.map((i) => [i.concepto.startsWith('CB'), i.divisaUsd, i.librosVes, i.revaluadoVes, i.efectoVes])).toEqual([[true, '100.00', '4000.00', '5000.00', '1000.00']]);
    expect([c.gananciaVes, c.perdidaVes]).toEqual(['1000.00', '0.00']);
    const e = await estadoRevaluacion(db, m.anio, m.mes);
    expect(e.ok).toBe(false);
    expect(e.detalle).toContain('proponga la revaluación');
  });

  it('solo Contabilidad o Gerencia la proponen, un mes abierto, y una sola vez', async () => {
    await esperarError(como(ventas, (tx) => proponerRevaluacion(tx, ventas, m.anio, m.mes)), 'Solo Contabilidad o Gerencia');
    await como(contador, (tx) => proponerRevaluacion(tx, contador, m.anio, m.mes));
    await esperarError(como(contador, (tx) => proponerRevaluacion(tx, contador, m.anio, m.mes)), 'ya tiene una revaluación');
    expect((await estadoRevaluacion(db, m.anio, m.mes)).detalle).toContain('pendiente del Jefe de contabilidad');
    expect((await checklistCierre(db, m.anio, m.mes)).puntos.find((p) => p.codigo === 'diferencial_cambiario')!.ok).toBe(false);
  });

  it('la aprueba el Jefe de contabilidad, distinto de quien la propuso, y no se modifica', async () => {
    const r = (await registroVigente(db, m.anio, m.mes))!;
    await esperarError(como(contador, (tx) => resolverAprobacion(tx, 'revaluacion_cambiaria', r.id, contador.id, 'aprobada')), 'o');
    await esperarError(db.query(`update revaluacion_cambiaria set estado = 'aprobada', aprobado_por = created_by, asiento_id = null where id = $1`, [r.id]), 'distinto de quien propuso');
    await esperarError(db.query(`update revaluacion_cambiaria set ganancia_ves = 1 where id = $1`, [r.id]), 'no se modifica');
    await esperarError(db.query('delete from revaluacion_cambiaria'), 'no se borra');
  });

  it('al aprobar contabiliza el ajuste el último día y su reverso el primer día del mes siguiente, solo en bolívares', async () => {
    const r = (await registroVigente(db, m.anio, m.mes))!;
    await como(jefe, (tx) => resolverAprobacion(tx, 'revaluacion_cambiaria', r.id, jefe.id, 'aprobada'));
    const v = (await db.query<{ estado: string; a: string; ra: string; fa: string; fr: string; ta: string; tr: string }>(
      `select r.estado, r.asiento_id as a, r.asiento_reverso_id as ra, x.fecha::text as fa, y.fecha::text as fr, x.tipo as ta, y.tipo as tr
         from revaluacion_cambiaria r join asiento x on x.id = r.asiento_id join asiento y on y.id = r.asiento_reverso_id where r.id = $1`, [r.id])).rows[0];
    expect([v.estado, v.fa, v.fr, v.ta, v.tr]).toEqual(['aprobada', m.fin, m.siguiente, 'ajuste_cambiario', 'reverso']);
    expect(await lineas(v.a)).toEqual([
      { codigo: '1.1.03.01', debe_ves: '1000.00', haber_ves: '0.00', debe_usd: '0.00', haber_usd: '0.00' },
      { codigo: '4.2.01', debe_ves: '0.00', haber_ves: '1000.00', debe_usd: '0.00', haber_usd: '0.00' },
    ]);
    expect(await lineas(v.ra)).toEqual([
      { codigo: '1.1.03.01', debe_ves: '0.00', haber_ves: '1000.00', debe_usd: '0.00', haber_usd: '0.00' },
      { codigo: '4.2.01', debe_ves: '1000.00', haber_ves: '0.00', debe_usd: '0.00', haber_usd: '0.00' },
    ]);
    // El valor en USD del banco no cambió y el mayor sigue cuadrado.
    const usd = (await db.query<{ s: string }>(`select sum(l.debe_usd - l.haber_usd)::text as s from asiento_linea l join asiento a on a.id = l.asiento_id where l.cuenta_id = $1 and a.estado = 'contabilizado'`, [banco.contable])).rows[0].s;
    expect(usd).toBe('100.00');
    expect((await db.query<{ d: string }>('select (diferencia_ves + diferencia_usd)::text as d from vw_control_cuadre')).rows[0].d).toBe('0.00');
  });

  it('aprobada, el cálculo da lo mismo y el cierre mensual lo da por resuelto', async () => {
    const e = await estadoRevaluacion(db, m.anio, m.mes);
    expect(e.ok).toBe(true);
    expect(e.detalle).toContain('Revaluada a la tasa 50.000000');
    expect((await calcularRevaluacion(db, m.anio, m.mes)).items[0].efectoVes).toBe('1000.00');
    expect((await checklistCierre(db, m.anio, m.mes)).puntos.find((p) => p.codigo === 'diferencial_cambiario')!.ok).toBe(true);
  });

  it('si después hay movimientos en divisas dentro del mes, la revaluación aprobada deja de valer', async () => {
    await deposito(m.dia5, '10.00');
    const e = await estadoRevaluacion(db, m.anio, m.mes);
    expect(e.ok).toBe(false);
    expect(e.detalle).toContain('Las cifras cambiaron');
    expect((await checklistCierre(db, m.anio, m.mes)).puntos.find((p) => p.codigo === 'diferencial_cambiario')!.ok).toBe(false);
  });

  it('un mes sin diferencia por registrar queda resuelto sin proponer nada', async () => {
    const antes = m.mes === 1 ? { anio: m.anio - 1, mes: 12 } : { anio: m.anio, mes: m.mes - 1 };
    await db.query('select fn_crear_periodos($1)', [antes.anio]);
    const sinTasa = await estadoRevaluacion(db, antes.anio, antes.mes);
    expect([sinTasa.ok, sinTasa.detalle.includes('tasa BCV')]).toEqual([false, true]);               // sin tasa del último día no se puede valorar
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select (make_date($1::int, $2::int, 1) + interval '1 month - 1 day')::date, 'USD', 45`, [antes.anio, antes.mes]);
    const e = await estadoRevaluacion(db, antes.anio, antes.mes);
    expect(e.ok).toBe(true);
    await esperarError(como(contador, (tx) => proponerRevaluacion(tx, contador, antes.anio, antes.mes)), 'No hay diferencia cambiaria');
  });
});
