import type { Rol } from '@/lib/auth/constantes';
import { ROLES_VEN_BANCOS } from '@/lib/maestros/bancos';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/roles';

/**
 * Mapa de módulos del ERP, al estilo SAP. Es la única fuente de la navegación:
 * un módulo agrupa procesos y datos maestros de un área de negocio.
 * Ver docs/estructura_modulos.md. Las rutas existentes no cambian.
 */

export interface ItemModulo {
  texto: string;
  /** Sin `href` el proceso está planificado y aún no se construye. */
  href?: string;
  /** Fase de la hoja de ruta (§13) en que se entrega, si aún no existe. */
  fase?: number;
  roles?: Rol[]; // si se indica, solo se muestra a esos roles
}

export interface Modulo {
  codigo: string;
  nombre: string;
  descripcion: string;
  items: ItemModulo[];
}

/** Todos los roles salvo el administrador, que configura el sistema pero no opera. */
export const OPERATIVOS: Rol[] = ['ventas', 'supervisor_ventas', 'facturacion', 'cobranzas', 'compras', 'almacen', 'gerencia', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor'];
export const CONTABLES: Rol[] = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'];
const ROLES_COMPRAS: Rol[] = ['compras', 'gerencia', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor'];

export const MODULOS: Modulo[] = [
  {
    codigo: 'SD',
    nombre: 'Ventas y Distribución',
    descripcion: 'Del pedido al cobro (Order-to-Cash): clientes, vendedores, pedidos, entregas y facturación.',
    items: [
      { texto: 'Clientes', href: '/maestros/clientes', roles: ROLES_VEN_CLIENTES },
      { texto: 'Vendedores', href: '/maestros/vendedores', roles: ROLES_VEN_TODOS },
      { texto: 'Pedidos de venta', fase: 2 },
      { texto: 'Notas de entrega', fase: 2 },
      { texto: 'Picking y empaque', fase: 2 },
      { texto: 'Transportes y despachos', fase: 2 },
      { texto: 'Facturas de venta', fase: 2 },
      { texto: 'Notas de crédito y débito', fase: 2 },
      { texto: 'Devoluciones', fase: 2 },
      { texto: 'Portal de clientes', fase: 7 },
    ],
  },
  {
    codigo: 'MM',
    nombre: 'Gestión de Materiales',
    descripcion: 'Compras (Procure-to-Pay), productos, almacenes e inventario con costo promedio.',
    items: [
      { texto: 'Productos', href: '/maestros/productos', roles: OPERATIVOS },
      { texto: 'Almacenes', href: '/maestros/almacenes', roles: OPERATIVOS },
      { texto: 'Proveedores', href: '/maestros/proveedores', roles: ROLES_COMPRAS },
      { texto: 'Movimientos de inventario', fase: 2 },
      { texto: 'Órdenes de compra', fase: 3 },
      { texto: 'Recepciones de mercancía', fase: 3 },
      { texto: 'Facturas de proveedor', fase: 3 },
      { texto: 'Importaciones y costo en destino', fase: 3 },
    ],
  },
  {
    codigo: 'PP',
    nombre: 'Producción',
    descripcion: 'Órdenes de producción o ensamblaje simples, sin listas de materiales.',
    items: [{ texto: 'Órdenes de producción', fase: 3 }],
  },
  {
    codigo: 'FI',
    nombre: 'Contabilidad Financiera',
    descripcion: 'Mayor general, periodos, auxiliares de cuentas por cobrar y por pagar, y estados financieros.',
    items: [
      { texto: 'Asientos contables', href: '/contabilidad/asientos', roles: CONTABLES },
      { texto: 'Balance de comprobación', href: '/contabilidad/balance', roles: CONTABLES },
      { texto: 'Periodos contables', href: '/contabilidad/periodos', roles: CONTABLES },
      { texto: 'Plan de cuentas', href: '/contabilidad/plan-de-cuentas', roles: CONTABLES },
      { texto: 'Cuentas por cobrar y cobros', fase: 2 },
      { texto: 'Cuentas por pagar y pagos', fase: 3 },
      { texto: 'Activos fijos y depreciación', fase: 6 },
      { texto: 'Estados financieros', fase: 6 },
      { texto: 'Cierre mensual', fase: 6 },
    ],
  },
  {
    codigo: 'TR',
    nombre: 'Tesorería y Bancos',
    descripcion: 'Bancos, cuentas bancarias, caja chica, gastos y conciliación.',
    items: [
      { texto: 'Bancos', href: '/maestros/bancos', roles: ROLES_VEN_BANCOS },
      { texto: 'Cuentas bancarias y caja', fase: 3 },
      { texto: 'Gastos y caja chica', fase: 3 },
      { texto: 'Conciliación bancaria', fase: 3 },
    ],
  },
  {
    codigo: 'CO',
    nombre: 'Control de Gestión',
    descripcion: 'Metas de venta y comisiones.',
    items: [
      { texto: 'Configuración de metas', href: '/metas' },
      { texto: 'Planes de comisión', fase: 6 },
      { texto: 'Liquidación de comisiones', fase: 6 },
    ],
  },
  {
    codigo: 'CR',
    nombre: 'CRM y Postventa',
    descripcion: 'Prospectos, contactos, oportunidades, actividades y casos de postventa.',
    items: [
      { texto: 'Prospectos y contactos', fase: 7 },
      { texto: 'Oportunidades', fase: 7 },
      { texto: 'Actividades y visitas', fase: 7 },
      { texto: 'Casos de postventa', fase: 7 },
    ],
  },
  {
    codigo: 'FX',
    nombre: 'Fiscal Venezuela',
    descripcion: 'Condición fiscal configurable, parámetros fiscales, libros, retenciones de IVA e ISLR e IGTF.',
    items: [
      { texto: 'Parámetros fiscales', href: '/configuracion/parametros-fiscales', roles: CONTABLES },
      { texto: 'Conceptos de ISLR', href: '/configuracion/conceptos-islr', roles: [...CONTABLES, 'compras'] },
      { texto: 'Libros de compras y ventas', fase: 4 },
      { texto: 'Retenciones de IVA e ISLR', fase: 4 },
      { texto: 'IGTF', fase: 4 },
    ],
  },
  {
    codigo: 'BI',
    nombre: 'Reportes y Analítica',
    descripcion: 'Reportes equivalentes al dashboard anterior (spec_reportes) y analítica avanzada.',
    items: [
      { texto: 'Inicio', href: '/' },
      { texto: 'Clientes (M1)', href: '/reportes/clientes' },
      { texto: 'Productos (M2)', href: '/reportes/productos' },
      { texto: 'Vendedores (M3)', href: '/reportes/vendedores' },
      { texto: 'Cobranzas (M4)', href: '/reportes/cobranzas' },
      { texto: 'Devoluciones (M5)', href: '/reportes/devoluciones' },
      { texto: 'Inventario (M6)', href: '/reportes/inventario' },
      { texto: 'Analítica avanzada', fase: 8 },
    ],
  },
  {
    codigo: 'BC',
    nombre: 'Administración del Sistema',
    descripcion: 'Empresa y condición fiscal, usuarios y roles, tasas de cambio, auditoría y flujo de trabajo.',
    items: [
      { texto: 'Tasas de cambio', href: '/configuracion/tasas', roles: ['tesoreria', ...CONTABLES] },
      { texto: 'Empresa y sucursales', href: '/configuracion/empresa', roles: ['administrador'] },
      { texto: 'Usuarios y roles', href: '/configuracion/usuarios', roles: ['administrador'] },
      { texto: 'Auditoría', fase: 1, roles: ['administrador', 'auditor', 'gerencia'] },
      { texto: 'Bandeja de aprobaciones', fase: 2 },
      { texto: 'Definición de flujos', fase: 2, roles: ['administrador', 'gerencia'] },
    ],
  },
];
