import type { Rol } from './constantes';

/**
 * ¿Tiene el usuario alguno de los roles pedidos?
 * No hay superusuario implícito: el administrador configura el sistema pero no opera
 * contabilidad ni tesorería sin tener ese rol (segregación de funciones, §4.3).
 */
export function tieneRol(usuario: { roles: readonly string[] }, roles: readonly Rol[]): boolean {
  return usuario.roles.some((r) => (roles as readonly string[]).includes(r));
}
