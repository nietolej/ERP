import { hashClave, claveTemporal } from './clave';
import { ROLES } from './constantes';
import { cargarUsuario, type UsuarioSesion } from './sesiones';
import type { Db } from '@/lib/db/tipos';

/**
 * Modo sin inicio de sesión, SOLO para desarrollo en la máquina local.
 *
 * Se activa con ERP_SIN_LOGIN=1 (en .env.local) y nunca en producción: con NODE_ENV=production se ignora. Mientras está
 * activo, el ERP entra directo con el usuario "Desarrollo (sin login)", que tiene todos los roles, y se puede cambiar de usuario
 * desde /desarrollo/usuario para probar los permisos y las aprobaciones (que exigen personas distintas).
 *
 * Esto relaja la regla de autenticación de AGENTS.md §6 de forma deliberada y temporal. Antes de arrancar en producción:
 * quitar ERP_SIN_LOGIN y desactivar el usuario de desarrollo (ver README).
 */

export { COOKIE_USUARIO_DEV, sinLogin } from './constantes';
export const EMAIL_USUARIO_DEV = 'desarrollo@sin-login.local';

/** Crea (una vez) el usuario de desarrollo con todos los roles. Su clave es aleatoria y nunca se muestra: no sirve para entrar por /login. */
export async function asegurarUsuarioDesarrollo(db: Db): Promise<UsuarioSesion> {
  const { rows } = await db.query<{ id: string }>('select id from usuario where email = $1', [EMAIL_USUARIO_DEV]);
  let id = rows[0]?.id;
  if (!id) {
    const { rows: nuevo } = await db.query<{ id: string }>(
      `insert into usuario (email, nombre, password_hash, debe_cambiar_password) values ($1, 'Desarrollo (sin login)', $2, false) returning id`,
      [EMAIL_USUARIO_DEV, await hashClave(claveTemporal())]);
    id = nuevo[0].id;
  }
  await db.query('update usuario set activo = true, debe_cambiar_password = false where id = $1', [id]);
  for (const rol of ROLES) {
    await db.query('insert into usuario_rol (usuario_id, rol) values ($1, $2) on conflict do nothing', [id, rol]);
  }
  const u = await cargarUsuario(db, id);
  if (!u) throw new Error('No se pudo preparar el usuario de desarrollo');
  return u;
}
