/**
 * Crea o actualiza la base de datos aplicando las migraciones de db/migrations.
 * Uso: npm run db:migrar
 *   - Con DATABASE_URL=postgres://… migra PostgreSQL.
 *   - Sin DATABASE_URL, migra la base local PGlite en ./.data/erp.
 */
import { getDb } from '../src/lib/db';
import { migrar } from '../src/lib/db/migrar';

const db = await getDb();
const nuevas = await migrar(db);
console.log(nuevas.length ? `Migraciones aplicadas:\n  ${nuevas.join('\n  ')}` : 'La base ya estaba al día.');
process.exit(0);
