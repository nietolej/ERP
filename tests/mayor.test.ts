import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

/** Línea de asiento: [código de cuenta, debe, haber] en VES; USD = VES / 40 para simplificar. */
type L = [string, string, string];

describe('mayor contable: reglas garantizadas por la base de datos', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let usuario: string;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    usuario = await usuarioDePrueba(db);
    await db.query('select fn_crear_periodos(2026)');
  });
  afterAll(() => cerrar());

  async function crearAsiento(tx: Db, fecha: string, lineas: L[], tipo = 'manual'): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `insert into asiento (fecha, tipo, descripcion, created_by) values ($1, $2, 'Prueba', $3) returning id`,
      [fecha, tipo, usuario],
    );
    for (const [codigo, debe, haber] of lineas) {
      const usdD = (Number(debe) / 40).toFixed(2);
      const usdH = (Number(haber) / 40).toFixed(2);
      await tx.query(
        `insert into asiento_linea (asiento_id, cuenta_id, debe_ves, haber_ves, debe_usd, haber_usd, moneda_original, monto_original, tasa)
         values ($1, $2, $3, $4, $5, $6, 'VES', $7, 1)`,
        [rows[0].id, await cuenta(tx, codigo), debe, haber, usdD, usdH, Number(debe) > 0 ? debe : haber],
      );
    }
    return rows[0].id;
  }

  async function contabilizarManual(fecha: string, lineas: L[], tipo = 'manual'): Promise<{ id: string; numero: string }> {
    return db.transaction(async (tx) => {
      const id = await crearAsiento(tx, fecha, lineas, tipo);
      const { rows } = await tx.query<{ numero: string }>(
        `update asiento set estado = 'contabilizado' where id = $1 returning numero`, [id]);
      return { id, numero: rows[0].numero };
    });
  }

  const gasto: L[] = [['6.2.02', '400.00', '0'], ['1.1.01.01', '0', '400.00']];

  it('R-A: contabiliza un asiento cuadrado y le asigna número correlativo', async () => {
    const a = await contabilizarManual('2026-03-10', gasto);
    const b = await contabilizarManual('2026-03-11', gasto);
    expect(Number(b.numero)).toBe(Number(a.numero) + 1);
  });

  it('R-A: rechaza al confirmar un asiento que no cuadra', async () => {
    await esperarError(
      contabilizarManual('2026-03-10', [['6.2.02', '400.00', '0'], ['1.1.01.01', '0', '399.99']]),
      'no cuadra en VES',
    );
  });

  it('R-A: rechaza un asiento de una sola línea', async () => {
    await esperarError(contabilizarManual('2026-03-10', [['6.2.02', '400.00', '0']]), 'al menos dos líneas');
  });

  it('R-A: un asiento que falla no consume número (sin huecos)', async () => {
    const antes = await contabilizarManual('2026-03-12', gasto);
    await esperarError(
      contabilizarManual('2026-03-12', [['6.2.02', '1.00', '0'], ['1.1.01.01', '0', '2.00']]),
      'no cuadra',
    );
    const despues = await contabilizarManual('2026-03-12', gasto);
    expect(Number(despues.numero)).toBe(Number(antes.numero) + 1);
  });

  it('R-B: un asiento contabilizado no se modifica, no se borra ni recibe líneas', async () => {
    const a = await contabilizarManual('2026-03-13', gasto);
    await esperarError(db.query(`update asiento set descripcion = 'otra' where id = $1`, [a.id]), 'no se puede modificar');
    await esperarError(db.query('delete from asiento where id = $1', [a.id]), 'no se puede borrar');
    await esperarError(
      db.query('update asiento_linea set debe_ves = 1 where asiento_id = $1', [a.id]),
      'sus líneas no se pueden modificar',
    );
    await esperarError(
      db.query(
        `insert into asiento_linea (asiento_id, cuenta_id, debe_ves, moneda_original, monto_original, tasa)
         values ($1, $2, 1, 'VES', 1, 1)`,
        [a.id, await cuenta(db, '6.2.02')],
      ),
      'sus líneas no se pueden modificar',
    );
  });

  it('R-B: se corrige con un reverso espejo que deja saldo cero, una sola vez', async () => {
    const a = await contabilizarManual('2026-03-14', [['6.2.03', '250.00', '0'], ['1.1.01.01', '0', '250.00']]);
    const { rows } = await db.query<{ id: string }>(
      `select fn_reversar_asiento($1, '2026-03-15', 'Gasto registrado dos veces') as id`, [a.id]);
    const { rows: neto } = await db.query<{ saldo: string }>(
      `select sum(l.debe_ves - l.haber_ves) as saldo
         from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id
        where c.codigo = '6.2.03' and l.asiento_id in ($1, $2)`,
      [a.id, rows[0].id],
    );
    expect(neto[0].saldo).toBe('0.00');
    await esperarError(
      db.query(`select fn_reversar_asiento($1, '2026-03-15', 'otra vez')`, [a.id]),
      'duplicate key',
    );
  });

  it('R-C: periodo cerrado solo acepta reversos; bloqueado no acepta nada y no se reabre', async () => {
    const a = await contabilizarManual('2026-01-20', gasto);
    await db.query(`update periodo_contable set estado = 'cerrado' where anio = 2026 and mes = 1`);

    await esperarError(contabilizarManual('2026-01-21', gasto), 'está cerrado');
    const { rows } = await db.query<{ id: string }>(
      `select fn_reversar_asiento($1, '2026-01-31', 'Ajuste de cierre') as id`, [a.id]);
    expect(rows[0].id).toBeTruthy();

    await db.query(`update periodo_contable set estado = 'bloqueado' where anio = 2026 and mes = 1`);
    await esperarError(contabilizarManual('2026-01-22', gasto), 'está bloqueado');
    await esperarError(
      db.query(`update periodo_contable set estado = 'abierto' where anio = 2026 and mes = 1`),
      'no se puede reabrir',
    );
  });

  it('R-C: no hay asientos fuera de un periodo existente', async () => {
    await esperarError(contabilizarManual('2031-05-01', gasto), 'No existe periodo contable');
  });

  it('R-D: cuentas de agrupación y cuentas controladas por auxiliar no aceptan asientos manuales', async () => {
    await esperarError(
      contabilizarManual('2026-03-16', [['1.1.01', '10.00', '0'], ['1.1.01.01', '0', '10.00']]),
      'es de agrupación',
    );
    await esperarError(
      contabilizarManual('2026-03-16', [['1.2.01', '10.00', '0'], ['1.1.01.01', '0', '10.00']]),
      'controlada por el auxiliar de cxc',
    );
  });

  it('control diario: el balance de comprobación cuadra (diferencia cero)', async () => {
    const { rows } = await db.query<{ diferencia_ves: string; diferencia_usd: string }>(
      'select * from vw_control_cuadre');
    expect(rows[0]).toEqual({ diferencia_ves: '0.00', diferencia_usd: '0.00' });
  });
});

describe('tasas, parámetros fiscales y auditoría', () => {
  let db: Db;
  let cerrar: () => Promise<void>;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
  });
  afterAll(() => cerrar());

  it('fn_tasa: VES vale 1, usa la última tasa publicada y rechaza tasas faltantes o viejas', async () => {
    expect((await db.query<{ t: string }>(`select fn_tasa('VES', '2026-05-04') as t`)).rows[0].t).toBe('1');
    await esperarError(db.query(`select fn_tasa('USD', '2026-05-04')`), 'No hay tasa BCV de USD');

    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ('2026-05-01', 'USD', 512.345678)`);
    // Sábado y domingo usan la tasa del viernes
    expect((await db.query<{ t: string }>(`select fn_tasa('USD', '2026-05-03') as t`)).rows[0].t).toBe('512.345678');
    await esperarError(db.query(`select fn_tasa('USD', '2026-05-20')`), 'Registre la tasa vigente');
  });

  it('parámetros fiscales: se leen por fecha de vigencia y no se solapan', async () => {
    await db.query(`update parametro_fiscal set vigente_hasta = '2026-12-31' where codigo = 'IGTF'`);
    await db.query(
      `insert into parametro_fiscal (codigo, descripcion, valor, unidad, vigente_desde)
       values ('IGTF', 'IGTF 2027', 2, 'porcentaje', '2027-01-01')`);
    const v = async (f: string) =>
      (await db.query<{ v: string }>(`select fn_parametro_fiscal('IGTF', $1) as v`, [f])).rows[0].v;
    expect(await v('2026-06-01')).toBe('3.000000');
    expect(await v('2027-02-01')).toBe('2.000000');
    await esperarError(
      db.query(
        `insert into parametro_fiscal (codigo, descripcion, valor, unidad, vigente_desde)
         values ('IGTF', 'solapado', 4, 'porcentaje', '2027-06-01')`),
      'se solapa',
    );
  });

  it('auditoría: registra el usuario que hizo el cambio, nunca guarda secretos y es inmutable', async () => {
    const admin = await usuarioDePrueba(db, 'admin@prueba.test');
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.usuario_id', $1, true)", [admin]);
      await tx.query(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto')`);
    });
    const { rows } = await db.query<{ usuario_id: string; despues: Record<string, unknown> }>(
      `select usuario_id, despues from audit_log where entidad = 'sucursal'`);
    expect(rows[0].usuario_id).toBe(admin);
    expect(rows[0].despues.codigo).toBe('BQTO');

    const { rows: u } = await db.query<{ despues: Record<string, unknown> }>(
      `select despues from audit_log where entidad = 'usuario' limit 1`);
    expect(u[0].despues).not.toHaveProperty('password_hash');

    await esperarError(db.query('delete from audit_log'), 'no se puede modificar ni borrar');
  });

  it('numerador: correlativo y sin huecos cuando una transacción se revierte', async () => {
    await db.query(`insert into numerador (tipo_documento, serie) values ('prueba', 'A')`);
    const siguiente = async () =>
      (await db.query<{ n: string }>(`select fn_siguiente_numero('prueba', 'A') as n`)).rows[0].n;
    expect(await siguiente()).toBe('1');
    await esperarError(
      db.transaction(async (tx) => {
        await tx.query(`select fn_siguiente_numero('prueba', 'A')`);
        throw new Error('falla del documento');
      }),
      'falla del documento',
    );
    expect(await siguiente()).toBe('2');
  });
});
