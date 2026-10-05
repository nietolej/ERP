/** Compartido por proxy.ts y el servidor: sin dependencias de Node ni de la base. */
export const COOKIE_SESION = 'erp_sesion';

export const ROLES = [
  'administrador', 'gerencia', 'ventas', 'supervisor_ventas', 'facturacion', 'cobranzas',
  'compras', 'almacen', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor',
] as const;

export type Rol = (typeof ROLES)[number];

export const NOMBRE_ROL: Record<Rol, string> = {
  administrador: 'Administrador',
  gerencia: 'Gerencia',
  ventas: 'Ventas',
  supervisor_ventas: 'Supervisor de ventas',
  facturacion: 'Facturación',
  cobranzas: 'Cobranzas',
  compras: 'Compras',
  almacen: 'Almacén',
  tesoreria: 'Tesorería',
  contabilidad: 'Contabilidad',
  jefe_contabilidad: 'Jefe de contabilidad',
  auditor: 'Auditor',
};

/** Cookie del usuario elegido en el modo sin login (solo desarrollo). */
export const COOKIE_USUARIO_DEV = 'erp_dev_usuario';

/**
 * Modo sin inicio de sesión, SOLO para desarrollo local: ERP_SIN_LOGIN=1 y nunca con NODE_ENV=production.
 * Ver src/lib/auth/modo-desarrollo.ts.
 */
export function sinLogin(): boolean {
  return process.env.ERP_SIN_LOGIN === '1' && process.env.NODE_ENV !== 'production';
}
