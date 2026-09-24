import { randomUUID } from 'node:crypto';
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
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpdir(), `erp-pg-${randomUUID()}`),
    port,
    user: 'erp',
    password: 'erp',
    persistent: false,
    // En Windows initdb usaría WIN1252: la base del ERP siempre es UTF-8 (las migraciones lo requieren).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('erp_pruebas');
  return { url: `postgres://erp:erp@127.0.0.1:${port}/erp_pruebas`, detener: () => pg.stop() };
}
