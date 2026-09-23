import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './tipos';

export const DIR_MIGRACIONES = path.join(process.cwd(), 'db', 'migrations');

/**
 * Aplica en orden las migraciones de db/migrations que falten, cada una en su
 * propia transacción. Si una migración ya aplicada cambió de contenido, se
 * detiene: el esquema solo cambia con migraciones nuevas (AGENTS.md §3).
 */
export async function migrar(db: Db, dir = DIR_MIGRACIONES): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      checksum   text not null,
      aplicada_at timestamptz not null default now()
    )`);

  const archivos = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const { rows } = await db.query<{ version: string; checksum: string }>(
    'select version, checksum from schema_migrations',
  );
  const aplicadas = new Map(rows.map((r) => [r.version, r.checksum]));
  const nuevas: string[] = [];

  for (const archivo of archivos) {
    const sql = await readFile(path.join(dir, archivo), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previa = aplicadas.get(archivo);
    if (previa) {
      if (previa !== checksum) {
        throw new Error(
          `La migración ${archivo} ya fue aplicada y su contenido cambió. No se editan migraciones aplicadas: cree una nueva.`,
        );
      }
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (version, checksum) values ($1, $2)', [archivo, checksum]);
    });
    nuevas.push(archivo);
  }
  return nuevas;
}
