import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { contabilizar } from '@/lib/contabilidad/motor';
import { migrar } from '@/lib/db/migrar';
import { crearDbPostgres } from '@/lib/db/postgres';
import type { Db } from '@/lib/db/tipos';
import { cuenta, usuarioDePrueba } from './apoyo';
import { postgresTemporal } from './postgres-temporal';

/**
 * Concurrencia de numeración (AGENTS.md §6) contra un PostgreSQL real: PGlite tiene una sola
 * conexión y no puede ejecutar dos transacciones a la vez.
 *
 * Con TEST_DATABASE_URL usa ese servidor (la integración continua levanta uno). Sin ella arranca
 * un PostgreSQL temporal (embedded-postgres) que se borra al terminar.
 * Cada corrida crea su propio esquema y lo borra al terminar: no toca otros datos de esa base.
 */
const N = 20;

describe('concurrencia de numeración (PostgreSQL real)', () => {
  const esquema = `prueba_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let URL_PRUEBA: string;
  let detenerTemporal: (() => Promise<void>) | undefined;
  let db: Db;
  let cerrar: () => Promise<void>;

  beforeAll(async () => {
    if (process.env.TEST_DATABASE_URL) {
      URL_PRUEBA = process.env.TEST_DATABASE_URL;
    } else {
      ({ url: URL_PRUEBA, detener: detenerTemporal } = await postgresTemporal());
    }
    const admin = new pg.Client({ connectionString: URL_PRUEBA });
    await admin.connect();
    await admin.query(`create schema ${esquema}`);
    await admin.end();

    // Todas las conexiones del pool trabajan dentro del esquema de la prueba.
    const url = new URL(URL_PRUEBA);
    url.searchParams.set('options', `-c search_path=${esquema}`);
    ({ db, cerrar } = crearDbPostgres(url.toString()));
    await migrar(db);
  });

  afterAll(async () => {
    await cerrar?.();
    if (detenerTemporal) {
      await detenerTemporal(); // el servidor temporal se borra completo
      return;
    }
    if (!URL_PRUEBA) return;
    const admin = new pg.Client({ connectionString: URL_PRUEBA });
    await admin.connect();
    await admin.query(`drop schema if exists ${esquema} cascade`);
    await admin.end();
  });

  /** Lanza `n` transacciones a la vez; cada una pide un número y espera un poco antes de confirmar. */
  const simultaneas = (n: number, fallan: (i: number) => boolean = () => false) =>
    Promise.allSettled(Array.from({ length: n }, (_, i) =>
      db.transaction(async (tx) => {
        const { rows } = await tx.query<{ n: string }>(`select fn_siguiente_numero('concurrencia', 'A') as n`);
        await tx.query('select pg_sleep(0.02)');
        if (fallan(i)) throw new Error('falla del documento');
        return Number(rows[0].n);
      })));

  const confirmados = (r: PromiseSettledResult<number>[]) =>
    r.filter((x): x is PromiseFulfilledResult<number> => x.status === 'fulfilled').map((x) => x.value).sort((a, b) => a - b);

  it(`${N} transacciones simultáneas reciben números distintos y consecutivos`, async () => {
    await db.query(`insert into numerador (tipo_documento, serie) values ('concurrencia', 'A')`);
    const numeros = confirmados(await simultaneas(N));
    expect(numeros).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('las transacciones que fallan no dejan huecos, aunque ocurran en paralelo', async () => {
    await db.query(`update numerador set siguiente = 1 where tipo_documento = 'concurrencia'`);
    const r = await simultaneas(N, (i) => i % 3 === 0);
    const numeros = confirmados(r);
    const fallidas = r.filter((x) => x.status === 'rejected').length;
    expect(fallidas).toBe(Math.ceil(N / 3));
    expect(numeros).toEqual(Array.from({ length: N - fallidas }, (_, i) => i + 1));
  });

  it('asientos contabilizados en paralelo reciben números de asiento únicos y sin huecos', async () => {
    const usuario = await usuarioDePrueba(db);
    await db.query('select fn_crear_periodos(2026)');
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ('2026-04-01', 'USD', 36.123457)`);
    await db.query(
      `insert into regla_contable (evento, orden, lado, cuenta_id, importe)
       values ('concurrencia', 1, 'D', $1, 'total'), ('concurrencia', 2, 'H', $2, 'total')`,
      [await cuenta(db, '6.2.02'), await cuenta(db, '1.1.01.01')]);

    const r = await Promise.all(Array.from({ length: N }, () =>
      db.transaction((tx) => contabilizar(tx, {
        evento: 'concurrencia', fecha: '2026-04-02', descripcion: 'Prueba de concurrencia',
        origen: { tipo: 'concurrencia', id: randomUUID() }, moneda: 'VES', importes: { total: '100.00' },
        usuarioId: usuario,
      }))));
    const numeros = r.map((x) => Number(x.numero)).sort((a, b) => a - b);
    expect(new Set(numeros).size).toBe(N);
    expect(numeros.at(-1)! - numeros[0]).toBe(N - 1);
  });

  it('facturas emitidas en paralelo reciben números de factura únicos, correlativos y sin huecos', async () => {
    const usuario = await usuarioDePrueba(db, 'facturador@prueba.test');
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    const almacen = (await db.query<{ id: string }>(
      `insert into almacen (codigo, nombre, sucursal_id) values ('01', 'Principal', $1) returning id`, [sucursal])).rows[0].id;
    const tercero = (await db.query<{ id: string }>(
      `insert into tercero (rif, razon_social, tipo_persona) values ('J-00000010-7', 'Cliente de prueba, C.A.', 'J') returning id`)).rows[0].id;
    await db.query(`insert into cliente (tercero_id) values ($1)`, [tercero]);
    const alicuota = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const producto = (await db.query<{ id: string }>(
      `insert into producto (codigo, descripcion, alicuota_iva_id) values ('PF-001', 'Pastilla de prueba', $1) returning id`, [alicuota])).rows[0].id;

    const emitir = () => db.transaction(async (tx) => {
      await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
      const { rows } = await tx.query<{ id: string }>(
        `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, moneda, tasa, created_by)
         values ('factura', $1, $2, $3, 'VES', 40, $4) returning id`, [sucursal, almacen, tercero, usuario]);
      await tx.query(
        `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, alicuota_iva_id)
         values ($1, 1, $2, 'Pastilla', 1, 10, $3)`, [rows[0].id, producto, alicuota]);
      const { rows: e } = await tx.query<{ numero: string }>(
        `update documento_venta set estado = 'emitido', contingencia = true, contingencia_motivo = 'Prueba' where id = $1 returning numero::text`, [rows[0].id]);
      await tx.query('select pg_sleep(0.02)');
      return Number(e[0].numero);
    });
    const numeros = (await Promise.all(Array.from({ length: N }, emitir))).sort((a, b) => a - b);
    expect(numeros).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
