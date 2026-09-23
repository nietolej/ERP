import path from 'node:path';
import type { Db } from './tipos';

export type { Db } from './tipos';

/**
 * Conexión de la aplicación:
 * - DATABASE_URL = postgres://…  → PostgreSQL real (producción).
 * - Sin DATABASE_URL             → PGlite en disco en PGLITE_DIR (por defecto ./.data/erp), para desarrollo.
 */
let conexion: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!conexion) {
    conexion = (async () => {
      const url = process.env.DATABASE_URL;
      if (url && /^postgres(ql)?:\/\//.test(url)) {
        const { crearDbPostgres } = await import('./postgres');
        return crearDbPostgres(url).db;
      }
      const { crearDbPglite } = await import('./pglite');
      const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), '.data', 'erp');
      return (await crearDbPglite(dir)).db;
    })();
  }
  return conexion;
}

/**
 * Ejecuta `fn` en una transacción identificando al usuario, para que la
 * auditoría (audit_log) registre quién hizo cada cambio.
 */
export async function conUsuario<T>(usuarioId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuarioId]);
    return fn(tx);
  });
}
