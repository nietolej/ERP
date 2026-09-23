import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { COOKIE_SESION, type Rol } from './constantes';
import { tieneRol } from './permisos';
import { usuarioDeSesion, type UsuarioSesion } from './sesiones';

/**
 * Capa de acceso a datos (DAL): la verificación de sesión real, contra la base de datos.
 * proxy.ts solo hace un chequeo rápido de la cookie; toda página, acción y ruta API
 * debe pasar por aquí antes de leer o modificar datos.
 */

export const obtenerUsuario = cache(async (): Promise<UsuarioSesion | null> => {
  const token = (await cookies()).get(COOKIE_SESION)?.value;
  if (!token) return null;
  return usuarioDeSesion(await getDb(), token);
});

/** Usuario con sesión válida. Redirige a /login, o a /cambiar-clave si debe cambiar la clave inicial. */
export async function exigirSesion(opciones?: { permitirCambioClave?: boolean }): Promise<UsuarioSesion> {
  const u = await obtenerUsuario();
  if (!u) redirect('/login');
  if (u.debeCambiarPassword && !opciones?.permitirCambioClave) redirect('/cambiar-clave');
  return u;
}

export { tieneRol };

/** Para páginas: exige alguno de los roles o muestra la página de "sin permiso". */
export async function exigirRol(...roles: Rol[]): Promise<UsuarioSesion> {
  const u = await exigirSesion();
  if (!tieneRol(u, roles)) redirect('/sin-permiso');
  return u;
}

/** Para acciones de servidor: igual que exigirRol, pero lanza en vez de redirigir. */
export async function autorizar(...roles: Rol[]): Promise<UsuarioSesion> {
  const u = await obtenerUsuario();
  if (!u || u.debeCambiarPassword) throw new ErrorPermiso('Su sesión venció. Vuelva a iniciar sesión.');
  if (!tieneRol(u, roles)) throw new ErrorPermiso('No tiene permiso para esta operación.');
  return u;
}

export class ErrorPermiso extends Error {}
