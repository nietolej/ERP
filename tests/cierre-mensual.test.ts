import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checklistCierre, cerrarMes, confirmarCierre, cuadreAuxiliares, historialCierre, reabrirMes, retirarConfirmacionCierre, type UsuarioCierre,
} from '@/lib/contabilidad/cierre';
import { aprobarAsiento, eliminarBorrador, guardarBorrador, huellaAsiento, type LineaManual } from '@/lib/contabilidad/manual';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { crearCuentaBancaria } from '@/lib/maestros/cuentas-bancarias';
import { cerrarExtracto, crearExtracto } from '@/lib/tesoreria/conciliacion';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Cierre mensual (spec §12.4; migración 0051): checklist, confirmaciones por periodo, cierre con foto del checklist, reapertura de Gerencia y las
 * reglas de la base (UPDATE directo rechazado, borradores, orden de los meses).
 */
describe('cierre mensual (R-DP a R-DS)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador: UsuarioCierre;
  let jefe: UsuarioCierre;
  let gerente: UsuarioCierre;
  let ventas: UsuarioCierre;
  let q = { anio: 0, mes: 0, dia: '' };       // el mes anterior al pasado
  let p = { anio: 0, mes: 0, dia: '' };       // el mes pasado
  let banco = { id: '', contable: '' };

  const como = <T,>(u: UsuarioCierre, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const periodoId = async (m: { anio: number; mes: number }) => (await db.query<{ id: string }>('select id from periodo_contable where anio = $1 and mes = $2', [m.anio, m.mes])).rows[0].id;
  const estado = async (m: { anio: number; mes: number }) => (await db.query<{ estado: string }>('select estado from periodo_contable where anio = $1 and mes = $2', [m.anio, m.mes])).rows[0].estado;
  const manual = async (fecha: string, lineas: [string, string, string][], aprobar = true) => {
    const ls: LineaManual[] = [];
    for (const [codigo, debe, haber] of lineas) ls.push({ cuentaId: await cuenta(db, codigo), debe, haber });
    const id = await como(contador, (tx) => guardarBorrador(tx, contador.id, { fecha, descripcion: 'Asiento de prueba', moneda: 'VES', lineas: ls }));
    if (aprobar) await como(jefe, async (tx) => aprobarAsiento(tx, id, jefe.id, await huellaAsiento(tx, id)));
    return id;
  };
  const puntos = async (m: { anio: number; mes: number }) => Object.fromEntries((await checklistCierre(db, m.anio, m.mes)).puntos.map((x) => [x.codigo, x]));
  const declararIva = (m: { anio: number; mes: number }) => como(contador, (tx) => tx.query(
    `insert into declaracion_fiscal (tipo, anio, mes, desde, hasta, cifras, declarada_por)
     values ('iva', $1::int, $2::int, make_date($1::int, $2::int, 1), (make_date($1::int, $2::int, 1) + interval '1 month - 1 day')::date, '{}'::jsonb, $3)`, [m.anio, m.mes, contador.id]));
  const confirmarTodo = async (m: { anio: number; mes: number }) => {
    await como(contador, (tx) => confirmarCierre(tx, contador, m.anio, m.mes, 'recurrentes', 'Sin depreciación ni nómina este mes'));
  };

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const id = async (email: string, rol: string) => ({ id: await usuarioDePrueba(db, email, [rol]), roles: [rol] });
    contador = await id('contador@prueba.test', 'contabilidad');
    jefe = await id('jefe@prueba.test', 'jefe_contabilidad');
    gerente = await id('gerente@prueba.test', 'gerencia');
    ventas = await id('ventas@prueba.test', 'ventas');
    const f = (await db.query<{ a1: number; m1: number; d1: string; a2: number; m2: number; d2: string; hoy: string }>(
      `with h as (select date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as m)
       select extract(year from m - interval '2 month')::int as a1, extract(month from m - interval '2 month')::int as m1, (m - interval '2 month' + interval '14 days')::date::text as d1,
              extract(year from m - interval '1 month')::int as a2, extract(month from m - interval '1 month')::int as m2, (m - interval '1 month' + interval '14 days')::date::text as d2,
              (now() at time zone 'America/Caracas')::date::text as hoy from h`)).rows[0];
    q = { anio: f.a1, mes: f.m1, dia: f.d1 };
    p = { anio: f.a2, mes: f.m2, dia: f.d2 };
    for (const a of new Set([q.anio, p.anio])) await db.query('select fn_crear_periodos($1)', [a]);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series($1::date - 70, $1::date, interval '1 day') d`, [f.hoy]);

    // Un banco con un movimiento el mes pasado, para probar la conciliación como punto del cierre.
    const b = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    const t = { id: await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']), roles: ['tesoreria'] };
    const c = await como(t, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: b, numero: '0102-0000-11' }));
    banco = { id: c.id, contable: (await db.query<{ id: string }>('select cuenta_contable_id as id from cuenta_bancaria where id = $1', [c.id])).rows[0].id };
    const puente = (await db.query<{ id: string }>(`select id from cuenta_contable where codigo = '3.9.01'`)).rows[0].id;
    await db.query(
      `insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa) values
         ('mov_entrada_prueba', 1, 'D', null, 'banco', 'monto', 'Entrada al banco'), ('mov_entrada_prueba', 2, 'H', $1, null, 'monto', 'Contrapartida')`, [puente]);

    // Dos meses atrás y el mes pasado: movimiento en caja, para que los dos meses tengan asientos.
    await manual(q.dia, [['1.1.01.01', '1000', ''], ['3.1.01', '', '1000']]);
    await manual(p.dia, [['1.1.01.01', '500', ''], ['4.1.01', '', '500']]);
  });
  afterAll(() => cerrar());

  it('un mes anterior abierto con movimiento impide cerrar el siguiente', async () => {
    const c = await puntos(p);
    expect(c.anteriores.ok).toBe(false);
    expect(c.anteriores.pendientes).toHaveLength(1);
    await confirmarTodo(p);
    await declararIva(p);
    await esperarError(como(contador, (tx) => cerrarMes(tx, contador, p.anio, p.mes)), 'meses anteriores con movimiento están cerrados');
  });

  it('las confirmaciones las hace Contabilidad o Gerencia, una sola vez, y las retira el Jefe de contabilidad o Gerencia con motivo', async () => {
    await esperarError(como(ventas, (tx) => confirmarCierre(tx, ventas, q.anio, q.mes, 'recurrentes')), 'Solo Contabilidad o Gerencia');
    await como(contador, (tx) => confirmarCierre(tx, contador, q.anio, q.mes, 'recurrentes', 'Revisadas'));
    await esperarError(como(contador, (tx) => confirmarCierre(tx, contador, q.anio, q.mes, 'recurrentes')), 'ya está hecha');
    const { rows } = await db.query<{ id: string }>(`select id from cierre_confirmacion where codigo = 'recurrentes' and retirada_at is null and periodo_id = $1`, [await periodoId(q)]);
    await esperarError(como(contador, (tx) => retirarConfirmacionCierre(tx, contador, rows[0].id, 'Me equivoqué')), 'Solo el Jefe de contabilidad o Gerencia');
    await esperarError(como(jefe, (tx) => retirarConfirmacionCierre(tx, jefe, rows[0].id, '')), 'motivo');
    await como(jefe, (tx) => retirarConfirmacionCierre(tx, jefe, rows[0].id, 'Falta la provisión de vacaciones'));
    expect((await puntos(q)).recurrentes.ok).toBe(false);
    await como(contador, (tx) => confirmarCierre(tx, contador, q.anio, q.mes, 'recurrentes', 'Revisadas de nuevo'));
    await esperarError(db.query(`update cierre_confirmacion set nota = 'otra' where periodo_id = $1`, [await periodoId(q)]), 'no se edita');
    await esperarError(db.query(`delete from cierre_confirmacion where periodo_id = $1`, [await periodoId(q)]), 'no se borra');
  });

  it('un asiento en borrador del mes impide cerrar, en el checklist y en la base', async () => {
    const id = await manual(q.dia, [['1.1.01.01', '5', ''], ['3.1.01', '', '5']], false);
    const c = await puntos(q);
    expect(c.documentos.ok).toBe(false);
    expect(c.documentos.pendientes).toEqual(['1 asientos en borrador']);
    await esperarError(db.query('select fn_cerrar_periodo($1, null, $2)', [await periodoId(q), gerente.id]), 'asientos en borrador');
    await como(contador, (tx) => eliminarBorrador(tx, id, contador.id));
    expect((await puntos(q)).documentos.ok).toBe(true);
  });

  it('una cuenta con movimiento sin su conciliación cerrada impide cerrar; con la conciliación cerrada, no', async () => {
    await db.transaction((tx) => contabilizar(tx, {
      evento: 'mov_entrada_prueba', fecha: p.dia, descripcion: 'Depósito', origen: { tipo: 'prueba', id: randomUUID() }, moneda: 'VES', importes: { monto: '100.00' }, cuentas: { banco: banco.contable }, usuarioId: contador.id,
    }));
    const antes = await puntos(p);
    expect(antes.conciliaciones.ok).toBe(false);
    expect(antes.conciliaciones.pendientes[0]).toContain('Banco Nacional Bs');
    const t = { id: (await db.query<{ id: string }>(`select id from usuario where email = 'tesoreria@prueba.test'`)).rows[0].id, roles: ['tesoreria'] };
    const ext = await como(t, (tx) => crearExtracto(tx, t, { cuentaId: banco.id, anio: p.anio, mes: p.mes, saldoInicial: '0.00', saldoFinal: '0.00' }));
    await como(contador, (tx) => cerrarExtracto(tx, contador, ext));
    expect((await puntos(p)).conciliaciones.ok).toBe(true);
  });

  it('los auxiliares cuadran con el mayor y la cuenta puente de mercancía no facturada no puede quedar deudora', async () => {
    const todos = await cuadreAuxiliares(db);
    expect(todos.map((x) => `${x.nombre} ${x.moneda}`)).toEqual([
      'Cuentas por cobrar (1.2.01) VES', 'Cuentas por cobrar (1.2.01) USD', 'Cuentas por pagar (2.1.01) USD', 'Inventario de mercancía (1.3.01) USD',
      'Activos fijos: costo VES', 'Activos fijos: costo USD', 'Activos fijos: depreciación acumulada VES', 'Activos fijos: depreciación acumulada USD',
      'Comisiones por pagar (2.1.07) VES', 'Comisiones por pagar (2.1.07) USD',
      'Mercancía recibida no facturada (2.1.02): saldo no deudor USD',
    ]);
    expect(todos.every((x) => x.ok)).toBe(true);
    expect((await puntos(p)).auxiliares.ok).toBe(true);

    // Se facturó más de lo recibido: la cuenta puente queda deudora.
    const a = await manual(p.dia, [['2.1.02', '100', ''], ['1.1.01.01', '', '100']]);
    const malo = await puntos(p);
    expect(malo.auxiliares.ok).toBe(false);
    expect(malo.auxiliares.pendientes[0]).toContain('2.1.02');
    await db.transaction(async (tx) => { await tx.query("select set_config('app.usuario_id', $1, true)", [contador.id]); await tx.query(`select fn_reversar_asiento($1, $2::date, 'Prueba')`, [a, p.dia]); });
    expect((await puntos(p)).auxiliares.ok).toBe(true);
  });

  it('cerrar un mes sin las declaraciones o con puntos pendientes se rechaza con lo que falta', async () => {
    await esperarError(como(contador, (tx) => cerrarMes(tx, contador, q.anio, q.mes)), 'Libros de IVA, retenciones y declaraciones');
    await esperarError(como(ventas, (tx) => cerrarMes(tx, ventas, q.anio, q.mes)), 'Solo Contabilidad o Gerencia');
    expect(await estado(q)).toBe('abierto');
  });

  it('un UPDATE directo del estado no cierra ni reabre un mes: solo las funciones del cierre', async () => {
    await esperarError(db.query(`update periodo_contable set estado = 'cerrado' where anio = $1 and mes = $2`, [q.anio, q.mes]), 'cierre mensual');
    await esperarError(db.query(`update periodo_contable set estado = 'bloqueado' where anio = $1 and mes = $2`, [q.anio, q.mes]), 'después de cerrarlo');
    expect(await estado(q)).toBe('abierto');
  });

  it('con todo en orden se cierra el mes más antiguo y queda la foto del checklist', async () => {
    await declararIva(q);
    const c = await checklistCierre(db, q.anio, q.mes);
    expect(c.puntos.filter((x) => !x.ok).map((x) => x.codigo)).toEqual([]);
    expect(c.listo).toBe(true);
    await como(contador, (tx) => cerrarMes(tx, contador, q.anio, q.mes));
    expect(await estado(q)).toBe('cerrado');
    const h = await historialCierre(db, q.anio, q.mes);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ accion: 'cierre', por: 'Usuario de prueba' });
    const foto = (await db.query<{ checklist: { codigo: string; ok: boolean }[] }>(`select checklist from cierre_periodo where periodo_id = $1`, [await periodoId(q)])).rows[0].checklist;
    expect(foto.map((x) => x.codigo)).toEqual(['anteriores', 'documentos', 'conciliaciones', 'auxiliares', 'fiscal', 'recurrentes', 'diferencial_cambiario', 'balance']);
    expect(foto.every((x) => x.ok)).toBe(true);
  });

  it('cerrado el mes no admite asientos, ni confirmaciones nuevas, y el historial no se modifica', async () => {
    await esperarError(manual(q.dia, [['1.1.01.01', '5', ''], ['3.1.01', '', '5']]), 'está cerrado');
    await esperarError(como(contador, (tx) => confirmarCierre(tx, contador, q.anio, q.mes, 'recurrentes')), 'ya no está abierto');
    await esperarError(db.query(`update cierre_periodo set motivo = 'x'`), 'no se modifica');
    await esperarError(db.query(`delete from cierre_periodo`), 'no se modifica');
    await esperarError(como(contador, (tx) => cerrarMes(tx, contador, q.anio, q.mes)), 'ya está cerrado');
  });

  it('el mes siguiente ya se puede cerrar, y mientras tanto no se reabre el anterior', async () => {
    expect((await puntos(p)).anteriores.ok).toBe(true);
    await como(contador, (tx) => cerrarMes(tx, contador, p.anio, p.mes));
    expect(await estado(p)).toBe('cerrado');
    await esperarError(como(gerente, (tx) => reabrirMes(tx, gerente, q.anio, q.mes, 'Corregir un asiento')), 'meses posteriores cerrados');
  });

  it('reabrir es solo de Gerencia, con motivo, y queda en el historial; un mes reabierto vuelve a pasar por el checklist', async () => {
    await esperarError(como(contador, (tx) => reabrirMes(tx, contador, p.anio, p.mes, 'Quiero corregir')), 'Solo Gerencia');
    await esperarError(como(jefe, (tx) => reabrirMes(tx, jefe, p.anio, p.mes, 'Quiero corregir')), 'Solo Gerencia');
    await esperarError(como(gerente, (tx) => reabrirMes(tx, gerente, p.anio, p.mes, ' ')), 'motivo');
    await esperarError(db.query(`update periodo_contable set estado = 'abierto' where anio = $1 and mes = $2`, [p.anio, p.mes]), 'reapertura de Gerencia');
    await como(gerente, (tx) => reabrirMes(tx, gerente, p.anio, p.mes, 'Se omitió una provisión de servicios'));
    expect(await estado(p)).toBe('abierto');
    const h = await historialCierre(db, p.anio, p.mes);
    expect(h.map((x) => x.accion)).toEqual(['reapertura', 'cierre']);
    expect(h[0].motivo).toBe('Se omitió una provisión de servicios');
    await manual(p.dia, [['6.2.03', '30', ''], ['1.1.01.01', '', '30']]);                  // ya admite asientos de nuevo
    await como(contador, (tx) => cerrarMes(tx, contador, p.anio, p.mes));
    expect((await historialCierre(db, p.anio, p.mes)).map((x) => x.accion)).toEqual(['cierre', 'reapertura', 'cierre']);
  });

  it('un mes cerrado se bloquea y el bloqueado no se reabre', async () => {
    await db.query(`update periodo_contable set estado = 'bloqueado' where anio = $1 and mes = $2`, [p.anio, p.mes]);
    await esperarError(como(gerente, (tx) => reabrirMes(tx, gerente, p.anio, p.mes, 'Ya no se puede')), 'Solo se reabre un periodo cerrado');
    await esperarError(db.query(`update periodo_contable set estado = 'abierto' where anio = $1 and mes = $2`, [p.anio, p.mes]), 'no se puede reabrir');
  });

  it('el periodo 13 del ejercicio conserva su comportamiento: no lo gobierna el cierre mensual', async () => {
    await db.query(`update periodo_contable set estado = 'cerrado' where anio = $1 and mes = 13`, [p.anio]);
    await db.query(`update periodo_contable set estado = 'abierto' where anio = $1 and mes = 13`, [p.anio]);
    expect(await estado({ anio: p.anio, mes: 13 })).toBe('abierto');
  });

  it('las funciones de la base exigen usuario con el rol', async () => {
    const sinUsuario = (await db.query<{ id: string }>(`select id from periodo_contable where estado = 'abierto' and mes <= 12 limit 1`)).rows[0];
    if (sinUsuario) {
      await esperarError(db.query('select fn_cerrar_periodo($1)', [sinUsuario.id]), 'necesita el usuario');
      await esperarError(db.query('select fn_cerrar_periodo($1, null, $2)', [sinUsuario.id, ventas.id]), 'Solo Contabilidad o Gerencia');
    }
  });
});
