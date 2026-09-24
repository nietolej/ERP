import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aprobarAsiento, eliminarBorrador, guardarBorrador, huellaAsiento, type DatosAsientoManual,
} from '@/lib/contabilidad/manual';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

describe('asientos manuales con aprobación (§3.1, §4.3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let contador: string;
  let otroContador: string;
  let jefe: string;
  let jefeQueRegistra: string;
  let gasto: string;
  let caja: string;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    contador = await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']);
    otroContador = await usuarioDePrueba(db, 'contador2@prueba.test', ['contabilidad']);
    jefe = await usuarioDePrueba(db, 'jefe@prueba.test', ['jefe_contabilidad']);
    jefeQueRegistra = await usuarioDePrueba(db, 'jefe2@prueba.test', ['contabilidad', 'jefe_contabilidad']);
    await db.query('select fn_crear_periodos(2026)');
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ('2026-04-01', 'USD', 36.123457)`);
    gasto = await cuenta(db, '6.2.02');
    caja = await cuenta(db, '1.1.01.01');
  });
  afterAll(() => cerrar());

  const datos = (debe = '400.00', haber = debe, extra: Partial<DatosAsientoManual> = {}): DatosAsientoManual => ({
    fecha: '2026-04-06',
    descripcion: 'Provisión de gastos',
    moneda: 'VES',
    lineas: [
      { cuentaId: gasto, debe, haber: '' },
      { cuentaId: caja, debe: '', haber },
    ],
    ...extra,
  });
  const borrador = (d: DatosAsientoManual, usuario = contador, id?: string) =>
    db.transaction((tx) => guardarBorrador(tx, usuario, d, id));
  const aprobar = async (id: string, usuario = jefe) =>
    db.transaction(async (tx) => aprobarAsiento(tx, id, usuario, await huellaAsiento(tx, id)));

  it('Contabilidad registra un borrador: sin número y fuera del balance', async () => {
    const id = await borrador(datos());
    const { rows } = await db.query<{ estado: string; numero: string | null; tipo: string }>(
      'select estado, numero, tipo from asiento where id = $1', [id]);
    expect(rows[0]).toEqual({ estado: 'borrador', numero: null, tipo: 'manual' });
    const cuadre = await db.query<{ diferencia_ves: string }>('select diferencia_ves from vw_control_cuadre');
    expect(cuadre.rows[0].diferencia_ves).toBe('0');
  });

  it('valida cuadre, líneas e importes antes de guardar', async () => {
    await esperarError(borrador(datos('400.00', '399.99')), 'no cuadra');
    await esperarError(borrador(datos('-5', '-5')), 'número positivo');
    await esperarError(borrador(datos('1.234', '1.234')), 'hasta 2 decimales');
    await esperarError(
      borrador({ ...datos(), lineas: [{ cuentaId: gasto, debe: '10', haber: '10' }, { cuentaId: caja, debe: '', haber: '10' }] }),
      'no en ambos',
    );
    await esperarError(borrador({ ...datos(), lineas: [{ cuentaId: gasto, debe: '10', haber: '' }] }), 'al menos dos líneas');
    await esperarError(borrador(datos('10', '10', { descripcion: '  ' })), 'descripción');
  });

  it('convierte a VES y USD con la tasa BCV de la fecha, con línea de redondeo si hace falta', async () => {
    const id = await borrador({
      ...datos(), moneda: 'USD',
      lineas: [
        { cuentaId: gasto, debe: '10.01', haber: '' },
        { cuentaId: gasto, debe: '10.01', haber: '' },
        { cuentaId: caja, debe: '', haber: '20.02' },
      ],
    });
    const { rows } = await db.query<{ debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string; tasa: string }>(
      'select debe_ves, haber_ves, debe_usd, haber_usd, tasa from asiento_linea where asiento_id = $1 order by id', [id]);
    expect(rows[0]).toMatchObject({ debe_usd: '10.01', debe_ves: '361.60', tasa: '36.123457' }); // 10.01 × 36.123457 = 361.5958…
    expect(rows[2]).toMatchObject({ haber_usd: '20.02', haber_ves: '723.19' });              // 723.1916…
    expect(rows).toHaveLength(4);                                                           // 361.60 × 2 − 723.19 = 0.01 de redondeo
    expect(rows[3]).toMatchObject({ debe_ves: '0.00', haber_ves: '0.01' });
    expect(await aprobar(id)).toBeTruthy();
  });

  it('rechaza cuentas controladas por un auxiliar y periodos cerrados desde el borrador', async () => {
    const cxc = await cuenta(db, '1.2.01');
    await esperarError(
      borrador({ ...datos(), lineas: [{ cuentaId: cxc, debe: '5', haber: '' }, { cuentaId: caja, debe: '', haber: '5' }] }),
      'controlada por el auxiliar de cxc',
    );
    await db.query(`update periodo_contable set estado = 'cerrado' where anio = 2026 and mes = 2`);
    await esperarError(borrador(datos('5', '5', { fecha: '2026-02-10' })), 'está cerrado');
  });

  it('solo quien registró el borrador lo corrige o lo elimina', async () => {
    const id = await borrador(datos());
    await esperarError(borrador(datos('50', '50'), otroContador, id), 'Solo quien registró');
    await esperarError(db.transaction((tx) => eliminarBorrador(tx, id, otroContador)), 'Solo quien registró');

    await borrador(datos('50.00', '50.00'), contador, id);
    const { rows } = await db.query<{ n: number; total: string }>(
      'select count(*)::int as n, sum(debe_ves) as total from asiento_linea where asiento_id = $1', [id]);
    expect(rows[0]).toEqual({ n: 2, total: '50.00' });

    await db.transaction((tx) => eliminarBorrador(tx, id, contador));
    expect((await db.query('select 1 from asiento where id = $1', [id])).rows).toHaveLength(0);
  });

  it('el jefe de contabilidad aprueba y el asiento queda contabilizado con número', async () => {
    const id = await borrador(datos());
    const numero = await aprobar(id);
    const { rows } = await db.query<{ estado: string; numero: string; aprobado_por: string; contabilizado_por: string }>(
      'select estado, numero, aprobado_por, contabilizado_por from asiento where id = $1', [id]);
    expect(rows[0]).toEqual({ estado: 'contabilizado', numero, aprobado_por: jefe, contabilizado_por: jefe });

    await esperarError(aprobar(id), 'ya fue contabilizado');
    await esperarError(db.transaction((tx) => eliminarBorrador(tx, id, contador)), 'ya está contabilizado');
  });

  it('R-F: quien registró no aprueba, aunque tenga el rol de jefe', async () => {
    const id = await borrador(datos(), jefeQueRegistra);
    await esperarError(aprobar(id, jefeQueRegistra), 'no puede aprobarlo');
  });

  it('R-F: un usuario sin el rol de jefe, o inactivo, no aprueba', async () => {
    const id = await borrador(datos());
    await esperarError(aprobar(id, otroContador), 'Jefe de contabilidad');

    await db.query('update usuario set activo = false where id = $1', [jefe]);
    await esperarError(aprobar(id, jefe), 'Jefe de contabilidad');
    await db.query('update usuario set activo = true where id = $1', [jefe]);
  });

  it('R-F en la base: no se contabiliza sin aprobación ni se aprueba un borrador por fuera del flujo', async () => {
    const id = await borrador(datos());
    await esperarError(
      db.query(`update asiento set estado = 'contabilizado' where id = $1`, [id]),
      'necesita la aprobación',
    );
    await esperarError(
      db.query(`update asiento set aprobado_por = $2 where id = $1`, [id, jefe]),
      'se registra al contabilizarlo',
    );
  });

  it('no aprueba un borrador que cambió después de revisarlo', async () => {
    const id = await borrador(datos());
    const huella = await huellaAsiento(db, id);
    await borrador(datos('401.00', '401.00'), contador, id);
    await esperarError(db.transaction((tx) => aprobarAsiento(tx, id, jefe, huella)), 'cambió');
  });

  it('control: el mayor sigue cuadrado', async () => {
    const { rows } = await db.query<{ diferencia_ves: string; diferencia_usd: string }>('select * from vw_control_cuadre');
    expect(rows[0]).toEqual({ diferencia_ves: '0.00', diferencia_usd: '0.00' });
  });
});
