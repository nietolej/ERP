# Especificación Funcional y Técnica: ERP Distribuciones Hanei Motors

> **Propósito.** Este documento define un ERP **nuevo e independiente** para Distribuciones Hanei Motors: maestros, ventas, compras, inventario, comisiones, gastos, tesorería, contabilidad, fiscal y estados financieros. Está pensado para que un equipo, o un agente de desarrollo, lo construya por fases.
>
> **Proyecto separado.** El ERP tiene **su propio repositorio, su propia base de datos, sus propios usuarios y su propio despliegue**. No comparte código, tablas, credenciales ni procesos con el dashboard de ventas actual, con su base PostgreSQL/Supabase, con el sistema DBF ni con los archivos `.txt` exportados. **No hay migración de datos:** la base de datos arranca vacía y se llena con la operación diaria (ventas, compras, cobros, pagos, gastos) desde la fecha de arranque (§14).
>
> **Documentos relacionados.** Reportes e indicadores (réplica del dashboard) en [`spec_reportes.md`](spec_reportes.md); reglas de desarrollo en [`../AGENTS.md`](../AGENTS.md); registro de decisiones de la §16 en [`decisiones.md`](decisiones.md); mapa de módulos estilo SAP en [`estructura_modulos.md`](estructura_modulos.md).
>
> **Cómo usarlo.** Construye en el orden de la §13 (Hoja de ruta). Cada módulo trae entidades, procesos, reglas de negocio, asientos contables y criterios de aceptación. Las tasas fiscales y los porcentajes **nunca se escriben en el código**: van en tablas de parámetros (§4.2). Usa la versión estable más reciente del framework elegido y consulta su documentación oficial antes de escribir código.
>
> **Aviso fiscal.** La normativa venezolana cambia por providencia administrativa. Las reglas de la §11 reflejan lo investigado a septiembre de 2026 y **deben validarse con el contador y el asesor tributario** antes de salir a producción.

---

## Índice

1. [Punto de partida: qué se toma de la operación actual](#1-punto-de-partida-qué-se-toma-de-la-operación-actual)
2. [Lecciones de la auditoría convertidas en requisitos](#2-lecciones-de-la-auditoría-convertidas-en-requisitos)
3. [Principios de diseño (mejores prácticas)](#3-principios-de-diseño-mejores-prácticas)
4. [Arquitectura y módulos transversales](#4-arquitectura-y-módulos-transversales)
5. [Datos maestros](#5-datos-maestros)
6. [Ventas: del pedido al cobro (Order-to-Cash)](#6-ventas-del-pedido-al-cobro-order-to-cash)
7. [Compras: de la orden al pago (Procure-to-Pay)](#7-compras-de-la-orden-al-pago-procure-to-pay)
8. [Inventario y costos](#8-inventario-y-costos)
9. [Comisiones de venta](#9-comisiones-de-venta)
10. [Gastos, tesorería y bancos](#10-gastos-tesorería-y-bancos)
11. [Módulo fiscal Venezuela](#11-módulo-fiscal-venezuela)
12. [Contabilidad general y estados financieros](#12-contabilidad-general-y-estados-financieros)
13. [Hoja de ruta por fases](#13-hoja-de-ruta-por-fases)
14. [Arranque operativo (sin migración)](#14-arranque-operativo-sin-migración)
15. [Requisitos no funcionales](#15-requisitos-no-funcionales)
16. [Decisiones abiertas](#16-decisiones-abiertas)
17. [Fuentes](#17-fuentes)

---

## 1. Punto de partida: qué se toma de la operación actual

### 1.1 Separación total

```mermaid
flowchart LR
  subgraph ACTUAL["Sistemas actuales (siguen como están)"]
    DBF["Sistema administrativo DBF"] --> TXT["Exportación .txt"] --> BI["Dashboard de ventas"]
  end
  subgraph NUEVO["ERP nuevo (este documento)"]
    OPS["Operación diaria:\nventas, compras, cobros,\npagos, gastos, inventario"] --> DBN[("Base de datos propia\n(nace vacía)")]
    DBN --> REP["Reportes y estados\nfinancieros propios"]
  end
  ACTUAL -. "solo conocimiento del negocio\n(sin datos, sin conexión)" .-> NUEVO
```

- **No se lee ni se escribe** nada de los sistemas actuales: ni el DBF, ni los `.txt`, ni la base PostgreSQL/Supabase del dashboard.
- **No se reutilizan tablas, usuarios ni lógica de datos** del dashboard. El ERP define su propio modelo desde cero, con las reglas de este documento.
- **Sí se replica su presentación:** el ERP muestra la información con los mismos módulos, pantallas e indicadores del dashboard ([spec_reportes.md](spec_reportes.md)), y sus componentes visuales pueden copiarse y adaptarse.
- Lo único que se toma de la operación actual es **conocimiento**: cómo trabaja el negocio (§1.2 y §1.3) y los errores de datos que no deben repetirse (§2).
- El dashboard actual puede seguir funcionando para consultar el histórico previo al arranque. Los dos sistemas no se conectan.

### 1.2 Procesos del negocio que el ERP debe cubrir

Este inventario sale de analizar la operación que hoy registra el sistema DBF. Sirve para no olvidar ningún proceso, **no** como mapa de migración.

| Proceso del negocio | Módulo del ERP | Aprendizaje de la operación actual |
|---|---|---|
| Clientes | Maestros (§5.1) | Hoy un cliente "inactivo" se marca asignándole el vendedor `00`, y algunos RIF están incompletos. El ERP necesita un estado propio y un RIF validado |
| Proveedores | Maestros (§5.1) | Una misma empresa puede ser cliente y proveedor: se modela como un solo tercero por RIF |
| Vendedores | Maestros (§5.2) | Conviven vendedores reales con códigos administrativos y de "casa". El ERP necesita un tipo de vendedor explícito |
| Productos, grupos (modelo de vehículo) y marcas | Maestros (§5.3) | Tres listas de precio (A, B, D). El costo no debe salir de una lista de precios |
| Referencias cruzadas de repuestos | Maestros (§5.3) | Clave para buscar equivalencias entre fabricantes |
| Almacenes | Maestros (§5.3) | Hay almacenes comerciales (venta) y otros (depósito, tránsito) |
| Pedidos, notas de entrega y facturas | Ventas (§6) | Las anulaciones deben quedar explícitas y los montos guardados al emitir |
| Devoluciones y notas de crédito | Ventas (§6) | Cada NC debe guardar su monto y referenciar la factura de origen |
| Cobranzas, descuento por pronto pago y retenciones | CxC (§6.3) | El descuento por pronto pago es fuerte (10 % a 25 %, el más común 20 %) y se aplica con nota de crédito |
| Pagos a proveedores | CxP (§7.3) | Deben ir en un libro separado de los cobros de clientes |
| Órdenes de compra, tránsito, recepciones e importaciones | Compras (§7) | La mercancía en tránsito y la pendiente de producción deben controlarse por cantidad pendiente |
| Movimientos de inventario | Inventario (§8) | Entradas, salidas, devoluciones, transferencias y aperturas |
| Bancos y cuentas en divisas | Tesorería (§10) | Cobros en bancos nacionales, cuentas en el exterior, custodia y USDT |
| Metas de venta | Maestros (§5.4) y comisiones (§9) | Deben ser datos cargados y aprobados, nunca valores supuestos |

### 1.3 Contexto del negocio que el ERP debe respetar

- **Rubro:** distribución de repuestos automotrices (Hyundai, Kia y otros), con catálogo organizado por modelo de vehículo (grupo) y marca.
- **Sedes:** Barquisimeto y Caracas, cada una con sus almacenes, vendedores y series de numeración. El ERP las modela como `sucursal`.
- **Dos monedas en la operación diaria:** se vende y se cobra en USD y en Bs, con cobros en bancos nacionales, cuentas en el exterior, efectivo y USDT.
- **Condiciones comerciales:** tres niveles de precio (A, B y D), descuento por pronto pago mediante nota de crédito y crédito típico a 30 días.
- **Importaciones:** compras internacionales con seguimiento de embarque (BL, naviera, ETA) y reparto de gastos de nacionalización al costo.
- **Clientes que hacen pedidos a distancia** y envían comprobantes de pago. Un portal de clientes puede ser una fase futura del propio ERP (§13).

---

## 2. Lecciones de la auditoría convertidas en requisitos

La auditoría del dashboard actual (septiembre de 2026) encontró errores que no daban ninguna señal y que venían de **datos mal modelados en el sistema de origen**. El ERP no toma esos datos, pero sí la lección: cada error se convierte aquí en un requisito de diseño:

| # | Problema encontrado | Requisito del ERP |
|---|---|---|
| L1 | No existe marca de anulación: las facturas anuladas se contaban como ventas | **R1.** Todo documento tiene `estado` explícito (`borrador` → `emitido` → `anulado`) con motivo, usuario y fecha de anulación. Nunca se borra un documento emitido |
| L2 | El mismo cliente aparece como `631` y como `00000631`, y el vendedor como `2` y como `02` | **R2.** Claves internas `uuid` con llaves foráneas. El código visible es único, con formato validado (`CHECK`) y nunca se reescribe |
| L3 | Fechas en `YYYYMMDD` y `D/M/YYYY` en archivos distintos | **R3.** Tipo `date`/`timestamptz` en base de datos. Prohibido guardar fechas como texto |
| L4 | La moneda se deducía del formato del número de documento (numérico = Bs) | **R4.** Cada documento guarda `moneda`, `tasa` y montos en la moneda original, en VES y en USD (§3.4) |
| L5 | Pagos a proveedores mezclados con cobros de clientes | **R5.** Libros auxiliares separados (CxC y CxP), con `tercero` tipado por rol |
| L6 | Tasas distintas para el mismo día entre archivos (702 contra ~330 el 07-01-2026) | **R6.** Una sola tabla `tasa_cambio` por fecha y fuente. Cada documento copia la tasa que usó y queda congelada |
| L7 | Exportaciones solapadas: un mismo movimiento aparecía dos veces | **R7.** Una sola base de datos transaccional donde cada operación se registra una vez. Los reportes leen vistas, no archivos exportados |
| L8 | Metas en `.txt` y metas fijas en el código ($15.000 por vendedor) | **R8.** Metas en tablas, con versión y responsable. Si no hay meta, se muestra "sin meta" |
| L9 | Datos simulados que se mostraban como reales | **R9.** Prohibido mostrar datos de relleno. Ante error se muestra un estado de error |
| L10 | Monto de devolución en 0; columnas con otro nombre (`penddesp`) | **R10.** Los montos se calculan y guardan al emitir el documento. Los esquemas se validan en la importación |
| L11 | Sin autenticación en ninguna ruta; los datos personales de clientes eran públicos | **R11.** Autenticación obligatoria, control de acceso por roles y seguridad a nivel de fila (§4.3) |
| L12 | Clientes inactivos definidos por "vendedor = 00" | **R12.** `estado` del cliente (`activo`, `inactivo`, `bloqueado`) independiente del vendedor |

---

## 3. Principios de diseño (mejores prácticas)

### 3.1 Fuente única de verdad y documentos antes que asientos
- Cada hecho económico nace como un **documento de negocio** (factura, cobro, recepción, gasto). El **asiento contable se genera automáticamente** al emitirlo, a partir de reglas configurables (§12.3).
- Los usuarios operativos no escriben asientos. Los asientos manuales quedan para Contabilidad (ajustes, provisiones, cierres) y requieren aprobación: se registran como borrador, en una sola moneda convertida a VES y USD con la tasa BCV de su fecha, y se contabilizan (reciben número) cuando los aprueba un usuario con el rol Jefe de contabilidad distinto de quien los registró. La base de datos rechaza la contabilización sin esa aprobación.

### 3.2 Partida doble e inmutabilidad
- Todo asiento cuadra: suma del debe = suma del haber. Lo garantiza la **base de datos**, no solo la aplicación.
- **Un asiento contabilizado no se edita ni se borra.** Se corrige con un asiento de reverso dentro de un periodo abierto. Así el rastro de auditoría queda completo y los balances históricos se pueden reproducir.
- Cada periodo contable tiene uno de tres estados: `abierto` (acepta todo), `cerrado` (solo reversos y ajustes autorizados) o `bloqueado` (inmutable tras la auditoría o la declaración). El bloqueo se aplica con un *trigger* de base de datos.

### 3.3 Numeración y trazabilidad
- Numeración **correlativa, sin huecos y por serie** (tipo de documento + sucursal), asignada dentro de la transacción con bloqueo de fila. Un documento anulado conserva su número.
- Cadena de documentos enlazada: cotización → pedido → nota de entrega → factura → nota de crédito. Orden de compra → recepción → factura de compra → pago. Desde cualquier línea del mayor se llega al documento que la originó y viceversa.
- Registro de auditoría de toda creación, cambio de estado, aprobación y anulación: quién, cuándo, desde qué IP y el valor anterior y el nuevo.

### 3.4 Multimoneda (VES legal, USD de gestión)
- **Moneda funcional legal: bolívar (VES).** Los libros legales y las declaraciones se llevan en VES según VEN-NIF.
- **Moneda de gestión: USD.** El negocio fija precios, metas y comisiones en USD.
- Cada documento y cada línea de asiento guarda **tres importes**: moneda original, VES (a la tasa del documento) y USD (a la misma tasa). La tasa se copia al documento al emitirlo y **no cambia después**.
- Las diferencias de tasa entre la factura y su cobro o pago se registran como **diferencial cambiario** en cuentas separadas de ganancia y de pérdida, que se muestran como partida aparte en el estado de resultados.
- La tasa oficial BCV se carga a diario por un proceso automático, con histórico completo. Si se usa una tasa paralela para análisis de gestión (por ejemplo, en el costeo de importaciones), va como otra **fuente** en la misma tabla, y **nunca** para registros legales.

### 3.5 Parametrización fiscal
- Alícuotas de IVA, porcentajes de retención, IGTF, valor de la Unidad Tributaria, tabla del Decreto 1.808 y formatos de comprobante: todo vive en tablas con **vigencia por fecha** (`vigente_desde`, `vigente_hasta`). Un cambio de normativa se resuelve con una fila nueva, sin tocar el código.

### 3.6 Segregación de funciones y control interno
- Quien crea un proveedor no aprueba sus pagos. Quien emite facturas no aplica cobros. Quien registra asientos manuales no los aprueba.
- Tolerancias y límites configurables: límite de crédito, descuento máximo por rol y tolerancia de conciliación en compras (p. ej. 2 %).

### 3.7 Reportes: la misma información que el dashboard, con datos propios
- El ERP **muestra la información igual que el dashboard de ventas desarrollado anteriormente**: los mismos módulos (Inicio, Clientes, Productos, Vendedores, Cobranzas, Devoluciones, Inventario y Metas), pestañas, indicadores, gráficos, tablas, filtros y exportaciones. Todo se detalla pantalla por pantalla en **[spec_reportes.md](spec_reportes.md)**.
- Los datos salen de **vistas SQL** de la base del ERP. No hay conexión con el dashboard, su base de datos ni los `.txt`.
- Las fórmulas son las del dashboard **con las correcciones de la auditoría** (spec_reportes §11).
- Los indicadores muestran información desde la fecha de arranque. Las comparaciones interanuales estarán disponibles cuando se acumulen 12 meses de operación.

---

## 4. Arquitectura y módulos transversales

### 4.1 Arquitectura propuesta

```mermaid
flowchart TB
  subgraph UI["Aplicación web del ERP (repositorio nuevo)"]
    ERPUI["Operación: ventas y logística, compras,\ninventario, producción, CRM, tesorería, contabilidad"]
    REPUI["Reportes, indicadores y\nestados financieros"]
    B2B["Portal de clientes\n(fase futura, opcional)"]
  end
  subgraph DOM["Capa de dominio (server actions / route handlers)"]
    SVC["Servicios por módulo\n(validaciones, flujos de estado)"]
    POST["Motor de contabilización\n(reglas → asientos)"]
    FIS["Servicio fiscal\n(IVA, retenciones, IGTF, libros)"]
  end
  subgraph DB["PostgreSQL propio (instancia nueva, nace vacía)"]
    TX[("Tablas transaccionales")]
    GL[("Mayor: asientos, periodos")]
    V[("Vistas de reportes")]
    RLS["Seguridad por fila + triggers de integridad"]
  end
  JOBS["Procesos programados:\ntasa BCV diaria, recurrentes,\nrecordatorios de vencimiento"] --> DB
  IMP["Imprenta digital autorizada\n(API, números de control)"] <--> FIS
  UI --> DOM --> DB
```

- **Proyecto nuevo e independiente:** repositorio, base de datos, usuarios, credenciales y despliegue propios. Ningún proceso lee ni escribe en los sistemas actuales (dashboard, Supabase, DBF, `.txt`).
- **Monolito modular:** una sola aplicación organizada por los módulos de la §4.4 (SD, MM, PP, FI, TR, CO, CR, FX, BI, BC), más fácil de mantener que microservicios para el tamaño de la empresa.
- **Stack sugerido:** aplicación web en TypeScript (por ejemplo Next.js, en su versión estable más reciente) y **PostgreSQL** en una instancia nueva, administrada o propia. Las reglas de integridad (cuadre del asiento, periodo cerrado, numeración, montos no negativos) van en **restricciones y triggers**, además de la validación en la aplicación.
- **Migraciones de esquema versionadas** (herramienta de migraciones del stack) desde el primer día: la base de datos se crea solo con scripts del repositorio, nunca a mano.
- Todas las escrituras de un documento (documento, líneas, movimientos de inventario, asiento y partidas abiertas) ocurren en **una sola transacción**.
- Operaciones **idempotentes**: contabilizar dos veces el mismo documento no duplica el asiento (restricción única `(origen_tipo, origen_id)`).

### 4.2 Configuración general
| Entidad | Contenido |
|---|---|
| `empresa` | RIF, razón social, domicilio fiscal y la **condición fiscal configurable** (§11.0): si es contribuyente especial y si es agente de retención de IVA, de retención de ISLR o de percepción de IGTF |
| `sucursal` | Barquisimeto, Caracas…; series de numeración propias |
| `moneda`, `tasa_cambio` | VES, USD (y EUR, USDT si se aceptan); tasa diaria por fuente |
| `parametro_fiscal` | Alícuotas, porcentajes y UT con vigencia (§11) |
| `numerador` | Serie, tipo de documento, sucursal, próximo número, prefijo |
| `condicion_pago` | Contado, 15, 30 o 45 días; descuento por pronto pago asociado |
| `instrumento_pago` | Transferencia en Bs, pago móvil, efectivo USD, Zelle, USDT, punto de venta, cheque; indica si genera IGTF |
| `adjunto` | Archivos de soporte (comprobantes de pago, facturas de proveedor, soportes de gastos): PDF, PNG, JPG o WebP de hasta 5 MB, reconocidos por su contenido. Los bytes van en una carpeta de almacenamiento propia (`ADJUNTOS_DIR`), fuera de la carpeta pública, y se sirven solo por `/api/adjuntos/[id]` con los mismos permisos del registro (incluida la seguridad por fila). Guarda huella SHA-256 (se verifica al leer), tamaño, tipo, usuario y fecha. No se edita ni se borra: se anula con motivo, y el archivo se conserva. Se enlaza a un cliente, proveedor o producto; los documentos se agregan en sus fases |

### 4.3 Seguridad, roles y auditoría
- **Usuarios propios del ERP** (tabla `usuario`), con **autenticación** obligatoria en todas las rutas, incluidas las rutas API.
- **Límite de intentos de inicio de sesión:** 5 intentos fallidos con un mismo correo en 15 minutos, o 30 desde una misma dirección IP, bloquean el acceso hasta que venza la ventana. El bloqueo aplica igual a correos inexistentes (no revela qué correos están registrados), un acceso correcto reinicia el contador del correo y cada bloqueo de un usuario queda en `audit_log`. La tabla `intento_fallido` guarda solo el hash del correo o de la IP.
- **Roles base:** Administrador, Gerencia, Ventas (vendedor), Supervisor de ventas, Facturación, Cobranzas, Compras, Almacén, Tesorería, Contabilidad, Jefe de contabilidad (aprueba asientos manuales), Auditor (solo lectura) y, si se construye el portal, Cliente.
- **Seguridad por fila:** un vendedor ve solo su cartera, un cliente del portal solo sus documentos, y el almacén solo los almacenes que tiene asignados (`usuario_almacen`).
- **Matriz de segregación de funciones (mínima):**

| Acción | Crea | Aprueba | Nunca la misma persona que… |
|---|---|---|---|
| Alta o cambio de proveedor y de sus cuentas bancarias | Compras | Gerencia | …aprueba pagos |
| Orden de compra | Compras | Gerencia (según monto) | …recibe la mercancía |
| Pago a proveedor | Tesorería | Gerencia | …crea el proveedor |
| Nota de crédito comercial | Ventas | Supervisor | …la emite para su propio cliente sin aprobación |
| Asiento manual | Contabilidad | Jefe de contabilidad | …lo registró |
| Ajuste de inventario | Almacén | Gerencia | …hizo el conteo |
| Liquidación de comisiones | Sistema | Gerencia | …es el vendedor beneficiario |

- **`audit_log`**: se escribe por trigger en las tablas críticas, con estado anterior y nuevo en `jsonb`.
  - **Consulta** (Administrador, Auditor y Gerencia): pantalla de solo lectura en Configuración → Auditoría, del más reciente al más antiguo, con filtros por fecha, usuario, entidad, acción y registro (historial de un registro), y el detalle campo por campo de lo que cambió. Los filtros nunca son texto libre sobre el contenido, para que ningún dato personal viaje en la dirección de la página.

```sql
create table usuario (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  nombre        text not null,
  password_hash text not null,                     -- o proveedor de identidad externo
  debe_cambiar_password boolean not null default true,
  activo        boolean not null default true,
  ultimo_acceso timestamptz,
  created_at    timestamptz not null default now()
);
create table rol (codigo text primary key, nombre text not null);
create table usuario_rol (usuario_id uuid references usuario(id), rol text references rol(codigo), primary key (usuario_id, rol));
create table usuario_almacen (usuario_id uuid references usuario(id), almacen_id uuid references almacen(id), primary key (usuario_id, almacen_id));
create table audit_log (
  id bigint generated always as identity primary key,
  usuario_id uuid, accion text not null, entidad text not null, entidad_id text,
  antes jsonb, despues jsonb, ip inet, created_at timestamptz not null default now()
);
```

### 4.4 Estructura de módulos (estilo SAP)
La aplicación se organiza en módulos con código de dos letras. La navegación sale de un único mapa (`src/lib/modulos.ts`) y el detalle está en [estructura_modulos.md](estructura_modulos.md).

| Código | Módulo | Contenido | Sección |
|---|---|---|---|
| **SD** | Ventas y Distribución | Clientes, vendedores, pedidos, entrega, picking, transporte, facturación, NC/ND, devoluciones | §5, §6 |
| **MM** | Gestión de Materiales | Productos, almacenes, proveedores, compras, inventario y costo | §5, §7, §8 |
| **PP** | Producción | Órdenes de producción o ensamblaje simples | §8.4 |
| **FI** | Contabilidad Financiera | Mayor, periodos, CxC, CxP, activos fijos, estados financieros | §12 |
| **TR** | Tesorería y Bancos | Bancos, cuentas, gastos, caja chica y conciliación | §10 |
| **CO** | Control de Gestión | Metas y comisiones | §9 |
| **CR** | CRM y Postventa | Prospectos, contactos, oportunidades, actividades y casos | §6.5 |
| **FX** | Fiscal Venezuela | Condición fiscal, libros, retenciones e IGTF | §11 |
| **BI** | Reportes y Analítica | Reportes M1–M6 y analítica avanzada | `spec_reportes.md` |
| **BC** | Administración del Sistema | Empresa, usuarios, tasas, auditoría y flujo de trabajo | §4.2, §4.3, §4.5 |

Los datos maestros viven en el módulo dueño (clientes y vendedores en SD; productos, almacenes y proveedores en MM). Los módulos generan asientos solo mediante el motor de reglas contables (§12.3).

### 4.5 Flujo de trabajo y aprobaciones (BC)
En SAP el flujo de trabajo es un componente transversal de Basis. Aquí es un **motor único** que reemplaza la lógica de aprobación propia de cada módulo, para que las reglas de la matriz de la §4.3 sean **datos y no código**. Está construido desde la Fase 2 (migración `0016_flujo_trabajo.sql`, `src/lib/flujo/`).

**Modelo** (resumen; el esquema vigente está en la migración)
```sql
flujo_definicion (objeto_tipo unique, nombre, activo)                 -- qué objeto se aprueba; no se borra, se inactiva
flujo_paso (definicion_id, orden, rol_aprobador,
            condicion_campo, condicion_operador, condicion_valor,       -- p. ej. monto_usd > 5000; nulo = siempre
            distinto_del_creador, horas_para_escalar, escalar_a_rol)
solicitud_aprobacion (objeto_tipo, objeto_id, estado, contexto jsonb,
                      pasos jsonb,                                      -- COPIA de los pasos que aplican al crearla
                      paso_actual, solicitante_id, paso_desde, resuelta_at)
aprobacion_decision (solicitud_id, paso, usuario_id, en_nombre_de,      -- en_nombre_de: quien delegó
                     decision, comentario, datos jsonb)                 -- datos: lo que aporta el aprobador (p. ej. crédito)
delegacion_aprobacion (usuario_id, sustituto_id, desde, hasta)
```

**Reglas**
1. Un documento que exige aprobación abre su solicitud **en la misma transacción** que lo crea (`solicitarAprobacion`, idempotente). La decisión final ejecuta lo que su módulo hace al aprobar o rechazar (un manejador registrado en `src/lib/flujo/objetos.ts`) también en una sola transacción: si el módulo falla, la decisión se revierte.
2. **Umbrales y roles no se escriben en el código:** los define Gerencia en `flujo_paso` (pantalla Configuración → Definición de flujos), con la matriz de la §4.3 como configuración inicial. El dato de una condición viene en el `contexto` de la solicitud; si no viene, el paso aplica (ante la duda se exige la aprobación).
3. **Copia de los pasos:** cambiar la definición no altera las solicitudes en curso; aplica a las nuevas.
4. **Segregación de funciones, validada por la base de datos** (`fn_flujo_puede_decidir`, una sola regla que usan el trigger y la bandeja): el usuario tiene el rol del paso (o el de escalamiento si venció el plazo, o es sustituto de quien lo tiene), no es quien solicitó si el paso lo exige, y no decide dos pasos de la misma solicitud.
5. **Un flujo conserva siempre un paso sin condición** y no se borra: así ningún objeto queda sin aprobador aunque se cambien los umbrales. Una definición inactiva no admite solicitudes.
6. **La solicitud solo avanza registrando decisiones**: la base rechaza aprobar, borrar o editar una solicitud por otra vía. Las decisiones no se modifican ni se borran. Solo se cancela (p. ej. un borrador eliminado).
7. **Las restricciones y triggers de cada módulo se mantienen** como última barrera (por ejemplo, el cuadre y la aprobación del asiento manual, o que aprueben clientes solo usuarios con rol Gerencia). Por eso, si se configura un rol distinto para un tipo ya existente, el módulo lo rechazará hasta que su regla se ajuste; el escalamiento a otro rol es pleno en los tipos nuevos.
8. **Bandeja de aprobaciones** (`/aprobaciones`): lo que le toca decidir a cada usuario (por rol, escalamiento o delegación), sus solicitudes y sus decisiones recientes. La decisión se toma en la pantalla de cada registro, donde están los datos que se revisan. Un rechazo exige motivo.
9. **Delegación:** cada usuario delega sus aprobaciones a un sustituto por un rango de fechas. La decisión queda registrada como tomada por el sustituto *en nombre de* quien delegó, y el módulo dueño registra como responsable a quien delegó. La segregación de funciones sigue aplicando.
10. **Escalamiento sin procesos programados:** pasado `horas_para_escalar`, la solicitud aparece también al rol de escalamiento; no hay que esperar un trabajo nocturno.
11. Toda solicitud, decisión y cambio de definición queda en `audit_log`.
12. **Ya pasan por el motor** (con sus mismos roles y reglas): alta de cliente, alta de proveedor, cambio de datos sensibles de un proveedor, asiento manual y lote de metas. Los tipos de las fases siguientes (orden de compra, pago, nota de crédito comercial, ajuste de inventario, liquidación de comisiones, anulación) se registran al construir cada módulo.

---

## 5. Datos maestros

### 5.1 Modelo de terceros
Un RIF es **una sola persona**, aunque sea a la vez cliente y proveedor. Así se evita el choque de códigos que tiene el sistema actual, donde un mismo código identifica a un cliente y a un proveedor distintos.

Los maestros **se crean en el ERP a medida que la operación los necesita**: el cliente al registrar su primera venta, el proveedor al registrar su primera compra y el producto al recibirlo o al contar el inventario inicial (§14).

```sql
create table tercero (
  id              uuid primary key default gen_random_uuid(),
  rif             varchar(12) not null unique
                  check (rif ~ '^[VEJPG]-[0-9]{8}-[0-9]$'),
  razon_social    text not null,
  nombre_comercial text,
  tipo_persona    char(1) not null check (tipo_persona in ('N','J')),
  domiciliado     boolean not null default true,
  contribuyente_especial boolean not null default false,  -- define 75 % / 100 % y agente de percepción de IGTF
  agente_retencion_iva   boolean not null default false,
  direccion_fiscal text, telefono text, email text,
  estado          text not null default 'activo' check (estado in ('activo','inactivo','bloqueado')),
  created_at timestamptz not null default now(), created_by uuid
);

create table cliente (
  tercero_id      uuid primary key references tercero(id),
  codigo          varchar(10) not null unique,          -- código visible, asignado por el numerador (p. ej. C00001)
  sucursal_id     uuid references sucursal(id),
  vendedor_id     uuid references vendedor(id),
  zona            text,
  nivel_precio    char(1) not null default 'B' check (nivel_precio in ('A','B','D')),
  condicion_pago_id uuid references condicion_pago(id),
  limite_credito_usd numeric(14,2) not null default 0 check (limite_credito_usd >= 0),
  descuento_pct   numeric(5,2) not null default 0,
  estado          text not null default 'pendiente' check (estado in ('pendiente','activo','inactivo','bloqueado')),
  aprobado_por    uuid references usuario(id),            -- Gerencia (§5.5)
  aprobado_at     timestamptz
);

create table proveedor (
  tercero_id      uuid primary key references tercero(id),
  codigo          varchar(10) not null unique,
  tipo            text not null check (tipo in ('mercancia_local','importacion','servicios','gastos')),
  pais            char(2) not null default 'VE',
  condicion_pago_id uuid references condicion_pago(id),
  concepto_islr_id uuid references concepto_islr(id),   -- concepto por defecto del Decreto 1.808
  estado          text not null default 'pendiente' check (estado in ('pendiente','activo','inactivo','bloqueado')),
  aprobado_por    uuid references usuario(id),           -- Gerencia, distinta de quien lo registró
  aprobado_at     timestamptz
);
-- Cambios de datos sensibles de un proveedor aprobado: quedan pendientes hasta que Gerencia los aprueba.
create table proveedor_cambio (
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid not null references proveedor(tercero_id),
  datos jsonb not null,                                  -- solo los campos que cambian
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobado','rechazado')),
  solicitado_por uuid not null, resuelto_por uuid, motivo_rechazo text   -- resuelto_por <> solicitado_por
);
```

#### Direcciones de entrega del cliente
Un cliente puede recibir en varios puntos (sede, sucursal, depósito). Cada punto es una **dirección de entrega** con ubicación geográfica y una ventana de recepción. La dirección fiscal del tercero no se usa para despachar.

```sql
create table cliente_direccion_entrega (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references cliente(tercero_id),
  nombre text not null,                                  -- "Sede principal", "Tienda Cabudare"
  direccion text not null, ciudad text not null, entidad_federal text not null,
  latitud numeric(9,6), longitud numeric(9,6),           -- ambas o ninguna; dentro del territorio venezolano
  contacto_nombre text, contacto_telefono text,
  minutos_descarga smallint not null default 15,         -- tiempo de servicio en la parada, para el ruteo
  ventana_tipo text not null default 'blanda' check (ventana_tipo in ('blanda','dura')),
  observaciones text,                                    -- restricciones: "no entra camión grande", "descarga por la calle lateral"
  predeterminada boolean not null default false,         -- una sola vigente por cliente
  activa boolean not null default true
);
create table cliente_direccion_ventana (                 -- horario de recepción, en hora de Caracas
  id uuid primary key default gen_random_uuid(),
  direccion_id uuid not null references cliente_direccion_entrega(id),
  dia_semana smallint not null check (dia_semana between 1 and 7),   -- 1 = lunes … 7 = domingo
  hora_desde time not null, hora_hasta time not null check (hora_hasta > hora_desde)
);
```
- **Ubicación:** latitud y longitud se capturan juntas. La base rechaza coordenadas fuera de Venezuela (el error más común es invertir latitud y longitud). Una dirección sin coordenadas queda "sin ubicar": puede despacharse a mano, pero no entra en la optimización de rutas.
- **Ventana de recepción:** varios rangos por día (por ejemplo, 8:00 a 12:00 y 14:00 a 17:00); no pueden solaparse. Sin ventana, el cliente recibe en cualquier hora. **La ventana es blanda por defecto**: el ruteo intenta respetarla y, si no cabe, la incumple con una penalización y marca la parada. Una dirección puede marcarse `dura` para casos en que el cliente no recibe fuera de su horario.
- **Quién las mantiene:** Facturación, Supervisor de ventas y Gerencia en cualquier cliente; Ventas solo en los de su cartera. Una dirección no se borra: se inactiva.

### 5.2 Vendedores
```sql
create table vendedor (
  id           uuid primary key default gen_random_uuid(),
  codigo       varchar(6) not null unique,        -- asignado por el ERP (p. ej. V001)
  nombre       text not null,
  tercero_id   uuid references tercero(id),       -- si es externo: retención ISLR sobre comisiones
  tipo         text not null check (tipo in ('interno','externo','administrativo','casa')),
  sucursal_id  uuid references sucursal(id),
  plan_comision_id uuid references plan_comision(id),
  usuario_id   uuid references usuario(id),
  estado       text not null default 'activo'
);
```
Los vendedores los registran y modifican **Gerencia y Supervisor de ventas**. El código (V001, V002…) lo asigna el numerador y no cambia. Un vendedor externo necesita RIF: si ese RIF ya existe como tercero (por ejemplo, es cliente), se reutiliza. El usuario del ERP enlazado debe tener el rol Ventas o Supervisor de ventas, y un usuario se enlaza a un solo vendedor. Un vendedor no se borra: se inactiva.

Las ventas de mostrador, de la "casa" o de uso administrativo se registran con un vendedor de `tipo = 'administrativo'` o `'casa'`. Así se excluyen de rankings y comisiones con un filtro explícito, sin listas de códigos escritas en el programa (el error que hoy tiene la operación actual).

### 5.3 Productos o materiales
| Entidad | Campos clave |
|---|---|
| `producto_base` | **Código común**: el artículo genérico (p. ej. "Pastilla de freno delantera Tucson") que se vende en una o varias marcas. `codigo` interno (único, fijo), `descripcion`, `categoria_id`, `estado` |
| `producto` | Producto de marca, que es lo que se vende, se cuenta y tiene precio. `codigo` (único), `producto_base_id` (código común), `descripcion`, `grupo_id` (modelo principal, para los reportes del dashboard), `marca_id`, `categoria_id` (heredada del código común), `unidad` (unidad de medida de venta), `alicuota_iva_id`, `inventariable`, `codigo_alterno`, `peso_kg` (por unidad), **empaque** (`empaque_unidad`, `unidades_por_empaque`, `empaque_peso_kg`, `empaque_largo_cm`, `empaque_ancho_cm`, `empaque_alto_cm`; el volumen del empaque y el volumen por unidad se calculan en la base, y las tres dimensiones van juntas o ninguna), `linea_calidad` (original, OEM o alterna), `pais_origen`, `foto_url`, `estado`. **Un solo producto por marca dentro de cada código común** |
| `categoria_producto` | Árbol de categorías (sistema → subsistema, p. ej. Frenos › Pastillas). Reemplaza la "familia" en texto libre |
| `producto_base_aplicacion` | Aplicación vehicular del código común: modelo (`grupo_id`), año desde, año hasta y motor. Un repuesto sirve para varios modelos y años |
| `producto_referencia` | Referencias cruzadas OEM y alternas por fabricante (reemplaza `REFCRUZ`, que hoy no se exporta) |
| `grupo_producto`, `marca` | Catálogos que crea el usuario (grupo = modelo de vehículo, p. ej. TUCSON, RIO) |
| `lista_precio` / `precio` | Listas A, B y D en USD, con `vigente_desde`. **El costo no se guarda como lista de precio** (hoy `precio_d` hace de costo): el costo sale del inventario (§8) |
| `almacen` | `codigo`, `sucursal_id`, `es_comercial` (01 y 06 hoy), `permite_venta` |

- **Quién los administra:** Almacén crea y modifica productos, grupos, marcas y referencias cruzadas; Gerencia y Supervisor de ventas fijan los precios; Gerencia crea los almacenes y asigna qué usuarios de Almacén ve cada uno (`usuario_almacen`).
- **Código del producto:** lo escribe el usuario (suele ser el número de parte), se guarda en mayúsculas, es único sin importar mayúsculas y no se cambia.
- **Alícuota de IVA:** `alicuota_iva` es una categoría (general, reducida, lujo, exento, exonerado) que apunta a códigos de `parametro_fiscal`; el porcentaje de una fecha es la suma de esos parámetros vigentes. Ningún porcentaje se guarda en el producto.
- **Precios:** no se editan ni se borran. Un cambio es un precio nuevo con su fecha de vigencia, que no puede ser anterior a hoy.
- **Segmentación para análisis:** todo producto nuevo pertenece a un código común. Así cada indicador se puede ver en dos niveles: el artículo completo (todas sus marcas) y cada producto de marca. Es la base de los pronósticos, la elasticidad de precio y el análisis de promociones (Fase 8).

### 5.4 Otros maestros
- **Transportistas, vehículos y tarifas** (§6.4): la flota propia y los proveedores de servicio de entrega. Un transportista de terceros es un **proveedor de tipo servicios, ya aprobado**, y lleva sus tarifas como dato maestro.
- **Bancos y cuentas bancarias:** `banco` (catálogo) y `cuenta_bancaria` (banco, número, tipo, moneda y su subcuenta contable propia, §6.3), con los **instrumentos de pago** (`instrumento_pago`).
- **Plan de cuentas** (§12.1), **centros de costo** (sucursal, departamento) y **categorías de gasto** (§10.1).
- **Conceptos ISLR** (Decreto 1.808) y **alícuotas de IVA**, con vigencia.
- **Metas de venta**, cargadas por Gerencia o Supervisor de ventas (Excel o captura manual) y aprobadas por Gerencia en el ERP. Cada carga es un **lote** con número de versión, usuario y fecha, que nace `pendiente`; quien lo cargó no lo aprueba. La meta vigente de cada clave es la del último lote aprobado (vista `vw_meta_periodo`). Las filas de un lote no se editan: un cambio es un lote nuevo. Es todo o nada: si una fila tiene error no se guarda nada.
  ```sql
  create table meta_lote (
    id uuid primary key default gen_random_uuid(), version int generated always as identity unique,
    origen text not null check (origen in ('excel','manual')), archivo text,
    estado text not null default 'pendiente' check (estado in ('pendiente','aprobado','rechazado')),
    creado_por uuid not null references usuario(id), created_at timestamptz not null default now(),
    resuelto_por uuid references usuario(id), resuelto_at timestamptz, motivo_rechazo text
  );
  create table meta_venta (
    id uuid primary key default gen_random_uuid(), lote_id uuid not null references meta_lote(id),
    tipo text not null check (tipo in ('global','vendedor','cliente','producto','grupo')),
    entidad_id uuid,                       -- null para 'global'
    anio smallint not null, mes smallint check (mes between 1 and 12),  -- null = anual
    monto_usd numeric(14,2) not null check (monto_usd >= 0)
  );
  ```
  Si no hay una fila GLOBAL aprobada, la meta global del año es la suma de las metas de los vendedores (`fn_meta_global`); si hay metas mensuales, la meta anual efectiva es su suma (`vw_meta_anual`).

### 5.5 Calidad de datos maestros
- Validar el RIF (formato y dígito verificador) al crear. Detectar duplicados por RIF y por nombre parecido.
- Bloqueo por aprobación: **Facturación** registra el cliente, que queda en `pendiente` hasta que **Gerencia** le asigna condición de pago, límite de crédito y nivel de precio. La base de datos rechaza la aprobación de un usuario sin el rol Gerencia, y un cliente aprobado no vuelve a `pendiente`.
- El código visible del cliente (C00001…) lo asigna el numerador y no cambia. Si el RIF ya existe como tercero (por ejemplo, es proveedor), el cliente se enlaza a ese tercero.
- Los nombres se comparan normalizados (sin acentos, signos ni sufijos como C.A. o S.A.): un nombre igual al de otro tercero exige confirmación.
- **Nunca se borra un maestro con movimientos.** Se inactiva.
- **Proveedores:** Compras los registra (código P00001…) y quedan en `pendiente` hasta que Gerencia, distinta de quien los registró, los aprueba y les asigna la condición de pago. Con el proveedor aprobado, Compras cambia directamente los datos de contacto (nombre comercial, dirección, teléfono, correo); los **datos sensibles** (razón social, domiciliado, contribuyente especial, agente de retención de IVA, tipo, país y concepto de ISLR) se cambian con una **solicitud** que Gerencia aprueba o rechaza con motivo, siempre otra persona distinta de quien la pidió. Solo Gerencia cambia la condición de pago. La base de datos impide cambiar esos datos por otra vía, incluso desde la pantalla de clientes cuando el tercero también es proveedor.
- **Conceptos de ISLR:** Contabilidad registra el catálogo. Sus porcentajes, mínimos y sustraendos, con vigencia, se agregan con la retención de ISLR.

---

## 6. Ventas: del pedido al cobro (Order-to-Cash)

```mermaid
flowchart LR
  COT[Cotización] --> PED[Pedido\n(vendedor o mostrador)]
  PED -->|aprobación de crédito| NE[Nota de entrega]
  NE --> PIC[Picking y empaque]
  PIC --> TRA[Transporte y despacho]
  TRA --> FAC[Factura\n(número de control)]
  FAC --> CXC[Partida CxC]
  CXC --> COB[Cobro + aplicación]
  COB --> RET[Retención IVA recibida]
  FAC --> NC[Nota de crédito:\ndevolución, pronto pago, ajuste]
  NC --> CXC
  COB --> COM[Comisión devengada]
```

### 6.1 Documento de venta
```sql
create table documento_venta (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('cotizacion','pedido','nota_entrega','factura','nota_credito','nota_debito',
                                               'apertura')),   -- apertura: factura pendiente al día de arranque (§14.3)
  serie           varchar(4) not null,
  numero          bigint not null,
  numero_control  varchar(20),                 -- de la imprenta digital o máquina fiscal (solo documentos fiscales)
  estado          text not null default 'borrador' check (estado in ('borrador','emitido','anulado')),
  sucursal_id     uuid not null references sucursal(id),
  almacen_id      uuid references almacen(id),
  cliente_id      uuid not null references cliente(tercero_id),
  vendedor_id     uuid references vendedor(id),
  documento_origen_id uuid references documento_venta(id),   -- NC/ND → factura; factura → nota de entrega
  motivo_nc       text check (motivo_nc in ('devolucion','pronto_pago','descuento_comercial','ajuste_precio','intereses','otro')),  -- NC: las cuatro primeras; ND: ajuste_precio, intereses, otro
  motivo_nc_id    uuid references motivo(id),               -- motivo del catálogo (devolución o descuento) de la NC
  fecha_emision   timestamptz not null,
  fecha_vencimiento date,
  moneda          char(3) not null references moneda(codigo),
  tasa            numeric(18,6) not null check (tasa > 0),   -- VES por USD, congelada al emitir
  subtotal        numeric(16,2) not null default 0,
  descuento       numeric(16,2) not null default 0,
  base_imponible  numeric(16,2) not null default 0,
  exento          numeric(16,2) not null default 0,
  iva             numeric(16,2) not null default 0,
  igtf            numeric(16,2) not null default 0,
  total           numeric(16,2) not null default 0,
  total_ves       numeric(18,2) not null default 0,
  total_usd       numeric(16,2) not null default 0,
  anulado_por uuid, anulado_at timestamptz, anulado_motivo text,
  created_by uuid not null, created_at timestamptz not null default now(),
  unique (tipo, serie, numero),
  check (estado <> 'anulado' or anulado_motivo is not null)
);

create table documento_venta_linea (
  id              uuid primary key default gen_random_uuid(),
  documento_id    uuid not null references documento_venta(id),
  linea           int not null,
  producto_id     uuid not null references producto(id),
  descripcion     text not null,
  cantidad        numeric(14,4) not null check (cantidad > 0),
  precio_unitario numeric(16,4) not null check (precio_unitario >= 0),
  descuento_pct   numeric(5,2) not null default 0,
  alicuota_iva_id uuid not null references alicuota_iva(id),
  base            numeric(16,2) not null,
  iva             numeric(16,2) not null,
  total           numeric(16,2) not null,
  costo_unitario_usd numeric(16,4),            -- foto del costo promedio al emitir: margen por línea
  -- Foto al emitir para análisis (Fase 8): sin estos datos la elasticidad y el efecto de las promociones no se pueden medir después.
  producto_base_id  uuid references producto_base(id),   -- código común vigente al emitir
  lista_precio      char(1) references lista_precio(codigo),
  precio_lista      numeric(16,4),                        -- precio de lista vigente en la fecha
  promocion_id      uuid references promocion(id),         -- promoción aplicada, si hubo
  linea_origen_id uuid references documento_venta_linea(id),
  unique (documento_id, linea)
);

-- Promociones: qué se ofreció, a quién y cuándo. Base del análisis de promociones (Fase 8). Migración 0027.
create table promocion (
  id              uuid primary key default gen_random_uuid(),
  codigo          varchar(10) not null unique,           -- PRM0001, asignado por el numerador
  nombre          text not null, descripcion text,
  tipo            text not null check (tipo in ('descuento_pct','precio_especial')),
  descuento_pct   numeric(5,2),                          -- solo 'descuento_pct'
  cantidad_minima numeric(14,4),                         -- compra mínima por línea; vacío = sin mínimo
  vigente_desde   date not null,
  vigente_hasta   date not null,
  estado          text not null default 'borrador' check (estado in ('borrador','pendiente','aprobada','rechazada','anulada')),
  aprobado_por    uuid references usuario(id),           -- Gerencia, distinta de quien la creó
  created_by      uuid not null references usuario(id)
);
create table promocion_alcance (                         -- a qué aplica: productos y, si se quiere, clientes
  id uuid primary key default gen_random_uuid(),
  promocion_id uuid not null references promocion(id),
  tipo text not null check (tipo in ('producto','codigo_comun','categoria','marca','cliente')),
  entidad_id uuid not null,
  precio_especial_usd numeric(14,2)                      -- solo 'precio_especial', por producto
);
```

- **Demanda no atendida:** cuando un pedido no se despacha completo por falta de existencia, la cantidad no despachada se registra (producto, cliente, fecha, cantidad). Junto con la existencia diaria por producto y almacén (§8), permite separar "no se vendió" de "no había", y es obligatoria para pronosticar bien. **Implementado:** la tabla `demanda_no_atendida` se llena **una sola vez**, cuando el pedido se aprueba y reserva y no alcanzó la existencia; reservar después el saldo que llegó no la modifica ni la repite.

**Motivos y datos para decidir (migración 0019, ver [catalogo_decisiones.md](catalogo_decisiones.md))**
- Catálogo `motivo` (descuento, devolución, anulación, venta perdida, merma) que administra Gerencia; un motivo no se borra y los que usa el sistema no se desactivan.
- **Descuento:** toda línea con descuento lleva motivo (la base lo exige). El descuento pactado con el cliente lleva el motivo automático `DESCUENTO_CLIENTE`; cualquier otro exige que quien vende elija uno.
- **Anulación:** todo documento anulado guarda un motivo del catálogo (`anulado_motivo_id`) además de su detalle; "Otro" exige el detalle.
- **Ventas perdidas:** `demanda_no_atendida` acepta registros manuales sin documento (precio, plazo, condición de pago) además de los que el sistema crea por falta de existencia; ambos llevan motivo.
- **Historial de cartera:** `cliente_vendedor_historial` conserva qué vendedor tuvo cada cliente y desde cuándo (`fn_vendedor_de_cliente`).

**Cómo quedó el pedido y la nota de entrega (migración 0017)**
- Ambos son `documento_venta`; esta migración habilita solo los tipos `pedido` y `nota_entrega`. La factura, las NC y ND y la apertura se agregan con su propia migración.
- Un borrador no tiene número (`numero` es nulo): el numerador lo asigna al emitir, así que los borradores eliminados no dejan huecos. Al emitir también se congelan la tasa BCV del día, la base, el IVA y los totales; el documento emitido no se edita ni se borra, solo se anula con motivo.
- `situacion` (solo pedidos emitidos): `retenido_credito` espera la decisión de Gerencia por el flujo `pedido_credito`; `aprobado` ya reservó existencia.
- Cada línea guarda la alícuota vigente (`alicuota_pct`).

**Promociones (migración 0027)**
- **Tipos:** `descuento_pct` (un porcentaje) y `precio_especial` (un precio fijo por producto). Las promociones de cantidad son un descuento con `cantidad_minima`. El tipo «combo» de la versión anterior de esta especificación no se construyó: queda para cuando el negocio defina cómo se arman los combos.
- **Alcance** (`promocion_alcance`): aplica a un producto si coincide con algún elemento de producto del alcance: el producto, su código común, su categoría (la indicada o cualquier subcategoría) o su marca. Si el alcance incluye clientes, solo aplica a esos clientes; sin clientes, a todos. Una promoción de precio especial solo se arma con productos concretos (cada uno con su precio) y, si se quiere, clientes. El alcance de cada tipo se valida contra su catálogo.
- **Ciclo de vida:** nace en `borrador` (se arma y se edita), se envía a aprobación (`pendiente`, motor de flujo §4.5) y **Gerencia, distinta de quien la creó, la aprueba o la rechaza con motivo**. Una promoción enviada no se edita; una `aprobada` se anula con motivo o vence por fecha. Una promoción no se borra. Las crean Gerencia y el Supervisor de ventas.
- **Cómo se aplica en el pedido:** al agregar o cambiar una línea sin descuento escrito a mano, la base busca la mejor promoción aprobada, vigente hoy, con la compra mínima cumplida y que alcance al producto y al cliente. **El descuento pactado con el cliente y la promoción no se acumulan:** gana el que deja el menor precio neto; la línea guarda la promoción (`promocion_id`), el descuento (con el motivo del sistema `PROMOCION`) o el precio especial, y siempre el precio de lista. Un descuento escrito a mano manda y deja la línea sin promoción. La base rechaza ligar una línea a una promoción no aprobada, no vigente, que no alcance al producto o al cliente, o cuyo descuento o precio no coincida.
- La promoción viaja del pedido a la nota de entrega y a la factura. La vista `vw_promocion_aplicada` mide lo que cada una movió (notas de entrega vigentes, en USD): líneas, unidades, venta a precio de lista, lo cobrado y el descuento otorgado. El efecto frente a la venta esperada sin la promoción se mide en la Fase 8.
- La nota de entrega se genera desde un pedido aprobado con **lo que hay reservado** y todavía no figura en otra nota; conserva precio, descuento e IVA del pedido y toma su propia tasa del día. Se anula mientras la mercancía no haya salido del almacén, y entonces la reserva vuelve al pedido.
- Las reservas viven en `reserva_inventario` (estados `activa`, `en_nota`, `consumida`, `liberada`); `existencia.reservado` es su suma y no se edita a mano.
- **Crédito:** solo se valida si la condición de pago del cliente tiene plazo (días > 0); un cliente de contado paga al entregar y no usa el límite. Lo comprometido es lo pendiente de entregar en pedidos aprobados más las notas de entrega vigentes; las cuentas por cobrar y la mora (días de mora máximos) se suman cuando exista `partida_cxc`.
- Un pedido emitido que excede el límite queda retenido sin reservar; Gerencia (otra persona distinta de quien lo emitió) lo aprueba o lo rechaza con motivo, y al rechazar se anula.

### 6.2 Reglas de negocio
1. **Precio:** según el nivel del cliente (A, B, D) y la lista vigente en la fecha. Un descuento por encima del máximo de su rol requiere aprobación.
2. **Crédito:** al aprobar un pedido se verifica que *saldo abierto + pedido ≤ límite de crédito* y que el cliente no tenga partidas con más de N días de mora (parámetro). Si no se cumple, queda `retenido por crédito`.
3. **Disponibilidad:** se reserva stock al aprobar el pedido y se descuenta al despachar. No se permite existencia negativa en almacenes comerciales.
4. **Factura fiscal:** al emitir se pide el número de control a la imprenta digital (§11.1). Si el servicio no responde, se usa el procedimiento de **contingencia**.
5. **Cálculo:** la base, el IVA por alícuota y el total se calculan y **guardan** al emitir. Nunca se recalculan después. Hoy el monto de las devoluciones sale en 0 justamente porque no se guardaba.
6. **IGTF:** si el cobro se hace en divisas y la empresa es agente de percepción, el IGTF se calcula sobre el monto pagado en divisas y se muestra separado del IVA (§11.3).
7. **Notas de crédito:** siempre referencian la factura de origen. Hay dos clases:
   - **Devolución:** reingresa mercancía al inventario al costo original de la línea.
   - **Pronto pago o descuento comercial:** no mueve inventario.

   Una NC nunca supera el saldo pendiente de la factura (no hay «saldo a favor» todavía: si la factura ya se cobró, devolver el dinero queda pendiente). Las notas de débito (intereses, ajuste de precio, otros) también referencian la factura y abren su propia cuenta por cobrar.
8. **Anulación:** solo de documentos del periodo abierto y sin cobros aplicados. Revierte el asiento, el inventario y la partida abierta.

**Cómo quedó la factura de venta (migración 0021)**
- Va en **bolívares** (decisión 14). Se genera desde una o más notas de entrega **despachadas** de un mismo cliente: el precio en USD de cada línea se convierte a la tasa BCV del día de la factura (`round(precio USD × tasa, 4)`), y la base, el IVA y el total se calculan con las alícuotas vigentes **a la fecha de la factura** y se guardan. Una nota se factura completa y una sola vez (`documento_venta.factura_id`); el costo promedio que tenía la línea al despachar se conserva para el margen.
- **Número de factura** correlativo y sin huecos (numerador `factura`, serie A). **Número de control:** se pide al servicio de imprenta con el número ya asignado. Si el servicio falla o no existe, la factura queda emitida en **contingencia** con su motivo y se le asigna el control después (es lo único que cambia en una factura emitida). La base exige control o contingencia con motivo.
- **Imprenta (decisión 13 pendiente):** interfaz `ServicioNumeroControl` con un **simulador** (`00-00000001…`, sin validez fiscal) para desarrollo; en producción el simulador no existe y, sin proveedor real, las facturas van a contingencia. Los documentos con número simulado se marcan como PRUEBA en pantalla y en la vista de impresión.
- Cada factura abre su `partida_cxc` (vencimiento = fecha + días de la condición de pago del cliente) y su asiento por el motor: **Debe** CxC comerciales (total), **Haber** Ventas de mercancía (base + exento) e IVA débito fiscal. El saldo de la partida solo cambia con un cobro, una nota de crédito o la anulación.
- **Anular** (solo sin cobros ni notas de crédito aplicados): asiento inverso a la fecha de la factura (si su periodo está cerrado, no se anula), partida anulada y notas de entrega libres para facturarse otra vez. El número anulado no se reutiliza y sigue en el libro como anulado.
- El crédito del cliente (§6.2, regla 2) ahora cuenta las cuentas por cobrar abiertas, las notas de entrega aún sin facturar y lo pendiente de entregar en pedidos aprobados. **Pendiente:** los días máximos de mora (necesitan su parámetro) y el IGTF, que se calcula al cobrar.
- Pruebas: auxiliar de CxC igual al mayor en VES y USD, asiento de cada regla (`factura_venta`, `anulacion_factura`) y numeración de facturas concurrente contra PostgreSQL real.

**Cómo quedaron las notas de crédito y débito (migración 0029)**
- Son `documento_venta` de tipo `nota_credito` y `nota_debito`, siempre sobre una **factura emitida** del mismo cliente y **en bolívares** con los precios, el costo y la alícuota de la línea de la factura (el IVA no cambia aunque la alícuota haya cambiado después). Numeradores propios `nota_credito` y `nota_debito` (serie A), correlativos y sin huecos; el número de control se pide igual que a la factura (con contingencia).
- **Clases de NC:** *devolución* (por línea y cantidad, hasta lo facturado menos lo ya devuelto en otras NC vivas; motivo del catálogo de devoluciones), *pronto pago* (porcentaje; usa el motivo de sistema `PRONTO_PAGO`), *descuento comercial* (porcentaje con motivo del catálogo de descuentos) y *ajuste de precio*. Los porcentajes se aplican sobre el precio neto de cada línea de la factura (todas o las marcadas). **Motivos de ND:** intereses, ajuste de precio y otros; sus líneas son productos del maestro con precio manual en Bs.
- **Aprobación (motor de flujo, §4.5):** toda nota pasa por `borrador → pendiente_aprobacion → aprobada | rechazada`. Aprueba el **Supervisor de ventas**, distinto de quien la creó (lo exige la base de datos, no solo la pantalla); el rechazo pide motivo. **Crean** Ventas, Supervisor de ventas, Facturación y Gerencia; **emiten** Facturación y Gerencia, y solo una nota aprobada. Cada vendedor solo ve y crea notas de su cartera, salvo los roles que ven todos los documentos.
- **Emitir una NC:** reduce el saldo de la partida de la factura (nunca por encima del saldo abierto); el valor en USD que reduce es proporcional al USD del saldo de la factura, para que el auxiliar siga igual al mayor en VES y en USD. Asiento: Debe *Devoluciones en ventas* (o *Descuentos en ventas*) e IVA débito fiscal, Haber CxC comerciales. **Si es devolución:** movimiento de inventario `devolucion_cliente` al **costo de la línea original** y asiento `reingreso_devolucion` (Debe Inventario, Haber Costo de ventas).
- **Emitir una ND:** abre una `partida_cxc` (vencimiento indicado o fecha + días de la condición del cliente) y el asiento Debe CxC comerciales; Haber Ventas (ajuste de precio) u *Otros ingresos* (intereses y otros) e IVA débito fiscal. Se cobra como cualquier factura.
- **Una nota emitida no se edita ni se anula**: se corrige con otra nota. Una factura con notas vivas no se anula. **Pendiente:** saldo a favor y reintegro del dinero cuando la factura ya se cobró, la propuesta automática de la NC por pronto pago al cobrar, y la reversión de comisiones por NC (Fase 6).
- Pruebas: cada regla (`nota_credito_devolucion`, `nota_credito_descuento`, `nota_debito_ajuste`, `nota_debito_otros`, `reingreso_devolucion`) verifica su asiento; límites de devolución; segregación de aprobador; protecciones de la base; numeración y roles; y el auxiliar de CxC igual al mayor en VES y USD al final.

### 6.3 Cuentas por cobrar y cobranzas
```sql
create table partida_cxc (            -- una por factura (y, cuando se construyan, por ND); la NC y el anticipo no abren partida: reducen o se aplican
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references cliente(tercero_id),
  documento_id uuid not null unique references documento_venta(id),
  fecha date not null, vencimiento date not null,
  moneda char(3) not null, tasa numeric(18,6) not null,
  monto_original numeric(16,2) not null,      -- en la moneda de la factura (bolívares)
  monto_usd numeric(16,2) not null,           -- su valor en USD a la tasa de la factura
  saldo numeric(16,2) not null,               -- saldo en bolívares
  saldo_usd numeric(16,2) not null,           -- lo que queda de su valor en USD, a la tasa de la factura (migración 0028)
  estado text not null check (estado in ('abierta','cancelada','anulada'))
);

create table instrumento_pago (               -- cómo pagó el cliente: transferencia, pago móvil, efectivo, Zelle, USDT, punto de venta, cheque
  id uuid primary key default gen_random_uuid(),
  codigo varchar(20) not null unique, nombre text not null,
  genera_igtf boolean not null default false,  -- lo usará el IGTF (Fase 3 y 4)
  activo boolean not null default true
);

create table cuenta_bancaria (                -- cuentas de la empresa donde entra el dinero: bancos, cajas, custodia, exterior y USDT
  id uuid primary key default gen_random_uuid(),
  codigo varchar(10) not null unique,          -- CB0001, asignado por el numerador
  nombre text not null, banco_id uuid references banco(id), numero text,
  tipo text not null check (tipo in ('banco','caja','custodia','exterior','digital')),
  moneda char(3) not null references moneda(codigo),
  cuenta_contable_id uuid not null unique references cuenta_contable(id),   -- subcuenta propia, creada con la cuenta bancaria
  activa boolean not null default true
);

create table cobro (
  id uuid primary key default gen_random_uuid(),
  numero bigint not null unique,               -- correlativo sin huecos
  cliente_id uuid not null references cliente(tercero_id),
  fecha date not null,                         -- fecha del cobro: hoy o anterior, nunca futura
  instrumento_id uuid not null references instrumento_pago(id),
  cuenta_bancaria_id uuid not null references cuenta_bancaria(id),
  referencia text,                             -- número de transferencia, de cheque, etc.; no se repite por cuenta
  moneda char(3) not null, tasa numeric(18,6) not null,        -- tasa BCV de la fecha, la fija la base de datos
  monto numeric(16,2) not null check (monto > 0),
  monto_ves numeric(18,2) not null, monto_usd numeric(16,2) not null,   -- valor del cobro en los libros, congelado
  por_aplicar numeric(16,2) not null,          -- anticipo: lo que aún no se ha aplicado a ninguna factura (en la moneda del cobro)
  por_aplicar_ves numeric(18,2) not null, por_aplicar_usd numeric(16,2) not null,   -- su valor en los libros
  estado text not null default 'registrado' check (estado in ('registrado','conciliado','anulado'))
);

create table aplicacion_cobro (                -- inmutable; el saldo de la partida lo mueve el trigger de esta tabla
  id uuid primary key default gen_random_uuid(),
  cobro_id uuid not null references cobro(id), partida_id uuid not null references partida_cxc(id),
  origen text not null check (origen in ('registro','anticipo')),   -- al registrar el cobro, o aplicando después un anticipo
  fecha date not null, tasa numeric(18,6) not null,
  monto_cobro numeric(16,2) not null check (monto_cobro > 0),        -- cuánto del cobro se aplica, en la moneda del cobro
  monto_partida numeric(16,2) not null check (monto_partida > 0),    -- cuántos bolívares de la factura cancela
  usd_partida numeric(16,2) not null,          -- cuántos USD (a la tasa de la factura) deja de deber la partida
  base_ves numeric(18,2) not null, base_usd numeric(16,2) not null,  -- valor en los libros de lo cobrado que se aplica
  revertida boolean not null default false
);
```
- **Cuentas bancarias (Tesorería y Gerencia):** cada cuenta de la empresa tiene su **subcuenta contable propia**, que se crea con ella bajo la cuenta de agrupación que corresponde (caja 1.1.01, bancos en bolívares 1.1.02, divisas y custodia 1.1.03, activos digitales 1.1.04). La moneda de la cuenta es la de sus cobros. Una cuenta con movimientos no se borra: se inactiva. La conciliación bancaria (Fase 3) se apoya en ellas.
- **Quién cobra:** Cobranzas, Tesorería y Gerencia registran y aplican cobros; **Facturación no** (quien factura no aplica cobros, §3.6). Ven los cobros además Supervisor de ventas, Contabilidad, Jefe de contabilidad y Auditor.
- **Registrar un cobro** (una sola transacción: cobro, aplicaciones, saldos y asiento): se indica el cliente, la fecha, el instrumento, la cuenta donde entró, la referencia, el monto y a qué facturas se aplica. La moneda es la de la cuenta y la tasa es la BCV de la fecha (la fija la base de datos, no se digita). Lo que no se aplica queda como **anticipo** del cliente.
- **Cómo se aplica:** la factura va en bolívares (decisión 14). Un cobro en bolívares cancela esos bolívares. Un cobro en divisas cancela `monto × tasa BCV de la fecha del cobro` bolívares. Si el cobro liquida el saldo de la factura, se cancela el saldo exacto (la tolerancia es un centavo de la divisa por la conversión). Una aplicación nunca supera el saldo de la factura ni lo que queda del cobro, y solo se aplica a facturas del mismo cliente.
- **Diferencial cambiario:** cada factura conserva su valor en USD de la fecha de emisión (`saldo_usd`). Al cobrar, lo que sale de cuentas por cobrar va a su valor histórico y lo que entra al banco, al valor de la fecha del cobro; la diferencia en USD va a **pérdida o ganancia por diferencial cambiario** (§3.4). En bolívares no hay diferencia, salvo al aplicar un anticipo cuya conversión cambió.
- **Anticipos:** el anticipo se contabiliza en *Anticipos de clientes* (pasivo) por su valor en los libros. Después se aplica a una o varias facturas del cliente: sale del pasivo a ese valor, entra a cuentas por cobrar al valor de la factura y la diferencia, en bolívares y en USD, va al diferencial cambiario. El saldo de la factura se calcula a la tasa BCV de la fecha de la aplicación.
- **Anular un cobro** (con motivo, mientras no esté conciliado y no tenga un anticipo ya aplicado): asiento de reverso, las facturas recuperan su saldo y el número queda anulado. Con un anticipo aplicado después, primero se corrigen esas aplicaciones con una nota de crédito. Una factura con cobros aplicados no se anula.
- **Auxiliar contra mayor:** la suma de `saldo` de las partidas abiertas es igual al saldo de *Cuentas por cobrar comerciales* y la suma de `saldo_usd`, al saldo en USD, al centavo. Los anticipos pendientes suman igual a *Anticipos de clientes*. La pantalla lo muestra y la prueba lo exige.
- **Pendiente de esta sección:** IGTF percibido en el cobro (`genera_igtf` ya está en el instrumento), retenciones recibidas de IVA e ISLR, y la propuesta automática de la NC por pronto pago (las notas de crédito y débito ya existen, §6.2). Cada uno se suma a este mismo flujo.
- **Reportes de cobranza del ERP:** antigüedad de saldos por días desde la emisión y desde el vencimiento (pantalla *Cuentas por cobrar*), días de pago ponderados por monto (`fecha_cobro − fecha_factura`), % cobrado a tiempo y efectividad de cobro, calculados sobre los cobros registrados en el ERP.

**Criterios de aceptación de Ventas y CxC**
- La suma de saldos de `partida_cxc` es igual al saldo de la cuenta de mayor "Cuentas por cobrar comerciales", **al centavo**, en VES y en USD.
- No se puede emitir una factura fiscal sin número de control, salvo en contingencia registrada.
- Una factura anulada no aparece en ventas, en comisiones ni en los libros como venta, pero sí en el libro de ventas como **anulada** (§11.4).

### 6.4 Logística de salida: picking, empaque y transporte
Pertenece a SD (en SAP es la ejecución de entregas). Se activa por almacén: en el mostrador, el picking y el transporte pueden omitirse con un parámetro del almacén.

**Picking y empaque**
```sql
create table orden_picking (
  id uuid primary key default gen_random_uuid(),
  nota_entrega_id uuid not null references documento_venta(id),
  almacen_id uuid not null references almacen(id),
  estado text not null default 'pendiente' check (estado in ('pendiente','asignada','en_proceso','completa','con_faltante','cancelada')),
  prioridad smallint not null default 3,
  asignada_a uuid references usuario(id),
  creada_at timestamptz not null default now(),
  asignada_at timestamptz, iniciada_at timestamptz, finalizada_at timestamptz,
  empacada_at timestamptz
);
create table orden_picking_linea (
  id uuid primary key default gen_random_uuid(),
  orden_id uuid not null references orden_picking(id),
  producto_id uuid not null references producto(id),
  cantidad_pedida numeric(14,3) not null, cantidad_recogida numeric(14,3) not null default 0,
  motivo_faltante text
);
```
- **Tiempos de picking** (se calculan a partir de las marcas de hora, nunca se digitan): *espera* = inicio − creación; *picking* = fin − inicio; *ciclo total* = empaque − creación; *líneas por hora* = líneas recogidas ÷ tiempo de picking.
- **Tiempo objetivo:** cada almacén tiene un parámetro de horas objetivo por prioridad. Su cumplimiento es un indicador; el valor no se escribe en el código.
- Un faltante registra la **demanda no atendida** (§6.1) y deja la orden en `con_faltante` hasta que Gerencia o el supervisor decidan despachar parcial o esperar.
- El descuento de existencia y el costo de venta se registran al **confirmar la salida de mercancía** (§8), no al crear el picking.
- El almacenista solo ve las órdenes de sus almacenes (`usuario_almacen`).

**Cómo quedó el picking y la salida de mercancía (migración 0018)**
- El picking se activa por almacén (`almacen.usa_picking`); en el mostrador puede apagarse y la salida se confirma directo desde la nota de entrega. Al generar la nota se crea la orden con sus productos inventariables; la orden lleva un número correlativo (`numerador` `picking`).
- Estados y transiciones validados en la base de datos: `pendiente → asignada → en_proceso → completa | con_faltante`; `con_faltante` vuelve a `en_proceso` (esperar) o se cierra con el despacho parcial; cualquier orden vigente puede pasar a `cancelada` al anular la nota. El empaque (`empacada_at`) solo se registra con la orden completa.
- Las marcas de hora las pone la base de datos. Espera, picking, ciclo total, líneas por hora y cumplimiento del objetivo salen de la vista `vw_picking_tiempos`. Las horas objetivo por prioridad (1 a 5) están en `almacen_picking_objetivo` y las fija Gerencia en la pantalla del almacén.
- **Faltante:** cada línea no recogida completa exige su motivo. Con la orden en `con_faltante`, Gerencia o el Supervisor de ventas deciden. *Esperar* la reabre. *Despachar parcial* registra la demanda no atendida por lo que faltó, anula la nota, emite otra con lo realmente recogido y mueve la **misma** orden a la nota nueva, completa y con sus tiempos originales. Lo que faltó deja de estar reservado: la diferencia con la existencia del sistema se corrige con un conteo.
- **Salida de mercancía** (`confirmarSalida`): exige el picking completo y empacado (si el almacén lo usa), consume las reservas, registra un movimiento `salida_venta` por línea al costo promedio vigente, guarda ese costo en la línea (`costo_unitario_usd`) y deja la nota como despachada (`salida_at`). El asiento sale del motor con el evento `salida_venta`: **Debe** Costo de ventas (5.1.01), **Haber** Inventario de mercancía (1.3.01), en USD a la tasa BCV del día. Todo ocurre en una sola transacción; si el periodo está cerrado, nada se guarda. Una nota despachada no se anula: se corrige con una devolución.
**Transporte y despacho**

*Vías de distribución.* Una nota de entrega sale por una de estas vías, que en el ERP son tipos de transportista (`modalidad`):

| Modalidad | Qué es | Vehículos | Cómo se cobra |
|---|---|---|---|
| `flota_propia` | Reparto con camiones o motos de la empresa, urbano o extraurbano | Sí, con capacidad y costo por km y por hora | Costo interno (combustible, chofer): no tiene tarifa |
| `carga` | Transportista de carga contratado | Sí (los de ese transportista) | Tarifa por viaje, kg, m³ o bulto, según destino |
| `encomienda` | Servicio de entrega de terceros (courier o encomienda nacional) | No: el servicio decide | Tarifa por kg o bulto, según destino |

Un transportista de terceros (`carga` o `encomienda`) es un **proveedor de tipo servicios, ya aprobado** (§5.1): hereda su alta con aprobación de Gerencia y sus datos fiscales, y la factura de su servicio entrará por cuentas por pagar. La flota propia no tiene proveedor.

```sql
create table transportista (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(10) not null unique,                       -- T00001, asignado por el numerador
  nombre text not null, modalidad text not null check (modalidad in ('flota_propia','carga','encomienda')),
  proveedor_id uuid references proveedor(tercero_id),       -- obligatorio si no es flota propia; no cambia
  contacto_telefono text, observaciones text, activo boolean not null default true,
  check ((modalidad = 'flota_propia') = (proveedor_id is null))
);
create table vehiculo (
  id uuid primary key default gen_random_uuid(),
  transportista_id uuid not null references transportista(id),      -- no aplica a 'encomienda'
  placa varchar(10) not null unique, descripcion text not null,
  capacidad_kg numeric(10,2), capacidad_m3 numeric(8,3),
  costo_km_usd numeric(10,4), costo_hora_usd numeric(10,2),         -- parámetros del ruteo (Etapa C)
  activo boolean not null default true
);
create table transportista_tarifa (                          -- se agrega una nueva con su vigencia: no se edita ni se borra
  id uuid primary key default gen_random_uuid(),
  transportista_id uuid not null references transportista(id),
  entidad_federal text, ciudad text,                         -- destino; vacío = cualquier destino
  unidad_cobro text not null check (unidad_cobro in ('por_viaje','por_kg','por_m3','por_bulto')),
  moneda char(3) not null references moneda(codigo), monto numeric(14,4) not null check (monto >= 0),
  minimo numeric(14,2) not null default 0,
  vigente_desde date not null, vigente_hasta date
);
create table transporte (
  id uuid primary key default gen_random_uuid(),
  serie varchar(4) not null default 'A', numero bigint not null,       -- correlativo, sin huecos (§3.3); lo conserva si se anula
  estado text not null default 'planificado' check (estado in ('planificado','cargado','en_ruta','entregado','cerrado','anulado')),
  almacen_id uuid not null references almacen(id),                      -- punto de salida de todas sus notas
  transportista_id uuid not null references transportista(id), vehiculo_id uuid references vehiculo(id), chofer text,
  fecha_programada date not null,
  cargado_at timestamptz, salida_at timestamptz, cierre_at timestamptz,  -- las pone la base de datos
  flete_usd numeric(14,2) not null default 0,
  observaciones text, anulado_por uuid, anulado_at timestamptz, anulado_motivo text,
  unique (serie, numero)
);
create table transporte_parada (
  id uuid primary key default gen_random_uuid(),
  transporte_id uuid not null references transporte(id),
  nota_entrega_id uuid not null references documento_venta(id),
  direccion_entrega_id uuid not null references cliente_direccion_entrega(id),
  orden smallint not null,
  llegada_at timestamptz,
  resultado text check (resultado in ('entregada','no_entregada')), resultado_at timestamptz,
  recibido_por text, incidencia text,
  vigente boolean not null default true                                 -- una nota solo tiene una parada vigente
);
```

*Cómo funciona (Etapa A: transporte manual, migración 0026).*
- **Crear transporte:** Almacén (de sus almacenes) o Gerencia crea el transporte con su almacén de salida, transportista, vehículo, chofer y fecha. Agrega paradas: cada una es una nota de entrega emitida del mismo almacén con su dirección de entrega (por defecto la predeterminada del cliente, que debe estar activa y ser de ese cliente). Si el almacén usa picking, la nota debe tener el picking completo y empacado. Una nota solo tiene una parada vigente: no puede estar en dos transportes a la vez.
- **Estados** (validados en la base): `planificado → cargado → en_ruta → entregado → cerrado`. Solo un transporte `planificado` se anula (con motivo): una vez cargado, la mercancía ya salió del inventario.
  - *Cargar* confirma la **salida de mercancía** de cada nota que aún no haya salido (la misma operación y el mismo asiento de §6.4 *Salida de mercancía*), y exige vehículo y chofer si la modalidad tiene vehículos.
  - *Salir a ruta* pone la hora de salida. Cada parada registra su llegada y su resultado: `entregada` (con quien recibió) o `no_entregada` (con la incidencia). Las horas las pone la base de datos, nunca se digitan.
  - Con todas las paradas resueltas el transporte pasa a `entregado`; al **cerrar** se registra el flete real (USD) y las paradas no entregadas quedan libres para planificarlas en otro transporte.
- **Capacidad:** la pantalla suma peso y volumen de la carga con las medidas del producto (§5.3) y avisa si excede la capacidad del vehículo o si hay productos sin medidas. Es un aviso: en la Etapa C el ruteo la respeta como restricción.
- **Constancia de entrega:** cada parada admite un adjunto (§4.2) con la nota firmada.
- **Tarifas de terceros:** se cargan en la ficha del transportista, con vigencia por fecha y destino. No se editan: una nueva tarifa cierra la anterior y no puede solaparse con otra del mismo destino y unidad. La comparación de costos entre vías con estas tarifas (y con el costo por km y por hora de los vehículos propios) se hace en el sugerido de distribución (Etapa C); en la Etapa A las tarifas se consultan y se mantienen, pero el transporte no calcula todavía un flete estimado.
- **Flete y contabilidad:** el `flete_usd` real queda en el transporte para los indicadores. Su gasto contable sale de **la factura del transportista** (cuentas por pagar, módulo de gastos de la Fase 3), no del transporte: la flota propia no tiene factura y sus costos se registran por sus propios gastos.
- **Indicadores** (vista `vw_transporte_resumen`, calculados una sola vez): cumplimiento de la fecha programada, tiempo de tránsito, entregas con incidencia y llegadas dentro de la ventana de recepción del cliente.
- **Validar con el asesor tributario** qué documento debe acompañar la mercancía durante el traslado (guía de despacho o la propia factura o nota de entrega).

*Hoja de ruta de la optimización de rutas (Etapas B a D, aún no construidas).*
1. **Etapa B:** mapa con Leaflet y OpenStreetMap para marcar la ubicación del cliente; distancias y horas de llegada por calles reales con OpenRouteService (plan gratuito: matriz y optimización con límite diario). El acceso va detrás de un `ServicioRutas` con proveedores intercambiables (se puede pasar a una instalación propia de OSRM y VROOM sin cambiar el resto). Solo se envían coordenadas, nunca nombres ni RIF. Orden sugerido de paradas con la ventana blanda como penalización.
2. **Etapa C:** *sugerido de distribución* sobre las notas pendientes de despacho. Elige la vía de cada nota (flota propia urbana, flota propia extraurbana, transportista de carga, encomienda o retiro en mostrador) comparando costo estimado, capacidad, ventana de recepción y urgencia, y arma rutas por vehículo con capacidad y ventanas. Los pesos de los criterios (costo, kilómetros, puntualidad, prioridad) son parámetros que fija Gerencia, no valores del código. El usuario revisa y ajusta antes de confirmar, y al confirmar se crea el transporte de esta sección.
3. **Etapa D:** calibración con las entregas reales (hora de llegada contra la estimada) para ajustar los tiempos de viaje y de descarga, e indicadores de cumplimiento de ventana.

### 6.5 CRM y postventa (módulo CR)
Amplía la relación con el cliente antes y después de la venta. Usa los terceros y clientes de la §5.1 y no duplica sus datos.

```sql
create table contacto (
  id uuid primary key default gen_random_uuid(),
  tercero_id uuid not null references tercero(id),
  nombre text not null, cargo text, telefono text, correo text, principal boolean not null default false, activo boolean not null default true
);
create table oportunidad (
  id uuid primary key default gen_random_uuid(),
  tercero_id uuid not null references tercero(id),          -- prospecto o cliente
  vendedor_id uuid not null references vendedor(id),
  etapa text not null default 'prospecto' check (etapa in ('prospecto','calificada','cotizada','negociacion','ganada','perdida')),
  monto_estimado_usd numeric(14,2) not null default 0,
  cierre_estimado date, motivo_perdida text,
  cotizacion_id uuid references documento_venta(id),        -- se enlaza al cotizar
  created_at timestamptz not null default now(), cerrada_at timestamptz
);
create table actividad_crm (
  id uuid primary key default gen_random_uuid(),
  tercero_id uuid not null references tercero(id), oportunidad_id uuid references oportunidad(id),
  tipo text not null check (tipo in ('visita','llamada','mensaje','correo','tarea')),
  usuario_id uuid not null references usuario(id),
  fecha timestamptz not null, resultado text, proxima_accion text, proxima_fecha date
);
create table caso_postventa (
  id uuid primary key default gen_random_uuid(),
  tercero_id uuid not null references tercero(id), documento_venta_id uuid references documento_venta(id),
  tipo text not null check (tipo in ('reclamo','garantia','devolucion','consulta')),
  estado text not null default 'abierto' check (estado in ('abierto','en_analisis','resuelto','cerrado')),
  responsable_id uuid references usuario(id), descripcion text not null, causa text, solucion text,
  abierto_at timestamptz not null default now(), resuelto_at timestamptz
);
```
**Reglas**
1. Un **prospecto** es un tercero que aún no es cliente. Al ganar la primera oportunidad se convierte en cliente por el mismo proceso de alta con aprobación de Gerencia (§5.5). No se puede pedir ni facturar a un prospecto.
2. Las **etapas** de una oportunidad avanzan una a una; pasar a `cotizada` exige enlazar una cotización, y `ganada` genera el pedido desde ella. `perdida` exige motivo.
3. Las **probabilidades por etapa** (para el pronóstico del embudo) son parámetros editables, no valores fijos en el código.
4. **Un vendedor ve solo sus prospectos, oportunidades y actividades** (seguridad por fila); el supervisor ve las de su equipo.
5. Un caso de tipo `devolucion` no mueve inventario: origina la **NC por devolución** de la §6.2, con su aprobación del supervisor.
6. **Indicadores:** embudo por etapa, tasa de conversión, valor ponderado del embudo, actividades por vendedor, clientes sin contacto en N días (parámetro), y tiempo de resolución de casos.
7. Los datos de contacto son personales: no van en URLs ni en registros de error (AGENTS.md §6).

---

## 7. Compras: de la orden al pago (Procure-to-Pay)

```mermaid
flowchart LR
  REQ[Requisición] --> OC[Orden de compra\n(aprobación por monto)]
  OC --> TR[Tránsito / importación\n(BL, ETA: módulo existente)]
  TR --> REC[Recepción\n(cantidades reales)]
  OC --> REC
  REC --> FCP[Factura de compra]
  FCP -->|conciliación a 3 vías| CXP[Partida CxP]
  FCP --> RETE[Retenciones IVA / ISLR emitidas]
  CXP --> PROG[Programación de pagos]
  PROG --> PAG[Pago + IGTF]
  IMPG[Gastos de importación:\nflete, aduana, agente] --> LC[Costo en destino\n(prorrateo a la recepción)]
  LC --> REC
```

### 7.1 Documentos
- `documento_compra` con tipos `requisicion`, `orden_compra`, `recepcion`, `factura_compra`, `nota_credito_proveedor` y `nota_debito_proveedor`. Siguen la misma estructura de encabezado y líneas que ventas, con `proveedor_id`, `numero_factura_proveedor` y `numero_control_proveedor`.
- `importacion` (módulo propio del ERP): expediente de embarque con BL, naviera, buque, puertos, ETD/ETA y estado (`consolidando`, `en_agua`, `puerto`, `aduana`, `recibido`). Se enlaza con las órdenes de compra y las recepciones. Sus gastos (flete, seguro, aranceles, agente de aduana) se registran como **facturas de compra de servicios** que se prorratean al costo de la mercancía.

### 7.2 Reglas
1. **Conciliación a tres vías:** la factura del proveedor se compara con la orden de compra (precio) y con la recepción (cantidad).
   - Dentro de la tolerancia (parámetro, p. ej. 2 % o 1 USD por línea): se contabiliza sola.
   - Fuera de ella: queda **retenida** para revisión y no se puede pagar.
2. **Mercancía recibida sin facturar:** la recepción valoriza el inventario al precio de la orden de compra contra una cuenta puente. La factura liquida esa cuenta, y cualquier diferencia de precio ajusta el costo si la mercancía sigue en existencia.
3. **Costo en destino (landed cost):** flete, seguro, aranceles, tasas aduaneras y gastos de agente se **capitalizan en el inventario**. Se prorratean entre las líneas de la recepción según el criterio elegido al registrar la compra: **valor FOB, peso, volumen o cantidad**. Peso y volumen salen de las medidas del producto (§5.3: peso por unidad, unidades por empaque y dimensiones del empaque); un producto sin la medida del criterio elegido bloquea el reparto hasta completarla. Si el gasto llega después de vendida la mercancía, la parte correspondiente va a costo de ventas.
4. **Retenciones al contabilizar la factura:**
   - **IVA (§11.2):** si la empresa es agente de retención, 75 % del IVA, o 100 % en los supuestos de la norma.
   - **ISLR (§11.2):** según el concepto del Decreto 1.808 y el tipo de proveedor.
   - Se genera el **comprobante** con numeración propia y se reduce la partida por pagar.
5. **Duplicados:** se bloquea una factura con el mismo proveedor, número y monto.

**Construido (migración 0023): orden de compra y recepción.**
- **Orden de compra** (`documento_compra`, tipo `orden_compra`): la arma Compras en borrador (proveedor activo, almacén de recepción, moneda, productos con cantidad y precio, fecha de entrega prometida). Al enviarla recibe su número, la base calcula el total y su equivalente en USD a la tasa BCV del día, y queda `pendiente`. La aprueba Gerencia por el motor de flujo (`orden_compra`), **nunca quien la creó** (la base lo exige). Enviada no se edita ni se borra: se aprueba, se rechaza con motivo o se anula con motivo (no se anula si ya tiene mercancía recibida). Hoy toda orden pasa por Gerencia; el umbral por monto se define en Configuración → Flujos.
- **Criterio de reparto:** cada orden guarda cómo se repartirán los gastos de importación (valor, peso, volumen o cantidad). Con peso o volumen, todos sus productos deben tener esa medida en el maestro (§5.3) o la orden no se envía. El cálculo exacto a centavos está en `repartirCosto` (`src/lib/compras/costo-destino.ts`), listo para la factura de gastos.
- **Recepción** (tipo `recepcion`): solo contra una orden aprobada y del almacén del usuario (Almacén o Gerencia). Se indica lo realmente recibido de cada línea, sin pasar de lo pendiente (se valida con la orden bloqueada, para que dos recepciones simultáneas no se pasen). En una sola transacción: entrada de inventario por línea al precio de la orden convertido a USD (precio × tasa de la moneda ÷ tasa del USD, del día de la recepción), costo promedio y asiento `recepcion_compra` (Debe inventario 1.3.01, Haber mercancía recibida no facturada 2.1.02). Una recepción emitida no se edita ni se anula.
**Construido (migración 0024): factura de compra, conciliación a tres vías y cuentas por pagar.**
- **Factura de compra** (`factura_compra`, tabla propia): se arma contra una orden aprobada con el número, el control y la fecha de la factura del proveedor; cada línea se enlaza a una línea de la orden (cantidad y precio facturados). El IVA sale de la alícuota del producto vigente a la fecha de la factura. Un proveedor no repite su número de factura. Moneda: la de la orden.
- **Conciliación:** solo se factura lo recibido y aún no facturado de cada línea (si no, se rechaza). El precio se compara con el de la orden: la diferencia de cada línea es aceptable si no pasa del `TOLERANCIA_PRECIO_PCT` % del valor de la línea **o** de `TOLERANCIA_PRECIO_USD` USD (tabla `parametro_compra`, valores iniciales 2 % y 1 USD, a confirmar por Gerencia). Dentro de tolerancia la factura se contabiliza sola; si no, queda `retenida`, no abre cuenta por pagar (no se puede pagar) y la decide Gerencia por el motor de flujo (`factura_compra`), nunca quien la registró; si se rechaza, no mueve nada y el número se puede volver a registrar.
- **Contabilización** (evento `factura_compra`, en la moneda de la factura): Debe mercancía recibida no facturada (2.1.02) por lo que valorizó la recepción, Debe IVA crédito fiscal (1.2.03), Haber cuentas por pagar (2.1.01), y la diferencia contra lo facturado se reparte: lo que corresponde a unidades que siguen en existencia ajusta el inventario y el costo promedio (`ajuste_costo`, inmutable) y lo que corresponde a unidades ya vendidas va al costo de ventas (5.1.01). Las unidades en existencia se toman de la existencia total del producto. La diferencia incluye el efecto de la tasa entre la recepción y la factura mientras la decisión 2 (diferencial cambiario) siga abierta. La última factura de una línea liquida el resto exacto de la recepción, sin centavos huérfanos.
- **Cuentas por pagar** (`partida_cxp`): una partida por factura contabilizada con su vencimiento (fecha de la factura + días de la condición de pago, o el que se indique). Su saldo solo cambia con un pago, una nota del proveedor o una retención (pendientes). Una factura contabilizada no se edita ni se anula: se corregirá con la nota de crédito o de débito del proveedor.

**Construido (migración 0025): gastos de importación y costo en destino.**
- **Gasto de importación** (`gasto_importacion`): la factura del proveedor de servicios (flete, seguro, aranceles, agente de aduana, almacenaje u otros) con su monto sin IVA, aplicada a una o más recepciones emitidas. En borrador se ve la **vista previa del reparto**; al registrar se guarda línea por línea (`gasto_importacion_reparto`).
- **Reparto:** por **valor** (lo que costó cada línea en USD), **peso** (cantidad × kg por unidad), **volumen** (cantidad × m³ por unidad) o **cantidad**, a elección de quien compra; la orden propone el suyo y se puede cambiar en el borrador. La suma de las partes es exactamente el gasto. Si a algún producto le falta la medida del criterio, no se registra y se indica cuáles faltan.
- **Contabilización** (evento `gasto_importacion`, en la moneda de la factura): lo que corresponde a unidades que siguen en existencia se capitaliza en el inventario (ajuste de costo y costo promedio) y lo de unidades ya vendidas va al costo de ventas; el IVA a crédito fiscal y el total a cuentas por pagar (misma `partida_cxp`). Un gasto registrado no se edita ni se borra.
- **Pendiente de la Fase 3:** devolución a proveedor y notas de crédito y débito del proveedor, retenciones de IVA e ISLR (comprobantes en la Fase 4), pagos y programación de pagos, IGTF pagado, gastos y caja chica, tesorería, conciliación bancaria y producción.

### 7.3 Cuentas por pagar y pagos
- `partida_cxp`, `pago` y `aplicacion_pago`, simétricos a CxC.
- **Programación de pagos** por vencimiento, con aprobación de Gerencia y descuentos por pronto pago del proveedor.
- **IGTF pagado:** si se paga en divisas a un agente de percepción, el IGTF se registra como gasto financiero.
- **Validaciones antes de pagar:** proveedor activo, factura conciliada o aprobada y cuenta bancaria del proveedor verificada. Un cambio reciente en la cuenta bancaria del proveedor exige doble aprobación, como control antifraude.

---

## 8. Inventario y costos

### 8.1 Movimientos
```sql
create table movimiento_inventario (
  id            bigint generated always as identity primary key,
  fecha         timestamptz not null,
  tipo          text not null check (tipo in ('entrada_compra','salida_venta','devolucion_cliente','devolucion_proveedor',
                                             'transferencia_salida','transferencia_entrada','ajuste_positivo','ajuste_negativo',
                                             'consumo_produccion','entrada_produccion','apertura')),
  producto_id   uuid not null references producto(id),
  almacen_id    uuid not null references almacen(id),
  cantidad      numeric(14,4) not null check (cantidad <> 0),   -- con signo: + entra, − sale
  costo_unitario_usd numeric(16,4) not null,
  costo_total_usd    numeric(16,2) not null,
  origen_tipo   text not null, origen_id uuid not null,         -- documento que lo generó
  created_by uuid not null
);

create table existencia (                   -- saldo por producto y almacén; se actualiza en la misma transacción
  producto_id uuid references producto(id),
  almacen_id  uuid references almacen(id),
  cantidad    numeric(14,4) not null default 0,
  reservado   numeric(14,4) not null default 0,
  primary key (producto_id, almacen_id),
  check (reservado >= 0 and reservado <= greatest(cantidad, 0))
);

create table producto_costo (               -- costo promedio ponderado móvil: uno por producto para toda la empresa (decisión 5)
  producto_id        uuid primary key references producto(id),
  cantidad           numeric(14,4) not null default 0,
  valor_usd          numeric(18,2) not null default 0,
  costo_promedio_usd numeric(16,4) not null default 0 check (costo_promedio_usd >= 0)
);
-- "Sin existencia negativa en almacenes comerciales" se valida con un TRIGGER:
-- Postgres no admite subconsultas dentro de CHECK.
```
**Existencia y costo al cierre de cada día (migración 0019):** `existencia_diaria` (por producto y almacén) y `costo_diario` (por producto) guardan el último valor de cada día. Los escriben solo los triggers de existencia y de costo, así que no dependen de un proceso programado; un día sin movimientos conserva el valor anterior (`fn_existencia_al`). `fn_dias_con_existencia` cuenta los días con existencia para vender, que es el denominador de la velocidad de venta ajustada (§8.3). Antes del primer registro de un producto no hay dato y esos días no se cuentan.

**Reglas en la base de datos (migración 0017):** un movimiento nunca se edita ni se borra; la existencia (`cantidad` y `reservado`) solo cambia por un movimiento o una reserva, nunca a mano; las salidas se valorizan al promedio vigente y la que vacía el producto se lleva todo el valor restante para no dejar centavos huérfanos; un almacén comercial no admite existencia negativa y ningún movimiento puede dejar la existencia por debajo de lo reservado.

Ningún movimiento se registra a mano: cada uno lo genera un documento (recepción, nota de entrega, factura, NC, transferencia, ajuste aprobado, conteo inicial). El tipo `apertura` se usa solo para el conteo físico del día de arranque (§14).

### 8.2 Método de costo
- **Costo promedio ponderado móvil (perpetuo)** en USD, **uno por producto para toda la empresa** (decisión 5, tomada).
  - Cada entrada recalcula: *(valor existente + valor de la entrada) ÷ (cantidad existente + cantidad de la entrada)*.
  - Cada salida se valoriza al promedio vigente.
  - Es el método más usado en distribución y el que mejor absorbe los gastos de importación prorrateados.
- El **costo de ventas** se registra en el mismo momento que la salida, a partir del movimiento de inventario, no del precio de la factura.
- El valor del inventario en el mayor (VES y USD) debe **cuadrar** con la suma de `existencia × costo promedio`. La diferencia se revisa en el cierre mensual.

### 8.3 Procesos
- **Transferencias** entre almacenes o sucursales con estado en tránsito.
- **Toma física** por ciclos (clase ABC), con congelamiento del conteo y ajuste aprobado. Los faltantes y sobrantes van a una cuenta de gasto específica.
- **Ajuste de inventario (migración 0020):** Almacén cuenta y agrega lo contado de cada producto; cada línea guarda lo que decía el sistema al contar, lo contado y, si hay diferencia, su motivo del catálogo de mermas. Al enviarlo recibe su número y queda pendiente: Gerencia lo aprueba o lo rechaza por el motor de flujo, y **nunca** lo aprueba quien lo creó ni quien hizo el conteo (la base de datos lo exige). Al aprobar se aplica la **diferencia** de cada línea (no el saldo del día de la aprobación, para no perder movimientos intermedios) con movimientos `ajuste_negativo` al costo promedio vigente y `ajuste_positivo` al costo promedio, o al costo indicado si el producto todavía no tiene. Su asiento sale del motor: faltante, Debe 5.1.02 y Haber Inventario; sobrante, Debe Inventario y Haber 5.1.02, en USD a la tasa del día. Un faltante no puede dejar la existencia por debajo de lo reservado.
- **Disponibilidad y velocidad de venta (migración 0027):** `fn_disponibilidad(desde, hasta)` calcula, para cada producto con registro de existencia, los días del periodo, los **días con existencia** (existencia de los almacenes que venden mayor que cero al cierre del día), los **días sin existencia**, el % de disponibilidad, las unidades vendidas (salidas por venta menos devoluciones de clientes), la **velocidad básica** (÷ días del periodo) y la **ajustada** (÷ días con existencia), la existencia comercial al cierre, la **cobertura en días**, la **venta perdida estimada** (días sin existencia × velocidad ajustada, en unidades y a precio de la lista A vigente al cierre) y el **estado de salud**. Se calcula por tramos entre un cambio de existencia y el siguiente, no día por día, y debe coincidir con `fn_dias_con_existencia` (se prueba). Antes del primer registro del producto no hay dato: el periodo cuenta desde ahí. La vista `vw_disponibilidad` aplica la ventana vigente (`VENTANA_VELOCIDAD_DIAS`, 90 por defecto) terminada hoy.
  - **Estados de salud** (en este orden de prioridad): `RIESGO_QUIEBRE` (existencia ≤ 0 o cobertura menor al mínimo), `DEMANDA_REPRIMIDA` (disponibilidad menor al mínimo con velocidad ajustada mayor a la indicada), `SOBRESTOCK` (cobertura mayor al máximo con ventas), `SIN_ROTACION` (hay existencia y no se vendió nada en el periodo) y `SALUDABLE`. `SIN_ROTACION` se agregó a los cuatro de spec_reportes §9.1: sin él, la existencia que no se vende aparecía como saludable.
  - **Parámetros** (`parametro_inventario`, valores de referencia que Gerencia debe confirmar; aún sin pantalla para editarlos): `VENTANA_VELOCIDAD_DIAS` 90, `COBERTURA_RIESGO_DIAS` 15, `DISPONIBILIDAD_REPRIMIDA` 60 %, `VELOCIDAD_REPRIMIDA` 0,1 unidades por día y `COBERTURA_SOBRESTOCK_DIAS` 180. Sin un parámetro, el cálculo falla: nunca se inventa un umbral.
  - **Pantalla:** Inventario → Disponibilidad y velocidad de venta (`/reportes/inventario`), primera pestaña del módulo M6 de [spec_reportes.md](spec_reportes.md).
- **Reservas** por pedido aprobado, **punto de reorden** y **sugerido de compra**. El sugerido usa la velocidad de venta ajustada por los días con existencia, la cobertura deseada y lo pendiente en tránsito y en producción, todo calculado con los movimientos registrados en el ERP.
- **Órdenes de producción o ensamblaje:** ver §8.4.

### 8.4 Producción o ensamblaje (módulo PP)
Se adopta el alcance de **órdenes simples** (decisión 12). No hay listas de materiales ni planificación de capacidad.
- La orden indica el producto terminado, la cantidad, el almacén y los componentes con su cantidad. Estados: `borrador`, `liberada`, `en_proceso`, `terminada`, `anulada`.
- Al terminar: salida de los componentes al costo promedio vigente y entrada del producto terminado a la suma de esos costos (más mano de obra o gastos si Gerencia los asigna). Todo en una sola transacción y con su asiento del motor contable.
- No se consume más de la existencia disponible ni se termina una orden sin todos sus componentes.
- Si el negocio llega a requerir listas de materiales, se agrega como ampliación y se actualiza esta sección.

---

## 9. Comisiones de venta

### 9.1 Principios (mejores prácticas)
- **Base de cálculo recomendada: lo cobrado, no lo facturado.** Alinea al vendedor con la cobranza. En la operación actual se observan diferencias de 21 a 90 días de pago promedio entre vendedores. Se paga en el periodo en que el cobro se aplica.
- **Base neta:** sin IVA, sin IGTF, sin notas de crédito por devolución y sin descuentos por pronto pago.
- **Reversión (clawback) explícita:** si después de pagada la comisión llega una devolución o una NC sobre esa factura, la comisión correspondiente se descuenta de la **próxima liquidación**. El saldo negativo no se arrastra más de dos periodos. Cada reversión aparece en el estado de comisiones con el hecho que la originó, el documento de referencia y el cálculo.
- **Transparencia:** el vendedor ve en tiempo real su comisión devengada, la pendiente de cobro y las reversiones.

### 9.2 Modelo
```sql
create table plan_comision (
  id uuid primary key default gen_random_uuid(),
  nombre text not null, vigente_desde date not null, vigente_hasta date,
  base text not null default 'cobrado' check (base in ('cobrado','facturado')),
  aprobado_por uuid
);

create table plan_comision_regla (               -- se evalúan por prioridad; la primera que aplica gana
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plan_comision(id),
  prioridad int not null,
  grupo_producto_id uuid, marca_id uuid,          -- null = todos
  dias_cobro_max int,                             -- p. ej. cobrado en ≤ 30 días → tasa completa
  cumplimiento_meta_min numeric(5,2),             -- tramos por % de meta del periodo
  margen_min_pct numeric(5,2),                    -- opcional: comisionar solo ventas con margen suficiente
  porcentaje numeric(5,2) not null check (porcentaje >= 0)
);

create table comision_movimiento (
  id bigint generated always as identity primary key,
  vendedor_id uuid not null references vendedor(id),
  periodo char(7) not null,                       -- 'YYYY-MM' en que se devenga
  tipo text not null check (tipo in ('devengo','reversion','ajuste_manual')),
  origen_tipo text not null, origen_id uuid not null,   -- aplicacion_cobro, nota_credito…
  factura_id uuid references documento_venta(id),
  base_usd numeric(16,2) not null,
  porcentaje numeric(5,2) not null,
  monto_usd numeric(16,2) not null,
  regla_id uuid references plan_comision_regla(id),
  liquidacion_id uuid references liquidacion_comision(id),
  unique (tipo, origen_tipo, origen_id, vendedor_id)    -- idempotencia
);

create table liquidacion_comision (
  id uuid primary key default gen_random_uuid(),
  vendedor_id uuid not null, periodo char(7) not null,
  total_devengado_usd numeric(16,2), total_reversiones_usd numeric(16,2),
  retencion_islr numeric(16,2) not null default 0,       -- si el vendedor es externo
  neto_usd numeric(16,2), tasa numeric(18,6),
  estado text not null check (estado in ('borrador','aprobada','pagada')),
  aprobada_por uuid, pago_id uuid,
  unique (vendedor_id, periodo)
);
```

### 9.3 Flujo
1. **Aplicar un cobro a una factura** genera un `comision_movimiento` de tipo `devengo` por la parte neta cobrada, usando la regla vigente en la **fecha de la factura**.
2. **Emitir una NC** (devolución o descuento) sobre una factura que ya comisionó genera una `reversion` proporcional.
3. **Cierre de mes:** se arma la `liquidacion_comision` en `borrador`. Gerencia la aprueba y Tesorería la paga.
   - **Asiento al devengar:** *Gasto de comisiones* contra *Comisiones por pagar*.
   - **Asiento al pagar:** *Comisiones por pagar* contra *Banco*, más la retención de ISLR si el vendedor es un comisionista externo (concepto de comisiones mercantiles del Decreto 1.808).
4. **Integración con metas:** el % de cumplimiento de la meta del vendedor en el periodo (tabla `meta_venta`) puede subir el porcentaje por tramos. Si no hay meta cargada, se usa el tramo base: **nunca una meta supuesta**.

**Criterio de aceptación:** el saldo de "Comisiones por pagar" en el mayor es igual a la suma de las liquidaciones aprobadas y no pagadas, más los devengos del mes en curso.

---

## 10. Gastos, tesorería y bancos

### 10.1 Registro de gastos
- **Categorías de gasto** vinculadas a una cuenta contable y a un centro de costo por defecto: alquiler, servicios, fletes de venta, publicidad, nómina (asiento importado), mantenimiento, comisiones bancarias, IGTF y otros.
- **Tipos de registro:**
  1. **Factura de gasto de proveedor:** usa el flujo de CxP, con IVA crédito fiscal (si es deducible) y retenciones.
  2. **Caja chica:** fondo fijo con vales y reposición contra comprobantes.
  3. **Reembolsos a empleados.**
  4. **Gastos recurrentes:** plantilla mensual, como alquiler o servicios.
- **Aprobación por monto** según la matriz de la §4.3. Cada gasto lleva adjunto el soporte (imagen o PDF).
- **Asiento:** *Gasto (según categoría)* + *IVA crédito fiscal* contra *Cuentas por pagar* o *Caja/Banco*, y *Retenciones por enterar* si aplica.

### 10.2 Tesorería y bancos
- **Cuentas bancarias** en VES, USD (nacionales, en el exterior o de custodia), efectivo en USD y USDT. Hoy la empresa cobra, entre otros, por Chase, USDT, Banesco, BNC y Bancamiga.
- **Movimientos bancarios** importados desde el estado de cuenta (CSV o Excel del banco) o registrados a mano.
- **Conciliación bancaria:**
  - Emparejamiento automático por monto, fecha (± N días) y referencia.
  - Revisión manual del resto.
  - Las partidas en tránsito quedan documentadas.
  - Se cierra por mes y por cuenta, y el saldo conciliado debe coincidir con el mayor.
- **Flujo de caja proyectado:** partidas por cobrar y por pagar por fecha de vencimiento, más gastos recurrentes, por moneda.
- **Transferencias entre cuentas propias y compra o venta de divisas:** se registran a la tasa real de la operación. La diferencia contra la tasa BCV va a diferencial cambiario.

---

## 11. Módulo fiscal Venezuela

> Todo lo de esta sección es **parametrizable con vigencia** y debe validarlo el asesor tributario. Las providencias citadas vienen de la investigación a septiembre de 2026 (§17).

### 11.0 Condición fiscal configurable
La condición fiscal de la empresa **no es una decisión del código: es configuración**. Vive en `empresa` (§4.2) y la edita el Administrador, con registro en `audit_log`:

| Campo | Efecto en el sistema |
|---|---|
| `contribuyente_especial` | Activa el calendario de declaraciones por quincena y las obligaciones de contribuyente especial (§11.4) |
| `agente_retencion_iva` | Al pagar a un proveedor se calcula la retención de IVA y se emite su comprobante; si no, esas pantallas y asientos no se activan |
| `agente_retencion_islr` | Al pagar se calcula la retención de ISLR según el concepto del proveedor y se genera el comprobante |
| `agente_percepcion_igtf` | Al cobrar en divisas se percibe el IGTF (§11.3); si no, el IGTF no se cobra al cliente |

- **Toda regla fiscal consulta estos campos** (los servicios y las reglas contables de la §12.3); ninguna lo da por supuesto.
- Un cambio de condición fiscal **aplica hacia adelante**: los documentos ya emitidos conservan la condición con que se emitieron.
- Cada documento emitido guarda si se aplicó retención o percepción, para poder reconstruir el libro y el asiento.

### 11.1 Emisión de documentos fiscales
- **Facturación digital:** la Providencia SNAT/2024/000102 (G.O. 43.032, 19-12-2024) regula la emisión por medios digitales. Es obligatoria para quienes venden exclusivamente por medios electrónicos y para contribuyentes con máquina fiscal que también operan en línea. En los demás casos es optativa.
  - Exige una **imprenta digital autorizada** que asigne el **número de control**, único y consecutivo (Providencia SNAT/2024/000121).
  - La factura debe llevar la fecha y hora en formato `DDMMAAAA HH.MM.SS`.
  - Hay que conservar y dar acceso a las facturas por **10 años**.
  - Hay que tener un **procedimiento de contingencia**: documentos con la marca "contingencia" que se registran después.
- **Decisión 4 (tomada):** el ERP emite por **imprenta digital**. La máquina fiscal (Providencia 0071) queda fuera del alcance; el adaptador se diseña con una interfaz que permitiría agregarla después.
- **Diseño del ERP:**
  - Un adaptador `ServicioNumeroControl` con la implementación de imprenta digital (API), detrás de una interfaz.
  - El número de control se guarda en el documento y nunca se reutiliza.
  - La factura en PDF se genera con todos los campos obligatorios: denominación "Factura", número, número de control, datos y RIF del emisor y del adquiriente, fecha y hora, descripción, base e IVA por alícuota, IGTF por separado y datos de la imprenta.
- **Facturas en divisas:** muestran el monto en la moneda de la operación y su equivalente en Bs a la tasa BCV del día. Así lo hace hoy la práctica del mercado; hay que confirmarlo con el asesor.

### 11.2 Impuestos y retenciones (tabla `parametro_fiscal`)

| Concepto | Regla a parametrizar (valores de referencia) | Documento que genera |
|---|---|---|
| **IVA** | Alícuota general 16 %, reducida 8 % y adicional para bienes de lujo; también exentos y exonerados | Débito fiscal (ventas) y crédito fiscal (compras) |
| **Retención de IVA emitida** (si la empresa es agente) | 75 % del IVA; 100 % si el IVA no viene discriminado, la factura no cumple requisitos o el proveedor no tiene RIF (Providencia SNAT/2025/000054, que derogó la SNAT/2015/0049) | Comprobante con numeración de **14 caracteres**, entregado dentro de los primeros 2 días hábiles del periodo siguiente. Declaración y entero **por quincena** según el calendario de contribuyentes especiales |
| **Retención de IVA recibida** (cuando el cliente es agente) | 75 % o 100 % | Registro del comprobante del cliente y crédito en la declaración |
| **Retención de ISLR** | Decreto 1.808, tabla del art. 9: porcentaje según concepto y tipo de persona, mínimos y sustraendo expresados en **Unidades Tributarias**. Parametrizar el valor de la UT (referencia: Bs 43,00 según la G.O. 43.140 del 02-06-2025) | Comprobante de retención y declaración mensual en XML |
| **IGTF** | 3 % sobre pagos en divisas o criptomonedas. La paga quien hace el pago; los contribuyentes especiales actúan como **agentes de percepción**. La tasa puede variar por decreto | Línea separada en la factura o el recibo. Declaración según calendario |

### 11.3 IGTF en la práctica
- Al registrar un **cobro** en divisas, si la empresa es agente de percepción, se calcula el IGTF sobre el monto en divisas. Se registra como pasivo "IGTF percibido por enterar" y se refleja en el recibo o la factura.
- Al registrar un **pago** en divisas a un agente de percepción, el IGTF es un **gasto financiero**. No se recupera.
- El IGTF **no forma parte** de la base del IVA y va en su propio reporte, no mezclado con los libros de IVA.

### 11.4 Libros y declaraciones
- **Libro de ventas y libro de compras** (Reglamento de la Ley de IVA, art. 75 y siguientes). Se generan como **vistas** por periodo, en el formato exigido y exportables:
  - Documentos emitidos, **anulados** y NC/ND, con número y número de control.
  - Base, alícuota, IVA, exentos y retenciones.
  - Resumen de débitos, créditos y retenciones.
- **Declaración de IVA** (resumen para el portal), **declaración de retenciones de IVA** (archivo del portal) y **retenciones de ISLR** (XML).
- **Cierre fiscal:** al declarar un periodo, sus documentos fiscales quedan **bloqueados**. Cualquier corrección se hace con documentos nuevos, NC o ND, en el periodo abierto.

---

## 12. Contabilidad general y estados financieros

### 12.1 Plan de cuentas (estructura base VEN-NIF, a ajustar con el contador)

| Código | Cuenta | Tipo | Notas |
|---|---|---|---|
| **1** | **ACTIVO** | | |
| 1.1.01 | Caja (VES, USD) | Activo | Una subcuenta por moneda |
| 1.1.02 | Bancos nacionales VES | Activo | Una por cuenta bancaria |
| 1.1.03 | Bancos en divisas y custodia | Activo | Chase, BofA, Bancamiga custodia… |
| 1.1.04 | Activos digitales (USDT) | Activo | Según política contable |
| 1.2.01 | Cuentas por cobrar comerciales | Activo | Controlada por el auxiliar CxC |
| 1.2.02 | Anticipos a proveedores | Activo | |
| 1.2.03 | IVA crédito fiscal | Activo | |
| 1.2.04 | IVA retenido por clientes | Activo | Se descuenta en la declaración |
| 1.2.05 | ISLR retenido por clientes / anticipos de ISLR | Activo | |
| 1.3.01 | Inventario de mercancía | Activo | Controlada por el auxiliar de inventario |
| 1.3.02 | Mercancía en tránsito (importaciones) | Activo | |
| 1.4 | Propiedad, planta y equipo (neto) | Activo | Con depreciación |
| **2** | **PASIVO** | | |
| 2.1.01 | Cuentas por pagar a proveedores | Pasivo | Controlada por el auxiliar CxP |
| 2.1.02 | Mercancía recibida no facturada | Pasivo | Cuenta puente de la conciliación a tres vías |
| 2.1.03 | IVA débito fiscal | Pasivo | |
| 2.1.04 | Retenciones de IVA por enterar | Pasivo | |
| 2.1.05 | Retenciones de ISLR por enterar | Pasivo | |
| 2.1.06 | IGTF percibido por enterar | Pasivo | |
| 2.1.07 | Comisiones por pagar | Pasivo | |
| 2.1.08 | Anticipos de clientes | Pasivo | |
| 2.1.09 | ISLR por pagar | Pasivo | |
| **3** | **PATRIMONIO** | | Capital, reservas, utilidades acumuladas, resultado del ejercicio |
| 3.9.01 | Saldos de apertura | Puente | Solo para el arranque (§14.3). Debe quedar en cero al cerrar la apertura |
| **4** | **INGRESOS** | | |
| 4.1.01 | Ventas de mercancía | Ingreso | Subcuentas por sucursal o línea si se desea |
| 4.1.02 | (−) Devoluciones en ventas | Contra-ingreso | |
| 4.1.03 | (−) Descuentos en ventas (pronto pago y comerciales) | Contra-ingreso | |
| 4.2.01 | Ganancia por diferencial cambiario | Ingreso | Partida separada |
| 4.2.02 | Otros ingresos | Ingreso | |
| **5** | **COSTOS** | | |
| 5.1.01 | Costo de ventas | Costo | Desde los movimientos de inventario |
| 5.1.02 | Faltantes y sobrantes de inventario | Costo | |
| **6** | **GASTOS** | | |
| 6.1 | Gastos de venta | Gasto | Comisiones, fletes de despacho, publicidad |
| 6.2 | Gastos de administración | Gasto | Nómina, alquiler, servicios |
| 6.3.01 | Gastos financieros: IGTF, comisiones bancarias | Gasto | |
| 6.3.02 | Pérdida por diferencial cambiario | Gasto | Partida separada |
| 6.4 | ISLR del ejercicio | Gasto | |

### 12.2 Mayor general
```sql
create table cuenta_contable (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(20) not null unique, nombre text not null,
  tipo text not null check (tipo in ('activo','pasivo','patrimonio','ingreso','costo','gasto')),
  naturaleza char(1) not null check (naturaleza in ('D','A')),
  padre_id uuid references cuenta_contable(id),
  imputable boolean not null default true,        -- solo las hojas reciben movimientos
  moneda char(3),                                 -- si está fijada (p. ej. banco en USD)
  controlada_por text check (controlada_por in ('cxc','cxp','inventario','banco')),  -- no admite asientos manuales
  activa boolean not null default true
);

create table periodo_contable (
  id uuid primary key default gen_random_uuid(),
  anio smallint not null, mes smallint not null check (mes between 1 and 13),   -- 13 = periodo de cierre
  inicio date not null, fin date not null,
  estado text not null default 'abierto' check (estado in ('abierto','cerrado','bloqueado')),
  unique (anio, mes)
);

create table asiento (
  id uuid primary key default gen_random_uuid(),
  numero bigint not null unique,
  periodo_id uuid not null references periodo_contable(id),
  fecha date not null,
  tipo text not null check (tipo in ('automatico','manual','reverso','cierre','apertura','ajuste_cambiario')),
  descripcion text not null,
  origen_tipo text, origen_id uuid,               -- documento que lo generó
  reversa_de uuid references asiento(id),
  estado text not null default 'borrador' check (estado in ('borrador','contabilizado')),
  aprobado_por uuid, contabilizado_at timestamptz,
  created_by uuid not null, created_at timestamptz not null default now(),
  unique (origen_tipo, origen_id, tipo)           -- idempotencia del motor
);

create table asiento_linea (
  id bigint generated always as identity primary key,
  asiento_id uuid not null references asiento(id),
  cuenta_id uuid not null references cuenta_contable(id),
  centro_costo_id uuid references centro_costo(id),
  tercero_id uuid references tercero(id),
  debe_ves numeric(18,2) not null default 0, haber_ves numeric(18,2) not null default 0,
  debe_usd numeric(16,2) not null default 0, haber_usd numeric(16,2) not null default 0,
  moneda_original char(3) not null, monto_original numeric(16,2) not null, tasa numeric(18,6) not null,
  glosa text,
  check ((debe_ves > 0 and haber_ves = 0) or (debe_ves = 0 and haber_ves > 0) or (debe_ves = 0 and haber_ves = 0 and (debe_usd + haber_usd) > 0))
);
```
**Integridad en la base de datos (obligatoria):**
- Un trigger `DEFERRABLE INITIALLY DEFERRED` rechaza el paso a `contabilizado` si el asiento no cuadra **en VES**. En USD también debe cuadrar: el motor agrega una línea de redondeo de hasta 0,01 si hace falta.
- Un trigger rechaza insertar o modificar líneas de un asiento `contabilizado`, y cualquier asiento en un periodo `cerrado` (salvo reversos autorizados) o `bloqueado`.
- Las cuentas marcadas con `controlada_por` solo reciben asientos automáticos de su módulo.
- **Control diario:** una consulta de balance de comprobación que debe dar diferencia cero. Si no da cero, se genera una alerta de integridad.

### 12.3 Motor de contabilización: reglas de asientos automáticos
Las reglas viven en una tabla `regla_contable` (evento, condición, cuenta del debe, cuenta del haber, importe base). La tabla de abajo es la **configuración inicial** y sirve de lista de pruebas: cada fila necesita un test que verifique el asiento generado.

| Evento | Debe | Haber |
|---|---|---|
| Apertura: conteo inicial, saldo bancario, factura pendiente de cliente | Inventario / Banco o caja / CxC | Saldos de apertura |
| Apertura: factura pendiente de proveedor | Saldos de apertura | CxP proveedores |
| Asiento de apertura del contador (cierra la cuenta puente) | Saldos de apertura o cuentas de activo | Patrimonio y demás cuentas de pasivo |
| Factura de venta a crédito | CxC comerciales (total) | Ventas (base) · IVA débito fiscal (IVA) |
| Costo de la venta (al despachar o facturar) | Costo de ventas | Inventario (costo promedio) |
| NC por devolución | Devoluciones en ventas (base) · IVA débito fiscal (IVA) | CxC comerciales |
| Reingreso de la devolución al inventario | Inventario | Costo de ventas |
| NC por pronto pago o descuento comercial | Descuentos en ventas · IVA débito fiscal (si la NC lo discrimina) | CxC comerciales |
| Nota de débito: ajuste de precio | CxC comerciales | Ventas · IVA débito fiscal |
| Nota de débito: intereses y otros | CxC comerciales | Otros ingresos · IVA débito fiscal |
| Cobro (eventos `cobro` y `aplicacion_anticipo`) | Banco o caja (monto a la tasa del cobro) · Pérdida cambiaria | CxC (monto a la tasa de la factura) · Anticipos de clientes (si queda saldo) · Ganancia cambiaria |
| IGTF percibido en el cobro | Banco o caja | IGTF percibido por enterar |
| Retención de IVA recibida | IVA retenido por clientes | CxC comerciales |
| Anticipo de cliente (la parte del cobro sin aplicar) | Banco | Anticipos de clientes |
| Aplicación de un anticipo a una factura | Anticipos de clientes (a su valor en los libros) · Pérdida cambiaria (si la hay) | CxC comerciales (a su valor histórico) · Ganancia cambiaria (si la hay) |
| Recepción de compra | Inventario | Mercancía recibida no facturada |
| Factura de compra de mercancía | Mercancía recibida no facturada · IVA crédito fiscal | CxP proveedores |
| Diferencia de precio en la factura de compra | Inventario o costo de ventas | Mercancía recibida no facturada (o al revés) |
| Gasto de importación (costo en destino) | Inventario o mercancía en tránsito | CxP (agente, naviera, aduana) |
| Retención de IVA emitida | CxP proveedores | Retenciones de IVA por enterar |
| Retención de ISLR emitida | CxP proveedores | Retenciones de ISLR por enterar |
| Pago a proveedor | CxP (a la tasa de la factura) · Pérdida o ganancia cambiaria | Banco (a la tasa del pago) |
| IGTF pagado | Gastos financieros: IGTF | Banco |
| Entero de retenciones o IGTF | Retenciones por enterar / IGTF por enterar | Banco |
| Registro de gasto | Gasto (según categoría) · IVA crédito fiscal | CxP o caja/banco |
| Comisión devengada | Gasto de comisiones | Comisiones por pagar |
| Pago de comisiones | Comisiones por pagar | Banco · Retenciones de ISLR por enterar |
| Ajuste de inventario negativo o positivo | Faltantes de inventario / Inventario | Inventario / Sobrantes |
| Revaluación de partidas en divisas al cierre (si la política lo exige) | Partidas en divisas o diferencial | Diferencial o partidas en divisas |
| Terminar orden de producción | Inventario (producto terminado) | Inventario (componentes) |
| Flete de transporte cerrado | Gastos de venta: fletes | CxP (transportista) o Banco |
| Adquisición de activo fijo | Activo fijo (según categoría) · IVA crédito fiscal | CxP proveedores |
| Depreciación mensual | Gasto de depreciación | Depreciación acumulada |
| Baja o venta de activo fijo | Depreciación acumulada · Pérdida por baja (o Banco / CxC) | Activo fijo · Ganancia por venta |
| Cierre del ejercicio | Cuentas de ingreso | Cuentas de costo y gasto · Resultado del ejercicio |

### 12.4 Cierre mensual (checklist del sistema)
1. Todos los documentos del mes están emitidos o anulados. No quedan borradores con fecha del mes.
2. Conciliaciones bancarias cerradas.
3. Auxiliares contra mayor en cero: CxC, CxP, inventario, comisiones y mercancía recibida no facturada.
4. Retenciones y libros de IVA generados y declarados.
5. Asientos recurrentes y provisiones (depreciación, nómina) contabilizados.
6. Revisión del diferencial cambiario.
7. Periodo en `cerrado`, y en `bloqueado` después de la auditoría o de la declaración.

### 12.5 Estados financieros y reportes
Todos se generan **desde el mayor**, por periodo y comparativos, en **VES (legal)** y en **USD (gestión)**:

| Reporte | Contenido |
|---|---|
| **Balance de comprobación** | Saldos iniciales, movimientos y saldos finales por cuenta. Diferencia debe ser cero |
| **Estado de situación financiera (balance general)** | Activo, pasivo y patrimonio, corriente y no corriente |
| **Estado de resultados (ganancias y pérdidas)** | Ver estructura abajo |
| **Estado de flujo de efectivo** | Método indirecto: resultado ± partidas no monetarias ± cambios en capital de trabajo |
| **Estado de cambios en el patrimonio** | |
| **Libro diario y libro mayor** | Legales, en VES, con numeración |
| **Rentabilidad por dimensión** | Margen por cliente, producto o grupo, vendedor y sucursal: *venta neta − costo (foto del costo de la línea) − descuentos − comisiones* |
| **Reportes comerciales (M1-M6)** | Réplica del dashboard de ventas: clientes, productos, vendedores, cobranzas, devoluciones e inventario, según [spec_reportes.md](spec_reportes.md) |

**Estructura del estado de resultados:**
```
  Ventas brutas
− Devoluciones en ventas
− Descuentos en ventas (pronto pago y comerciales)
= VENTAS NETAS
− Costo de ventas
= UTILIDAD BRUTA                         (margen bruto %)
− Gastos de venta (comisiones, fletes, publicidad)
− Gastos de administración
= UTILIDAD OPERATIVA (EBIT)
± Resultado por diferencial cambiario    ← partida separada (VEN-NIF)
− Gastos financieros (IGTF, comisiones bancarias)
+ Otros ingresos
= UTILIDAD ANTES DE ISLR
− ISLR del ejercicio
= UTILIDAD NETA
```

**Reexpresión por inflación:** la BA VEN-NIF 2 regula el ajuste por inflación en entornos hiperinflacionarios. Si aplica o no a la empresa en cada ejercicio es una **decisión del contador** (§16). El modelo lo soporta mediante asientos de ajuste por periodo con INPC parametrizado.

### 12.6 Activos fijos (FI-AA)
- `activo_fijo`: código único, categoría (con su cuenta de activo, de depreciación acumulada y de gasto), fecha de adquisición, costo en VES y USD, vida útil en meses, valor residual, método (línea recta), estado (`activo`, `depreciado`, `dado_de_baja`) y ubicación o responsable.
- **Depreciación mensual** calculada por el sistema en el cierre (§12.4) y contabilizada por el motor. Un activo no se deprecia por debajo de su valor residual ni en periodos cerrados.
- **Alta** desde una factura de compra marcada como activo fijo, o desde el asiento de apertura (§14.3) con su depreciación acumulada al día de arranque.
- **Baja o venta:** documento con aprobación (§4.5); depreciación hasta la fecha y asiento de ganancia o pérdida.
- Cuadre: el auxiliar de activos (costo y depreciación acumulada) debe cuadrar con las cuentas del mayor.
- Los métodos de depreciación fiscal y la vida útil por categoría los define el contador (§16).

---

## 13. Hoja de ruta por fases

El ERP se construye y se prueba en un **entorno de pruebas** con datos de prueba creados para ese fin. La base de datos de **producción se crea vacía** con los scripts de migraciones de esquema y recibe su primer registro el día de arranque (§14). Los datos de prueba nunca pasan a producción.

| Fase | Alcance | Criterios de aceptación |
|---|---|---|
| **0. Fundaciones** | Repositorio nuevo, integración continua, migraciones de esquema versionadas. Usuarios, roles y auditoría. Sucursales, monedas y proceso diario de tasa BCV. Parámetros fiscales con vigencia, numeradores, plan de cuentas, periodos, mayor con triggers de integridad y motor de reglas contables | La base se crea desde cero solo con scripts. Un asiento que no cuadra se rechaza en la base de datos. No se puede contabilizar en un periodo cerrado. Todas las rutas exigen sesión |
| **1. Maestros** | Terceros, clientes, proveedores, vendedores, productos, referencias cruzadas, listas de precio, almacenes, bancos, metas y adjuntos, con validaciones de alta (RIF, duplicados, aprobación de crédito) | No se puede crear un tercero con RIF inválido o repetido. Ningún código duplicado. Un maestro con movimientos no se puede borrar |
| **2. Ventas, logística, CxC, inventario y emisión fiscal** | Flujo de trabajo y aprobaciones (§4.5) con migración de las aprobaciones existentes, pedido, nota de entrega, picking con tiempos y transporte (§6.4), factura con **número de control** (imprenta digital o máquina fiscal) y contingencia, NC/ND, cobros y aplicaciones, retenciones recibidas, pronto pago, movimientos de inventario, costo promedio y existencias | Auxiliar de CxC = mayor. Existencias = mayor de inventario. Asientos automáticos probados por regla (§12.3). Factura fiscal válida de punta a punta en el entorno de pruebas del proveedor de imprenta |
| **3. Compras, CxP, gastos, tesorería y producción** | Orden de compra, órdenes de producción simples (§8.4), recepción, factura con conciliación a tres vías, importaciones y costo en destino, pagos, IGTF, gastos y caja chica, cuentas bancarias y conciliación | Auxiliar de CxP = mayor. Una factura fuera de tolerancia no se puede pagar. Conciliación bancaria de prueba cerrada sin diferencias |
| **4. Fiscal** | Libros de compras y ventas, comprobantes y declaraciones de retención de IVA e ISLR, IGTF | Libros de un mes de prueba validados por el contador. Comprobantes con formato y numeración correctos |
| **5. Arranque en producción** | Configuración del día 0, registro de saldos iniciales como operaciones (§14), capacitación por rol y acompañamiento de la primera semana | Checklist de §14.6 completo y firmado por Gerencia y el contador |
| **6. Comisiones, estados financieros y reportes** | Planes de comisión, devengo, reversión y liquidación. Activos fijos y depreciación (§12.6). Estados financieros completos, cierre mensual e indicadores comerciales (§12.5). Puede entregarse durante el primer mes de operación, porque trabaja sobre los datos ya registrados | Primer cierre mensual completo en el ERP, con estados financieros revisados por el contador |
| **7. CRM y portal de clientes (portal opcional)** | CRM y postventa (§6.5): prospectos, contactos, oportunidades, actividades y casos. Portal: pedidos y envío de comprobantes de pago por parte de los clientes, con acceso limitado a sus propios documentos | Un vendedor no ve el CRM de otro y un prospecto no puede facturarse. Un cliente no puede ver datos de otro (prueba de seguridad por fila) |
| **8. Analítica avanzada** | Cuando haya al menos 12 meses de operación: pronóstico de ventas por producto de marca y por código común, conciliado entre ambos niveles; elasticidad de precio por segmento (categoría, marca, línea de calidad, lista); efecto de cada promoción frente a la venta esperada sin ella; calendario de feriados, quincenas y temporadas. Usa solo datos registrados en el ERP (código común, precio de lista y precio cobrado, promoción, costo, existencia diaria y demanda no atendida) | Cada modelo se valida contra meses reales que no usó para ajustarse, con su error publicado. Ningún pronóstico se muestra sin su margen de error. Sin historia suficiente, la pantalla lo dice y no muestra cifras |

**Reportes:** los módulos de reportes que replican el dashboard se entregan a medida que existen sus datos: Metas en la Fase 1; Inicio, Clientes, Productos, Vendedores, Cobranzas y Devoluciones en la Fase 2; Inventario completo y kardex en la Fase 3. El detalle está en [spec_reportes.md §13](spec_reportes.md#13-entrega-por-fases-y-criterios-de-aceptación). La Fase 3 agrega también **M7 Análisis Avanzado** (histograma de pedidos, patrones de morosidad y de quiebres de stock, [spec_reportes.md §14](spec_reportes.md#14-m7--análisis-avanzado)): a diferencia de la Fase 8 de esta tabla, detecta patrones con los datos ya registrados, sin pronóstico ni modelo estadístico, así que no espera los 12 meses de historia.

**Pruebas obligatorias en todas las fases:**
- Una prueba automatizada por cada regla contable, con el asiento esperado.
- Pruebas de cuadre de auxiliares contra mayor.
- Pruebas de concurrencia de numeración: dos facturas simultáneas no pueden obtener el mismo número.
- Pruebas de permisos por rol.
- Nunca hay datos simulados en las pantallas de producción (lección L9).

---

## 14. Arranque operativo (sin migración)

### 14.1 Principio
**Ningún dato se importa de los sistemas actuales.** Todo lo que existe en la base de datos del ERP es una **operación registrada por una persona**, con su usuario, fecha y documento de soporte. Esto incluye los saldos con los que la empresa empieza: se registran como operaciones del día de arranque, no como una carga masiva desde el DBF.

### 14.2 Día 0: configuración (antes de la primera venta)
1. Empresa (RIF y condición fiscal), sucursales y almacenes.
2. Usuarios y roles, y almacenes visibles por usuario.
3. Plan de cuentas y reglas contables, revisados con el contador.
4. Parámetros fiscales vigentes (IVA, retenciones, IGTF, UT), numeradores y proveedor de imprenta digital o máquina fiscal.
5. **Numeración de facturas:** definir con el asesor tributario si continúa la secuencia del sistema actual o si arranca una serie nueva (ver §16).
6. Cuentas bancarias, condiciones de pago, instrumentos de pago y la tasa BCV del día.
7. Periodo contable del mes de arranque abierto; ningún periodo anterior existe en el ERP.

### 14.3 Saldos iniciales como operaciones del día de arranque
La empresa no empieza en cero: tiene mercancía, dinero en bancos, clientes que le deben y proveedores a los que les debe. Cada saldo se registra con un **documento de apertura** del ERP, contra una cuenta puente "Saldos de apertura":

| Qué | Documento del ERP | Quién lo registra | Asiento |
|---|---|---|---|
| **Existencias** | *Conteo físico inicial* por almacén (toma física el día anterior al arranque). Los productos se crean a medida que se cuentan | Almacén, con aprobación de Gerencia | Inventario / Saldos de apertura |
| **Costo de esas existencias** | Costo unitario por producto, fijado por Gerencia y Contabilidad (último costo de reposición o costo conocido) | Contabilidad | Incluido en el conteo inicial |
| **Bancos y caja** | *Saldo inicial de cuenta* por cada cuenta, según el estado de cuenta del día anterior | Tesorería | Banco o caja / Saldos de apertura |
| **Cuentas por cobrar** | *Documento pendiente de cliente*: uno por cada factura que el cliente aún debe, con su número original, fecha, vencimiento, moneda y saldo | Cobranzas, contra el estado de cuenta de cada cliente | CxC / Saldos de apertura |
| **Cuentas por pagar** | *Documento pendiente de proveedor*: uno por cada factura que la empresa aún debe | Compras o Tesorería | Saldos de apertura / CxP |
| **Anticipos, retenciones e impuestos pendientes, activos fijos, préstamos, patrimonio** | *Asiento de apertura* del contador, con base en el balance de cierre de la contabilidad actual | Contabilidad, con aprobación | Saldos de apertura / cuentas correspondientes |

- Registrar las cuentas por cobrar **factura por factura**, y no como un saldo global por cliente, conserva la antigüedad y los días de mora desde el primer día.
- **Control de cierre de la apertura:** después de registrar todo, la cuenta "Saldos de apertura" debe quedar en cero contra el patrimonio inicial aprobado por el contador, y el balance de comprobación debe cuadrar.
- Los documentos de apertura se identifican con `tipo = 'apertura'` y quedan fuera de los indicadores de venta, compra y comisiones.

### 14.4 Catálogo de productos
El catálogo actual tiene cerca de 3.000 artículos. Hay dos formas de crearlo en el ERP, ambas con datos que ingresa el personal (§16):
- **Durante el conteo inicial (recomendado):** solo se crean los productos que existen físicamente. Los demás se crean cuando llegan en una compra.
- **Con la plantilla de carga masiva del ERP:** el personal prepara una hoja de cálculo con el formato del ERP y el sistema la valida fila por fila (código único, grupo, marca, alícuota, precios), rechazando la carga completa si hay errores.

### 14.5 Desde el día 1
- Toda venta, compra, cobro, pago, gasto y movimiento de inventario se registra **solo en el ERP**.
- El sistema actual y el dashboard quedan como **consulta del histórico previo** al arranque. No se sincronizan con el ERP.
- Si Gerencia decide un periodo de **doble registro** (operar en ambos sistemas por unas semanas), hay que fijar de antemano su duración y quién compara los resultados cada día (§16).

### 14.6 Checklist de arranque
- [ ] Configuración del día 0 completa y revisada por el contador.
- [ ] Conteo físico inicial registrado y aprobado en todos los almacenes.
- [ ] Saldos iniciales de todas las cuentas bancarias y cajas registrados y cuadrados con los estados de cuenta.
- [ ] Cuentas por cobrar y por pagar abiertas registradas factura por factura, y cuadradas con los totales conocidos.
- [ ] Asiento de apertura del contador registrado; "Saldos de apertura" en cero; balance de comprobación cuadrado.
- [ ] Primera factura fiscal emitida con número de control válido.
- [ ] Usuarios capacitados por rol y contraseñas iniciales cambiadas.
- [ ] Respaldo automático de la base de datos probado (respaldo y restauración).

---

## 15. Requisitos no funcionales

| Área | Requisito |
|---|---|
| Rendimiento | Emitir una factura de 50 líneas en menos de 2 s. Reportes de periodo en menos de 5 s mediante vistas materializadas refrescadas tras cada cierre o cada noche |
| Disponibilidad | Respaldo diario con restauración probada cada mes. Conservación de documentos fiscales por 10 años |
| Seguridad | HTTPS, sesiones con expiración, contraseñas con hash y cambio obligatorio de la contraseña inicial, seguridad por fila y ningún dato personal en URLs ni registros |
| Auditoría | Registro de auditoría inmutable para escrituras de negocio, inicios de sesión y exportaciones de datos |
| Integridad | Reglas críticas en la base de datos (triggers y restricciones), no solo en la aplicación |
| Configuración | Tasas, alícuotas, porcentajes, tolerancias y metas en tablas: **nada fijo en el código** |
| Usabilidad | Español de Venezuela, formato `dd-mm-aaaa`, separadores configurables y moneda siempre visible junto al monto |
| Observabilidad | Registro de errores propio del ERP y alertas de integridad: cuadre diario, auxiliar contra mayor y tasa BCV no cargada |
| Calidad de código | TypeScript estricto, pruebas del motor contable y del cálculo fiscal, revisión de código y sin datos simulados en producción |

---

## 16. Decisiones abiertas

Estas decisiones cambian el diseño y deben tomarlas Gerencia y el contador **antes de la Fase 2**:

1. ✅ **Política contable de moneda (decidida 05-10-2026):** los libros se llevan en VES y en USD (§3.4). Sigue abierto si se revalúan las partidas en divisas al cierre de cada mes.
2. **Tasa de referencia:** confirmar la BCV oficial para todo registro legal. Hoy `pagos_detalle` y `bancos_mov` traen tasas distintas para el mismo día (~330 contra 702 el 07-01-2026). Hay que decidir cómo se registra la tasa real de las compras y ventas de divisas.
3. ✅ **Condición fiscal de la empresa (decidida 25-09-2026):** es un conjunto de campos configurables en `empresa` y el sistema se comporta según ellos (§11.0). Falta que el asesor tributario confirme los valores con que se configura.
4. ✅ **Facturación (decidida 25-09-2026):** imprenta digital (§11.1). Queda abierta la decisión 13 (proveedor); la 14 está decidida.
5. ✅ **Costo promedio (decidida 25-09-2026):** ponderado móvil, uno por producto para toda la empresa (§8.2).
6. **Comisiones:** base cobrada (recomendada) o facturada, tramos por meta, porcentaje por grupo o marca, penalización por días de cobro y política de reversión.
7. **Reexpresión por inflación (BA VEN-NIF 2):** ¿aplica en el ejercicio?
8. **Fecha de arranque:** se recomienda el primer día de un mes, para que el primer cierre contable y las primeras declaraciones queden completas en el ERP.
9. **Numeración de facturas al arrancar:** ¿continúa la secuencia del sistema actual o empieza una serie nueva? Depende de la imprenta digital o la máquina fiscal y debe validarla el asesor tributario.
10. **Creación del catálogo de productos:** durante el conteo inicial (recomendado) o con la plantilla de carga masiva del ERP llenada por el personal (§14.4).
11. **Convivencia con el sistema actual:** arranque directo, registrando todo solo en el ERP desde el día 1 (recomendado), o un periodo corto de doble registro con fecha de fin fija.
12. ✅ **Producción o ensamblaje (decidida 25-09-2026):** módulo PP con órdenes simples, sin listas de materiales (§8.4).
13. **Proveedor de imprenta digital:** ¿cuál proveedor autorizado por el SENIAT? Define la integración y la numeración de control. **Pendiente (05-10-2026):** aún no hay proveedor; se construye `ServicioNumeroControl` con un simulador para pruebas y la emisión fiscal real espera la contratación.
14. ✅ **Dualidad de documentos (decidida 05-10-2026):** se mantienen facturas fiscales en Bs y notas de entrega en USD.
15. **Activos fijos:** categorías, vida útil y método de depreciación fiscal y contable, definidos por el contador (§12.6).

---

## 17. Fuentes

**Normativa venezolana**
- [Providencia SNAT/2024/000102: facturación por medios digitales (texto)](https://tugacetaoficial.com/leyes/texto-providencia-seniat-utilizacion-de-medios-digitales-para-emision-de-facturas-y-otros-documentos-17-12-2025/)
- [Aspectos relevantes de las providencias sobre facturación digital (LEĜA Abogados)](https://lega.law/perspectivas-lega/aspectos-relevantes-pa-facturacion-digital/)
- [Nuevas providencias SENIAT sobre facturación (Gálac)](https://galac.com/galac-blog/providencias-seniat-facturacion/)
- [Facturación en Venezuela: requisitos SENIAT 2026 (CodigoNext)](https://www.codigonext.com/recursos/facturacion-venezuela-requisitos-seniat-2026/)
- [Providencia SNAT/2025/000054: designación de agentes de retención del IVA (IVECOFI)](https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2025-54)
- [Nota informativa 2025-11: providencias de retención de IVA (Grant Thornton)](https://www.grantthornton.com.ve/globalassets/1.-member-firms/venezuela/2025/nota-informativa-providencias-administrativas-de-retencion-de-iva.pdf)
- [Reforma del IGTF (Gálac)](https://galac.com/galac-blog/reforma-del-igtf-impuesto-a-las-transacciones-en-divisas-y-criptomonedas/)
- [IGTF y pagos en dólares: 10 preguntas (Prodavinci)](https://prodavinci.com/igtf-y-pagos-en-dolares-10-preguntas-y-respuestas/)
- [Tabla de retenciones ISLR 2026, UT Bs. 43,00](https://soytecnologia.com/desuinteres/)
- [Guía de retenciones ISLR según el Decreto 1.808](https://www.estudiosavanzadospm.com/2025/08/guia-teoricopractica-de-retenciones.html)
- [Normas contables para ingresos en divisas y bolívares (Gálac)](https://galac.com/galac-blog/normas-contables-ingresos-divisas-bolivares/)
- [BA VEN-NIF N.º 2 (IVECOFI)](https://contadores.ivecofi.net/informacion/normativa/fccpv/ven-nif/ba-ven-nif-2)
- [Tipo de cambio de referencia (BCV)](https://www.bcv.org.ve/estadisticas/tipo-cambio-de-referencia-smc)
- [Guía de contabilidad venezolana en un ERP: doble moneda, BCV y SENIAT](https://ioniadev.com/guia-contabilidad-venezolana-odoo)

**Diseño de ERP y mejores prácticas**
- [ERP General Ledger: diseño de un núcleo de partida doble en PostgreSQL](https://www.matthewswong.com/en/blog/erp-general-ledger-double-entry-design/)
- [Ledger System Design: exactitud, auditabilidad y escala (Fintechly)](https://fintechly.com/infrastructure/infrastructure-ledger-system-design/)
- [General Ledger Posting: guía paso a paso (Numeric)](https://www.numeric.io/blog/general-ledger-posting)
- [Conciliación a tres vías en cuentas por pagar (GEP)](https://www.gep.com/info-guide/three-way-matching-accounts-payable-guide)
- [Asiento de orden de compra, conciliación a tres vías y buenas prácticas (Cleverence)](https://www.cleverence.com/articles/for-business/purchase-order-journal-entry-5382/)
- [Método de costo promedio ponderado (Finale Inventory)](https://www.finaleinventory.com/guides/weighted-average-inventory-method/)
- [Asientos contables de inventario (Finale Inventory)](https://www.finaleinventory.com/guides/inventory-journal-entries/)
- [Guía completa de reversión de comisiones (Sales Cookie)](https://blog.salescookie.com/2026/05/05/complete-guide-sales-commission-clawbacks/)
- [Reversión de comisiones: buenas prácticas 2026 (Everstage)](https://www.everstage.com/sales-commission/sales-commission-clawback)

**Referencias internas (solo conocimiento del negocio; el ERP no se conecta a ellas)**
- Análisis de la operación registrada en el sistema DBF actual y en su exportación: procesos del negocio (§1.2).
- `spec_sistema_acompanamiento_ventas.md` (dashboard actual): definiciones de indicadores comerciales usadas como referencia (§3.7).
- Auditoría del dashboard (septiembre de 2026): origen de las lecciones L1–L12 (§2).
