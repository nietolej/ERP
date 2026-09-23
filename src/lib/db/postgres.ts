import pg from 'pg';
import type { Db } from './tipos';

// numeric (1700), int8 (20) y date (1082) como texto (ver tipos.ts)
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);
pg.types.setTypeParser(1082, (v) => v);

function desdeCliente(cliente: pg.PoolClient): Db {
  const db: Db = {
    async query(sql, params) {
      const r = await cliente.query(sql, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    async exec(sql) {
      await cliente.query(sql);
    },
    async transaction(fn) {
      return fn(db); // ya estamos dentro de una transacción
    },
  };
  return db;
}

/** Base PostgreSQL real (producción). */
export function crearDbPostgres(connectionString: string): { db: Db; cerrar: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString });
  const db: Db = {
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const cliente = await pool.connect();
      try {
        await cliente.query('begin');
        const resultado = await fn(desdeCliente(cliente));
        await cliente.query('commit');
        return resultado;
      } catch (e) {
        await cliente.query('rollback');
        throw e;
      } finally {
        cliente.release();
      }
    },
  };
  return { db, cerrar: () => pool.end() };
}
