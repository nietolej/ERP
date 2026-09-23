import { crearDbPglite } from '@/lib/db/pglite';
import { migrar } from '@/lib/db/migrar';
import type { Db } from '@/lib/db/tipos';

/** Base nueva en memoria con todas las migraciones aplicadas. */
export async function baseDePrueba(): Promise<{ db: Db; cerrar: () => Promise<void> }> {
  const base = await crearDbPglite();
  await migrar(base.db);
  return base;
}

/** Crea un usuario de prueba y devuelve su id. */
export async function usuarioDePrueba(db: Db, email = 'contador@prueba.test'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into usuario (email, nombre, password_hash) values ($1, 'Usuario de prueba', 'x') returning id`,
    [email],
  );
  return rows[0].id;
}

/** Id de una cuenta por su código. */
export async function cuenta(db: Db, codigo: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select id from cuenta_contable where codigo = $1', [codigo]);
  if (!rows[0]) throw new Error(`No existe la cuenta ${codigo}`);
  return rows[0].id;
}

/** Espera que la promesa falle con un mensaje que contenga `texto`. */
export async function esperarError(p: Promise<unknown>, texto: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(texto)) {
      throw new Error(`Se esperaba un error con "${texto}" y llegó: ${msg}`);
    }
    return;
  }
  throw new Error(`Se esperaba un error con "${texto}" y la operación terminó bien`);
}
