# Estructura de módulos (estilo SAP)

El ERP se organiza en módulos con código de dos letras, como SAP. La navegación sale de un único mapa: [src/lib/modulos.ts](../src/lib/modulos.ts). Los procesos aún no construidos aparecen en gris con su fase (F2, F3…) y **no tienen pantalla**: se construyen en su fase según la §13 de la [especificación](spec_erp_hanei_motors.md).

| Código | Módulo | Equivale en SAP | Contenido | Fases |
|---|---|---|---|---|
| **SD** | Ventas y Distribución | SD | Clientes, vendedores, pedidos, notas de entrega, facturas, NC/ND, devoluciones, portal de clientes | 1, 2, 7 |
| **MM** | Gestión de Materiales | MM / IM / WM | Productos, almacenes, proveedores, movimientos de inventario, órdenes de compra, recepciones, facturas de proveedor, importaciones | 1, 2, 3 |
| **FI** | Contabilidad Financiera | FI (GL, AR, AP) | Asientos, periodos, plan de cuentas, balance, CxC y cobros, CxP y pagos, estados financieros, cierre | 0, 2, 3, 6 |
| **TR** | Tesorería y Bancos | FI-BL / TR | Bancos, cuentas bancarias y caja, gastos y caja chica, conciliación | 1, 3 |
| **CO** | Control de Gestión | CO | Metas de venta, planes de comisión, liquidación | 1, 6 |
| **FX** | Fiscal Venezuela | Localización VE | Parámetros fiscales, conceptos de ISLR, libros, retenciones de IVA e ISLR, IGTF | 0, 4 |
| **BI** | Reportes y Analítica | BW / Analytics | Reportes M1–M6 del dashboard anterior y analítica avanzada | 2, 3, 8 |
| **BC** | Administración del Sistema | Basis | Empresa, usuarios y roles, tasas de cambio, auditoría | 0 |

## Reglas
- **Datos maestros dentro del módulo dueño** (como en SAP): clientes y vendedores en SD; productos, almacenes y proveedores en MM.
- **Las rutas no cambian** (`/maestros/...`, `/contabilidad/...`, `/configuracion/...`); solo cambia cómo se agrupan en el menú.
- **Integración por documentos:** SD y MM generan sus asientos en FI únicamente mediante el motor de reglas contables (§12.3). Ningún módulo escribe en el mayor directamente.
- **Fiscal separado:** FX concentra lo propio de Venezuela para que SD, MM y FI no lleven lógica fiscal dispersa.
- **Roles:** cada ítem declara los roles que lo ven; el permiso real se sigue exigiendo en cada página y acción.
- Para agregar un proceso: añadir su ítem en `MODULOS` con `fase`; al construirlo, sustituir `fase` por `href`.

## Fuera de la especificación actual
Activos fijos (FI-AA), producción o ensamblaje (PP; decisión 12 pendiente), y CRM/postventa no están en la hoja de ruta. Si Gerencia los requiere, se agregan como módulo o ítem nuevo y se actualiza la especificación.
