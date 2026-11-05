import { crearDbPglite } from '@/lib/db/pglite';
import { migrar } from '@/lib/db/migrar';
import type { Db } from '@/lib/db/tipos';

/** Base nueva en memoria con todas las migraciones aplicadas. */
export async function baseDePrueba(): Promise<{ db: Db; cerrar: () => Promise<void> }> {
  const base = await crearDbPglite();
  await migrar(base.db);
  return base;
}

/** Crea un usuario de prueba, con los roles indicados, y devuelve su id. */
export async function usuarioDePrueba(db: Db, email = 'contador@prueba.test', roles: string[] = []): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into usuario (email, nombre, password_hash) values ($1, 'Usuario de prueba', 'x') returning id`,
    [email],
  );
  for (const rol of roles) {
    await db.query('insert into usuario_rol (usuario_id, rol) values ($1, $2)', [rows[0].id, rol]);
  }
  return rows[0].id;
}

const CORREO_CIERRE = 'cierre-prueba@prueba.test';

async function usuarioDeCierre(db: Db): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select id from usuario where email = $1', [CORREO_CIERRE]);
  return rows[0]?.id ?? usuarioDePrueba(db, CORREO_CIERRE, ['gerencia']);
}

/** Cierra (con la función del cierre mensual) los periodos abiertos que cumplan `donde`, del más antiguo al más reciente. */
export async function cerrarPeriodosDePrueba(db: Db, donde = 'true'): Promise<void> {
  const u = await usuarioDeCierre(db);
  const { rows } = await db.query<{ id: string }>(`select id from periodo_contable where estado = 'abierto' and (${donde}) order by anio, mes`);
  for (const r of rows) await db.query('select fn_cerrar_periodo($1, null, $2)', [r.id, u]);
}

/** Reabre (con la reapertura de Gerencia) los periodos cerrados que cumplan `donde`. */
export async function reabrirPeriodosDePrueba(db: Db, donde = 'true'): Promise<void> {
  const u = await usuarioDeCierre(db);
  const { rows } = await db.query<{ id: string }>(`select id from periodo_contable where estado = 'cerrado' and (${donde}) order by anio, mes`);
  for (const r of rows) await db.query('select fn_reabrir_periodo($1, $2, $3)', [r.id, 'Reapertura de prueba', u]);
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
