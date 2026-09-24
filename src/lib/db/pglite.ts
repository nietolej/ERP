import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite, types, type Transaction } from '@electric-sql/pglite';
import type { Db } from './tipos';

// numeric, int8 y date como texto (ver tipos.ts)
const parsers = {
  [types.NUMERIC]: (v: string) => v,
  [types.INT8]: (v: string) => v,
  [types.DATE]: (v: string) => v,
};

type Ejecutor = PGlite | Transaction;

function envolver(e: Ejecutor, enTransaccion: boolean): Db {
  const db: Db = {
    async query(sql, params) {
      const r = await e.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as never[] };
    },
    async exec(sql) {
      await e.exec(sql);
    },
    async transaction(fn) {
      if (enTransaccion) return fn(db);
      return (e as PGlite).transaction((tx) => fn(envolver(tx, true)));
    },
  };
  return db;
}

/** Base PGlite. Sin `dataDir` vive en memoria (pruebas); con `dataDir`, en disco (desarrollo). */
export async function crearDbPglite(dataDir?: string): Promise<{ db: Db; cerrar: () => Promise<void> }> {
  // PGlite crea la carpeta de datos, pero no sus carpetas padre (p. ej. .data/ la primera vez).
  if (dataDir) mkdirSync(path.dirname(dataDir), { recursive: true });
  const pg = new PGlite({ dataDir, parsers });
  await pg.waitReady;
  return { db: envolver(pg, false), cerrar: () => pg.close() };
}
