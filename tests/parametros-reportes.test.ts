import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { histogramaPedidos, tramosDePedido } from '@/lib/reportes/analisis';
import { actualizarParametro, leerValor, listarParametros } from '@/lib/maestros/parametros-reportes';
import { resumenDevoluciones } from '@/lib/reportes/devoluciones';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('Parámetros de reportes e inventario editables (spec_reportes §1.4)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente = '';

  const como = <T,>(fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [gerente]);
    return fn(tx);
  });

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
  });
  afterAll(() => cerrar());

  it('lee el valor con coma o punto y rechaza lo que no es un número no negativo', () => {
    expect(leerValor('15').toString()).toBe('15');
    expect(leerValor(' 0,1 ').toString()).toBe('0.1');
    for (const malo of ['', 'abc', '-3', '1e3', '1,23456', '1.000,5']) expect(() => leerValor(malo)).toThrow();
  });

  it('lista los parámetros de reportes y de inventario', async () => {
    const p = await listarParametros(db);
    expect(p.some((x) => x.tabla === 'reporte' && x.codigo === 'MOROSIDAD_PATRON_PCT')).toBe(true);
    expect(p.some((x) => x.tabla === 'inventario' && x.codigo === 'COBERTURA_RIESGO_DIAS')).toBe(true);
  });

  it('un cambio se aplica de inmediato al reporte y queda en la auditoría con quien lo hizo', async () => {
    const r = await como((tx) => actualizarParametro(tx, 'reporte', 'HISTOGRAMA_PEDIDOS_TRAMO_USD', '100'));
    expect(r).toEqual({ anterior: '50', nuevo: '100' });
    const h = await histogramaPedidos(db, {});
    expect(h.tramoUsd).toBe(100);
    expect(h.filas).toHaveLength(tramosDePedido(100, 1000).length);
    const { rows } = await db.query<{ usuario: string | null; antes: string; despues: string }>(
      `select usuario_id::text as usuario, antes ->> 'valor' as antes, despues ->> 'valor' as despues from audit_log
        where entidad = 'parametro_reporte' and accion = 'UPDATE' and despues ->> 'codigo' = 'HISTOGRAMA_PEDIDOS_TRAMO_USD'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].usuario).toBe(gerente);
    expect([Number(rows[0].antes), Number(rows[0].despues)]).toEqual([50, 100]);
  });

  it('valida las unidades y las relaciones entre parámetros', async () => {
    await esperarError(como((tx) => actualizarParametro(tx, 'reporte', 'VENTANA_VELOCIDAD_QUIEBRE_DIAS', '7,5')), 'número entero');
    await esperarError(como((tx) => actualizarParametro(tx, 'reporte', 'VENTANA_VELOCIDAD_QUIEBRE_DIAS', '0')), 'número entero');
    await esperarError(como((tx) => actualizarParametro(tx, 'reporte', 'MOROSIDAD_PATRON_PCT', '120')), 'no puede pasar de 100');
    await esperarError(como((tx) => actualizarParametro(tx, 'reporte', 'HISTOGRAMA_PEDIDOS_TOPE_USD', '50')), 'menor que el ancho del tramo');
    await esperarError(como((tx) => actualizarParametro(tx, 'reporte', 'HISTOGRAMA_PEDIDOS_TRAMO_USD', '5000')), 'mayor que el tope');
    await esperarError(como((tx) => actualizarParametro(tx, 'inventario', 'COBERTURA_RIESGO_DIAS', '200')), 'menor que la de sobrestock');
    await esperarError(como((tx) => actualizarParametro(tx, 'inventario', 'COBERTURA_SOBRESTOCK_DIAS', '10')), 'mayor que la de riesgo');
    await esperarError(como((tx) => actualizarParametro(tx, 'reporte', 'NO_EXISTE', '1')), 'desconocido');
    await esperarError(como((tx) => actualizarParametro(tx, 'otra', 'MOROSIDAD_PATRON_PCT', '1')), 'desconocido');
  });

  it('el costo por devolución es opcional: sin valor la tarjeta se oculta y al cargarlo se calcula', async () => {
    expect((await resumenDevoluciones(db, {})).costoOperativoUsd).toBeNull();
    const r = await como((tx) => actualizarParametro(tx, 'reporte', 'COSTO_POR_DEVOLUCION_USD', '15'));
    expect(r.anterior).toBeNull();
    expect((await resumenDevoluciones(db, {})).costoOperativoUsd).not.toBeNull();
    await como((tx) => actualizarParametro(tx, 'reporte', 'COSTO_POR_DEVOLUCION_USD', '20'));
    const { rows } = await db.query<{ valor: string }>(`select valor::text from parametro_reporte where codigo = 'COSTO_POR_DEVOLUCION_USD'`);
    expect(Number(rows[0].valor)).toBe(20);
  });
});
