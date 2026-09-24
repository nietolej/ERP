import type { Rol } from '@/lib/auth/constantes';

/** Roles que ven todos los clientes. Quien solo tiene Ventas ve su propia cartera (seguridad por fila). */
export const ROLES_VEN_TODOS: Rol[] = [
  'facturacion', 'gerencia', 'supervisor_ventas', 'cobranzas', 'contabilidad', 'jefe_contabilidad', 'auditor',
];
export const ROLES_VEN_CLIENTES: Rol[] = [...ROLES_VEN_TODOS, 'ventas'];
