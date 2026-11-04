import type { Rol } from '@/lib/auth/constantes';

/** Roles de gastos y caja chica (spec §10.1), aparte para que los adjuntos puedan usarlos sin dependencias circulares. */
export const ROLES_REGISTRAN_GASTO = ['compras', 'contabilidad', 'tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_GASTOS = ['compras', 'gerencia', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];
export const ROLES_CATEGORIAS = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];

export const ROLES_VEN_CAJA = ['tesoreria', 'contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];
/** Un custodio necesita uno de estos roles para entrar a la pantalla de su fondo. */
export const ROLES_CUSTODIO = ['tesoreria', 'contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_SOLICITAN_REPOSICION = ['tesoreria', 'gerencia'] as const satisfies readonly Rol[];
