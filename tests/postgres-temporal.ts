import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** Puerto libre del sistema. */
function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/**
 * PostgreSQL real y temporal para pruebas (paquete embedded-postgres): se crea en la carpeta
 * temporal del sistema, escucha solo en localhost y se borra al detenerlo.
 */
export async function postgresTemporal(): Promise<{ url: string; detener: () => Promise<void> }> {
  const port = await puertoLibre();
  const dir = path.join(tmpdir(), `erp-pg-${randomUUID()}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'erp',
    password: 'erp',
    // La carpeta la borramos nosotros: en Windows los archivos siguen bloqueados un instante
    // después de detener el servidor y el borrado del paquete falla con EBUSY.
    persistent: true,
    // En Windows initdb usaría WIN1252: la base del ERP siempre es UTF-8 (las migraciones lo requieren).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('erp_pruebas');
  const detener = async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  return { url: `postgres://erp:erp@127.0.0.1:${port}/erp_pruebas`, detener };
}
