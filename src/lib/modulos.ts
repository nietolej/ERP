import type { Rol } from '@/lib/auth/constantes';
import { ROLES_VEN_AUDITORIA } from '@/lib/auditoria';
import { ROLES_VEN_BANCOS } from '@/lib/maestros/bancos';
import { ROLES_VEN_METAS } from '@/lib/maestros/metas';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/roles';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { ROLES_VEN_AJUSTES, ROLES_VEN_EXISTENCIAS } from '@/lib/inventario/ajustes';
import { ROLES_VEN_DISPONIBILIDAD } from '@/lib/inventario/disponibilidad';
import { ROLES_MOTIVOS } from '@/lib/maestros/motivos';
import { ROLES_VEN_FACTURAS } from '@/lib/ventas/facturas';
import { ROLES_VEN_VENTAS } from '@/lib/ventas/pedidos';
import { ROLES_VEN_PICKING } from '@/lib/ventas/picking';
import { ROLES_VEN_PROMOCIONES } from '@/lib/ventas/promociones';
import { ROLES_VEN_TRANSPORTE } from '@/lib/ventas/transportes';
import { ROLES_VEN_TRANSPORTISTAS } from '@/lib/maestros/transportistas';

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
      { texto: 'Pedidos de venta', href: '/ventas/pedidos', roles: [...ROLES_VEN_VENTAS] },
      { texto: 'Notas de entrega', href: '/ventas/notas-entrega', roles: [...ROLES_VEN_VENTAS] },
      { texto: 'Picking y empaque', href: '/almacen/picking', roles: [...ROLES_VEN_PICKING] },
      { texto: 'Transportes y despachos', href: '/ventas/transportes', roles: [...ROLES_VEN_TRANSPORTE] },
      { texto: 'Transportistas y vehículos', href: '/maestros/transportistas', roles: [...ROLES_VEN_TRANSPORTISTAS] },
      { texto: 'Facturas de venta', href: '/ventas/facturas', roles: [...ROLES_VEN_FACTURAS] },
      { texto: 'Notas de crédito y débito', fase: 2 },
      { texto: 'Promociones', href: '/ventas/promociones', roles: [...ROLES_VEN_PROMOCIONES] },
      { texto: 'Ventas perdidas', href: '/ventas/perdidas', roles: [...ROLES_VEN_VENTAS] },
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
      { texto: 'Existencias', href: '/inventario/existencias', roles: [...ROLES_VEN_EXISTENCIAS] },
      { texto: 'Ajustes de inventario', href: '/inventario/ajustes', roles: [...ROLES_VEN_AJUSTES] },
      { texto: 'Disponibilidad y velocidad de venta', href: '/reportes/inventario', roles: [...ROLES_VEN_DISPONIBILIDAD] },
      { texto: 'Kardex de movimientos', fase: 2 },
      { texto: 'Órdenes de compra', href: '/compras/ordenes', roles: [...ROLES_VEN_COMPRAS] },
      { texto: 'Recepciones de mercancía', href: '/compras/recepciones', roles: [...ROLES_VEN_COMPRAS] },
      { texto: 'Facturas de proveedor', href: '/compras/facturas', roles: [...ROLES_VEN_COMPRAS] },
      { texto: 'Gastos de importación y costo en destino', href: '/compras/gastos', roles: [...ROLES_VEN_COMPRAS] },
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
      { texto: 'Cuentas por pagar', href: '/compras/cuentas-por-pagar', roles: [...ROLES_VEN_COMPRAS] },
      { texto: 'Pagos a proveedores', fase: 3 },
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
      { texto: 'Configuración de metas', href: '/metas', roles: ROLES_VEN_METAS },
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
      { texto: 'Auditoría', href: '/configuracion/auditoria', roles: ROLES_VEN_AUDITORIA },
      { texto: 'Motivos (descuentos, anulaciones…)', href: '/configuracion/motivos', roles: [...ROLES_MOTIVOS] },
      { texto: 'Bandeja de aprobaciones', href: '/aprobaciones' },
      { texto: 'Definición de flujos', href: '/configuracion/flujos', roles: ['administrador', 'gerencia', 'auditor'] },
    ],
  },
];
