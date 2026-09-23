import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@/lib/db/tipos';
import { hashClave, verificarClave } from './clave';

/**
 * Autenticación y sesiones en base de datos (sin dependencias de Next.js, para poder probarlas).
 * La cookie lleva un token aleatorio; la tabla `sesion` guarda solo su SHA-256.
 */

export const DURACION_SESION_HORAS = 12;

export interface UsuarioSesion {
  id: string;
  nombre: string;
  email: string;
  roles: string[];
  debeCambiarPassword: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// Hash válido de una clave cualquiera: se verifica contra él cuando el correo no existe,
// para que el tiempo de respuesta no revele qué correos están registrados.
let hashSeñuelo: Promise<string> | null = null;

export async function autenticar(db: Db, email: string, clave: string): Promise<UsuarioSesion | null> {
  const { rows } = await db.query<{ id: string; password_hash: string; activo: boolean }>(
    'select id, password_hash, activo from usuario where email = $1',
    [email.trim().toLowerCase()],
  );
  const u = rows[0];
  if (!u) {
    hashSeñuelo ??= hashClave('clave-señuelo-sin-uso');
    await verificarClave(clave, await hashSeñuelo);
    return null;
  }
  const valida = await verificarClave(clave, u.password_hash);
  if (!valida || !u.activo) return null;
  await db.query('update usuario set ultimo_acceso = now() where id = $1', [u.id]);
  return cargarUsuario(db, u.id);
}

export async function cargarUsuario(db: Db, id: string): Promise<UsuarioSesion | null> {
  const { rows } = await db.query<{ id: string; nombre: string; email: string; debe_cambiar_password: boolean; roles: string[] | null }>(
    `select u.id, u.nombre, u.email, u.debe_cambiar_password,
            array_remove(array_agg(ur.rol order by ur.rol), null) as roles
       from usuario u left join usuario_rol ur on ur.usuario_id = u.id
      where u.id = $1 and u.activo
      group by u.id`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, nombre: r.nombre, email: r.email, roles: r.roles ?? [], debeCambiarPassword: r.debe_cambiar_password };
}

export async function crearSesion(db: Db, usuarioId: string): Promise<{ token: string; expira: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expira = new Date(Date.now() + DURACION_SESION_HORAS * 3600 * 1000);
  await db.query('insert into sesion (usuario_id, token_hash, expira_at) values ($1, $2, $3)', [
    usuarioId, hashToken(token), expira,
  ]);
  return { token, expira };
}

/** Usuario de una sesión vigente, o null si el token no existe, venció o el usuario está inactivo. */
export async function usuarioDeSesion(db: Db, token: string): Promise<UsuarioSesion | null> {
  const { rows } = await db.query<{ usuario_id: string }>(
    'select usuario_id from sesion where token_hash = $1 and expira_at > now()',
    [hashToken(token)],
  );
  if (!rows[0]) return null;
  return cargarUsuario(db, rows[0].usuario_id);
}

export async function eliminarSesion(db: Db, token: string): Promise<void> {
  await db.query('delete from sesion where token_hash = $1', [hashToken(token)]);
}

/** Cierra todas las sesiones de un usuario (p. ej. al cambiar la clave o desactivarlo). */
export async function eliminarSesionesDeUsuario(db: Db, usuarioId: string): Promise<void> {
  await db.query('delete from sesion where usuario_id = $1', [usuarioId]);
}
