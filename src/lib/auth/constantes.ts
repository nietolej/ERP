/** Compartido por proxy.ts y el servidor: sin dependencias de Node ni de la base. */
export const COOKIE_SESION = 'erp_sesion';

export const ROLES = [
  'administrador', 'gerencia', 'ventas', 'supervisor_ventas', 'facturacion', 'cobranzas',
  'compras', 'almacen', 'tesoreria', 'contabilidad', 'auditor',
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
  auditor: 'Auditor',
};
