# Estructura de módulos (estilo SAP)

El ERP se organiza en módulos con código de dos letras, como SAP. La navegación sale de un único mapa: [src/lib/modulos.ts](../src/lib/modulos.ts). Los procesos aún no construidos aparecen en gris con su fase (F2, F3…) y **no tienen pantalla**: se construyen en su fase según la §13 de la [especificación](spec_erp_hanei_motors.md), que es la fuente de verdad del detalle (§4.4).

| Código | Módulo | Equivale en SAP | Contenido | Fases |
|---|---|---|---|---|
| **SD** | Ventas y Distribución | SD, LE-SHP, LE-TRA | Clientes, vendedores, pedidos, notas de entrega, **picking con tiempos, transporte y despacho** (§6.4), facturas, NC/ND, devoluciones | 1, 2, 7 |
| **MM** | Gestión de Materiales | MM, IM | Productos, almacenes, proveedores, movimientos de inventario, compras, recepciones, facturas de proveedor, importaciones | 1, 2, 3 |
| **PP** | Producción | PP | Órdenes de producción o ensamblaje simples (§8.4) | 3 |
| **FI** | Contabilidad Financiera | FI (GL, AR, AP, AA) | Asientos, periodos, plan de cuentas, balance, CxC y cobros, CxP y pagos, **activos fijos** (§12.6), estados financieros, cierre | 0, 2, 3, 6 |
| **TR** | Tesorería y Bancos | FI-BL, TR | Bancos, cuentas bancarias y caja, gastos y caja chica, conciliación | 1, 3 |
| **CO** | Control de Gestión | CO | Metas de venta, planes de comisión, liquidación | 1, 6 |
| **CR** | CRM y Postventa | CRM | Prospectos, contactos, oportunidades, actividades y casos de postventa (§6.5) | 7 |
| **FX** | Fiscal Venezuela | Localización VE | Condición fiscal configurable (§11.0), parámetros fiscales, conceptos de ISLR, libros, retenciones de IVA e ISLR, IGTF | 0, 4 |
| **BI** | Reportes y Analítica | BW | Reportes M1–M6 del dashboard anterior y analítica avanzada | 2, 3, 8 |
| **BC** | Administración del Sistema | Basis, Business Workflow | Empresa, usuarios y roles, tasas de cambio, **auditoría** y **flujo de trabajo y aprobaciones** (§4.5) | 0, 1, 2 |

## Dónde quedó cada tema
| Tema | Dónde | Motivo |
|---|---|---|
| Activos fijos | FI (FI-AA) | SAP lo trata como submódulo de contabilidad financiera, no como módulo aparte |
| Producción | Módulo propio **PP** | SAP lo separa de MM; se define con órdenes simples (decisión 12) |
| Logística de salida (picking, transporte) | SD | Pedido del usuario; en SAP es Logistics Execution, aquí dentro de SD |
| CRM | Módulo propio **CR** | Tiene entidades y flujos propios (oportunidades, casos) que no encajan en SD |
| Auditoría | BC | Consulta de `audit_log` que ya existe en la base (Fase 0) |
| Flujo de trabajo y aprobaciones | BC | En SAP es un componente transversal de Basis; un solo motor para todos los módulos |

## Decisiones incorporadas (25-09-2026)
- **Condición fiscal configurable (decisión 3):** campos de `empresa`; retenciones, IGTF y calendario se activan según ellos.
- **Imprenta digital (decisión 4):** sin máquina fiscal. Falta elegir proveedor (decisión 13) y la dualidad Bs/USD (decisión 14).
- **Costo promedio ponderado (decisión 5):** uno por producto para toda la empresa.
- **Producción con órdenes simples (decisión 12).**

## Reglas
- **Datos maestros dentro del módulo dueño** (como en SAP): clientes y vendedores en SD; productos, almacenes y proveedores en MM.
- **Las rutas no cambian** (`/maestros/...`, `/contabilidad/...`, `/configuracion/...`); solo cambia cómo se agrupan en el menú.
- **Integración por documentos:** los módulos generan sus asientos en FI únicamente mediante el motor de reglas contables (§12.3). Ninguno escribe en el mayor directamente.
- **Fiscal separado:** FX concentra lo propio de Venezuela para que SD, MM y FI no lleven lógica fiscal dispersa.
- **Aprobaciones en un solo motor (BC):** los módulos no programan su propia aprobación; declaran su tipo de objeto y el motor decide quién aprueba según `flujo_paso`. Los triggers de cada módulo siguen como última barrera.
- **Roles:** cada ítem declara los roles que lo ven; el permiso real se sigue exigiendo en cada página y acción.
- Para agregar un proceso: añadir su ítem en `MODULOS` con `fase`; al construirlo, sustituir `fase` por `href`.

## Aún fuera de alcance
Listas de materiales y planificación de capacidad (PP), y campañas de marketing masivo dentro del CRM. Si se requieren, se agregan y se actualiza la especificación.
