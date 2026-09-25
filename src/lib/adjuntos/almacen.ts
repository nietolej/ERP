import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Almacenamiento de los bytes de los adjuntos (§4.2). Los archivos van en una carpeta propia
 * (ADJUNTOS_DIR, por defecto ./.data/adjuntos), nunca en `public/`: solo se sirven por la ruta
 * autenticada /api/adjuntos/[id]. El nombre en disco es el id del adjunto, no el del usuario.
 */
export interface AlmacenArchivos {
  guardar(id: string, bytes: Uint8Array): Promise<void>;
  leer(id: string): Promise<Buffer>;
  borrar(id: string): Promise<void>;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function almacenEnDisco(dir = process.env.ADJUNTOS_DIR ?? path.join(process.cwd(), '.data', 'adjuntos')): AlmacenArchivos {
  const ruta = (id: string) => {
    if (!ID.test(id)) throw new Error('Identificador de adjunto inválido');
    return path.join(dir, id.slice(0, 2), id);
  };
  return {
    async guardar(id, bytes) {
      const destino = ruta(id);
      await mkdir(path.dirname(destino), { recursive: true });
      await writeFile(destino, bytes, { flag: 'wx' }); // nunca se sobrescribe un adjunto
    },
    leer: (id) => readFile(ruta(id)),
    borrar: (id) => rm(ruta(id), { force: true }),
  };
}
