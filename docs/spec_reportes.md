# Especificación de Reportes e Indicadores: réplica del dashboard de ventas

> **Propósito.** El ERP debe mostrar la información **igual que el dashboard de ventas desarrollado anteriormente**: los mismos módulos, pestañas, indicadores, gráficos, tablas, filtros y exportaciones. La diferencia es de dónde salen los datos. Aquí se calculan con la base de datos propia del ERP (§3 de la [especificación principal](spec_erp_hanei_motors.md)), nunca con los `.txt`, la base del dashboard ni el sistema DBF.
>
> **Fórmulas corregidas.** Las definiciones de este documento incorporan las correcciones de la auditoría del dashboard (septiembre de 2026). Donde el dashboard tenía un error o una estimación inventada, se indica la versión correcta y el cambio queda registrado en la §11.

---

## Índice

1. [Reglas generales](#1-reglas-generales)
2. [Definiciones base (glosario único)](#2-definiciones-base-glosario-único)
3. [Inicio](#3-inicio)
4. [M1 · Clientes](#4-m1--clientes)
5. [M2 · Productos](#5-m2--productos)
6. [M3 · Vendedores](#6-m3--vendedores)
7. [M4 · Cobranzas](#7-m4--cobranzas)
8. [M5 · Devoluciones](#8-m5--devoluciones)
9. [M6 · Inventario](#9-m6--inventario)
10. [Configuración de metas](#10-configuración-de-metas)
11. [Diferencias intencionales respecto al dashboard](#11-diferencias-intencionales-respecto-al-dashboard)
12. [Vistas SQL que alimentan los reportes](#12-vistas-sql-que-alimentan-los-reportes)
13. [Entrega por fases y criterios de aceptación](#13-entrega-por-fases-y-criterios-de-aceptación)
14. [M7 · Análisis Avanzado](#14-m7--análisis-avanzado)

---

## 1. Reglas generales

### 1.1 Navegación
El menú lateral replica el del dashboard, con los mismos nombres y en el mismo orden. Las opciones de operación del ERP (facturar, comprar, contabilidad…) van en un grupo aparte del menú, llamado "Operación".

| Orden | Opción de menú | Ruta sugerida | Sección |
|---|---|---|---|
| 1 | Inicio | `/` | §3 |
| 2 | Clientes (M1) | `/reportes/clientes` | §4 |
| 3 | Productos (M2) | `/reportes/productos` | §5 |
| 4 | Vendedores (M3) | `/reportes/vendedores` | §6 |
| 5 | Cobranzas (M4) | `/reportes/cobranzas` | §7 |
| 6 | Devoluciones (M5) | `/reportes/devoluciones` | §8 |
| 7 | Inventario (M6) | `/reportes/inventario` | §9 |
| 8 | Configuración de Metas | `/metas` | §10 |
| 9 | Análisis Avanzado (M7) | `/reportes/analisis-avanzado` | §14 |

### 1.2 Diseño visual
- Se replica el aspecto del dashboard: barra lateral colapsable, tema oscuro con paneles translúcidos, tarjetas de indicador (título en mayúsculas pequeñas, ícono y valor destacado), tablas ordenables y gráficos de barras, líneas y torta.
- Componentes de referencia del dashboard: `KpiCard`, `StatementTable`, tablas y barra lateral estilo shadcn/ui, íconos lucide y gráficos Recharts.
- Los componentes **visuales** del dashboard se pueden copiar y adaptar al repositorio del ERP. Su **lógica de datos no se copia**: leía archivos `.txt` y tenía errores documentados. Los datos salen siempre de las vistas de la §12.

### 1.3 Filtros comunes
| Filtro | Comportamiento |
|---|---|
| **Año** | Un año, varios años (selección múltiple, se suman) o "Todos". El valor por defecto es el año en curso |
| **Sucursal** | Todas, Barquisimeto o Caracas. Reemplaza la separación BQTO/CCS que el dashboard deducía del código de vendedor |
| **Incluir inactivos** | Por defecto se excluyen los clientes con `estado = 'inactivo'` y los vendedores de tipo `administrativo` o `casa`. Un interruptor los incluye |
| **Búsqueda** | Por código o nombre (clientes, productos, vendedores) |
| **Exportar CSV** | Disponible en todas las tablas y series, con los mismos campos que se ven en pantalla |

El estado de los filtros vive en la URL (`?year=2026&tab=historico`), como en el dashboard, para poder compartir un enlace a una vista exacta.

### 1.4 Moneda, formato y estados vacíos
- Todos los montos de los reportes se muestran en **USD** (moneda de gestión), tomados del importe en USD que cada documento guarda al emitirse. Un selector opcional muestra VES.
- Formato: `$1,234.56` en montos, `dd-mm-aaaa` en fechas y porcentajes con un decimal.
- **Sin datos inventados.** Sin meta cargada se muestra "Sin meta cargada". Sin datos en el periodo se muestra "Sin datos en el período". Ante un error se muestra un estado de error. Nunca un valor de relleno.
- Las divisiones con denominador cero muestran `0 %` o "N/A". Nunca `NaN` ni `Infinity`.

---

## 2. Definiciones base (glosario único)

Todas las pantallas usan **estas mismas definiciones**. En el dashboard cada módulo tenía su propia copia de las reglas y daba cifras distintas para lo mismo; en el ERP se implementan una sola vez, en las vistas de la §12.

| Concepto | Definición en el ERP |
|---|---|
| **Venta** | Líneas de `documento_venta` con `tipo = 'factura'` y `estado = 'emitido'`. Se excluyen las anuladas y los documentos de `apertura`. **Monto = base sin IVA ni IGTF, en USD** |
| **Venta bruta** | Cantidad × precio de lista, antes de descuentos de línea |
| **Ítems vendidos** | Suma de cantidades de las líneas de venta |
| **Pedido de compra** | Combinación distinta de (cliente, fecha de emisión) entre las facturas. En la vista de un solo cliente se cuentan las fechas distintas |
| **Pedido promedio (ticket)** | Venta ÷ pedidos. También se calcula por sucursal |
| **Devolución** | `documento_venta` con `tipo = 'nota_credito'`, `motivo_nc = 'devolucion'` y `estado = 'emitido'`. Monto = base en USD; ítems = suma de cantidades |
| **Pedido con devolución** | Factura de origen distinta referenciada por las NC de devolución |
| **Descuento de factura** | Descuentos de línea más NC con motivo `descuento_comercial` o `ajuste_precio` |
| **Descuento por pronto pago** | NC con motivo `pronto_pago` |
| **Cobro** | Monto de `aplicacion_cobro` sobre facturas (sin anticipos sin aplicar), en USD, en la fecha del cobro |
| **Días de pago de un cobro** | Fecha del cobro − fecha de emisión de la factura a la que se aplicó. Se toma del enlace real entre cobro y factura, no de una estimación |
| **Días de pago promedio** | Promedio ponderado por monto: Σ(monto aplicado × días) ÷ Σ monto aplicado, con los cobros del periodo |
| **Deuda actual** | Suma de `saldo` de las partidas de CxC abiertas, en USD |
| **Mora de una partida** | Hoy − fecha de vencimiento (positivo = vencida) |
| **Cliente activo** | `cliente.estado = 'activo'` |
| **Vendedor comercial** | `vendedor.tipo in ('interno','externo')` |
| **Stock comercial** | Existencia en almacenes con `es_comercial = true` |
| **Costo** | Costo promedio ponderado en USD (§8.2 de la especificación principal) |
| **Tendencia anual** | Venta × 365 ÷ días transcurridos del año, si el año es el actual. Para años cerrados es igual a la venta |
| **Meta** | Tabla `meta_venta`, sumando los meses del periodo. Sin fila, "Sin meta cargada" |
| **Variación entre periodos** | Absoluta = B − A. Porcentual = (B − A) ÷ A × 100; si A = 0, es 100 % cuando B > 0 y 0 % en otro caso |

---

## 3. Inicio

**Tarjetas de indicador** (en el dashboard original eran valores fijos escritos en el código; en el ERP son reales):

| Tarjeta | Cálculo | Subtítulo |
|---|---|---|
| Ventas del mes | Venta del mes en curso | Variación contra el mismo número de días del mes anterior |
| Clientes activos | Clientes con al menos una factura en los últimos 90 días | "Con compras en los últimos 90 días" |
| Productos en quiebre | Productos en estado `RIESGO_QUIEBRE` (§9) | "Riesgo de quiebre (stock comercial)" |
| Cobranza pendiente | Deuda actual total de clientes activos | Monto vencido entre paréntesis |

**Accesos rápidos:** Sugerido de Compras (→ M6), Análisis de Cartera (→ M4), Auditoría de Calidad (→ M5).

**Gráfico "Rendimiento Global de Ventas":** venta de los últimos 6 meses en barras, con la línea de la meta global mensual si existe. En el dashboard este gráfico nunca se terminó ("Gráfico en construcción").

---

## 4. M1 · Clientes

Hay dos vistas con las mismas pestañas:
- **Vista global** (`/reportes/clientes`): todos los clientes.
- **Vista de cliente** (`/reportes/clientes/[codigo]`): un solo cliente, con un encabezado que muestra nombre, código, RIF, vendedor, última compra y dirección.

En las dos hay buscador de clientes con autocompletado (por código o nombre, 10 resultados), selector de año múltiple y el interruptor "Incluir inactivos".

### 4.1 Pestaña "Análisis por Año"

**Panel "Insight sugerido"**: una alerta basada en reglas (no en IA) que muestra la primera que se cumpla:
1. 🔴 Partidas vencidas: "El cliente tiene N factura(s) en mora. Se recomienda suspender créditos y contactar para cobranza."
2. 🟡 Deuda sin vencer: "Deuda activa de $X. Monitorear fechas de vencimiento."
3. 🔴 Índice de devolución ($) mayor a 5 %: "Investigar calidad del último lote."
4. 🟢 Cumplimiento de la tendencia mayor a 100 %: "Considerar programa de lealtad."

Los umbrales son parámetros configurables.

**Indicadores**, en grupos de tarjetas:

| Grupo | Indicador | Cálculo |
|---|---|---|
| Finanzas y Metas | Venta Total ($) | Venta del periodo |
| | Tendencia de Venta | Tendencia anual (§2) |
| | Meta de Venta ($) | Meta del cliente (tipo `cliente`) o global en la vista general. "Sin meta cargada" si no hay |
| | % Cumplimiento Tendencia | Tendencia ÷ meta × 100. "N/A" sin meta |
| Volumen y Operaciones | Pedidos de Compra | Pedidos (§2) |
| | Pedido Promedio ($) | Total y desglose por sucursal (Barquisimeto y Caracas) |
| | Venta por Cantidad Ítems | Ítems vendidos |
| | Última Compra | Fecha de la última factura del cliente |
| Devoluciones | Devoluciones ($), Ítems y Pedidos | Con su índice: devolución ÷ venta en monto, ítems y pedidos |
| Cobranzas y CxC | Días de Pago Promedio | Ponderado por monto (§2), con los cobros del periodo |
| | Deuda Actual (CxC) | Total y la parte emitida en el año filtrado |
| | Vencimiento CxC | Vencimiento más antiguo entre las partidas abiertas |
| Descuentos | Descuento de factura, de pronto pago y total | Monto otorgado y porcentaje ponderado (ver abajo) |

**Descuentos ponderados:**
- **% descuento de factura** = descuento de factura ÷ venta bruta del periodo.
- **% pronto pago** = NC de pronto pago del periodo ÷ venta de las facturas **canceladas** del periodo. Si una factura no está pagada, todavía no se sabe si tomará el descuento.
- **% total** = suma de los dos montos ÷ venta bruta.
- La regla es la misma en la vista global y en la de cliente. En el dashboard cada vista usaba un denominador distinto.

**Gráficos:**
- *Evolución Mensual (Ventas vs Devoluciones)*: barras de los 12 meses del año.
- *Porcentaje de Pagos (Moneda/Vía)*: torta de los cobros del periodo por **instrumento de pago** (transferencia Bs, efectivo USD, Zelle, USDT…). El ERP registra el instrumento real de cada cobro; el dashboard lo deducía del número de documento.

**Top ítems** (debajo): dos tablas con los 100 productos más vendidos al cliente, o globales, en el periodo: una **por cantidad** y otra **por monto**. Columnas: descripción del producto, última venta, stock disponible, cantidad vendida y monto total.

### 4.2 Pestaña "Análisis Total (Histórico)"
Se calcula con las **mismas funciones** de la pestaña por año, aplicadas a todo el histórico y a cada año. Así las dos pestañas nunca se contradicen. El dashboard llegó a mostrar aquí valores simulados.

- **Tres paneles de acumulados:**
  1. *Operaciones Totales*: venta, ítems, pedidos, ticket promedio y última compra.
  2. *Devoluciones y Calidad*: monto, ítems, pedidos y los tres índices.
  3. *Comportamiento de Pago*: deuda actual, descuento ponderado, días de pago y vencimiento de CxC.
- **Gráfico "Evolución Anual"**: barras por año de la métrica elegida en un selector (venta, ítems, pedidos, devoluciones, días de pago o descuento). El año en curso agrega una barra de **tendencia anualizada** en otro color.
- **Torta "Porcentaje de Pagos Histórico"** por instrumento de pago.
- **Tabla "Matriz de Indicadores por Año"**: año, ventas, ítems, pedidos, ticket promedio, devoluciones ($), índice de devolución, días de pago y descuento (%).
- **Tabla "Estado de Cuenta (Global)"**: partidas abiertas con número, emisión, monto original, abonado, saldo, vencimiento y estado de mora ("N días de vencido", "N días por vencer" o "Al día").

### 4.3 Pestaña "Comparación de Periodos"
- **Entradas:** periodo A y periodo B, cada uno con fecha desde y hasta. Por defecto, el año anterior contra el actual.
- **Tarjetas comparativas** con A, B, variación absoluta y variación porcentual: venta total, cantidad de ítems, pedidos, ticket promedio, devoluciones ($), devoluciones (ítems), devoluciones (pedidos), índices de devolución, descuento ponderado y días de pago promedio.
- **Dos tortas** de porcentaje de pagos por instrumento, una por periodo.
- **Panel global:** última compra, deuda actual y vencimiento de CxC.
- La vista global compara el total de la empresa.

### 4.4 Pestaña "Estado de Cuenta (Detalle)" (solo vista de cliente)
- **Tarjetas:** Total Cargos (Debe), Total Abonos (Haber) y Saldo Final del Período.
- **Tabla cronológica** de todos los movimientos de CxC del cliente en el periodo: facturas, ND, NC, cobros y retenciones recibidas. Columnas: fecha, documento, tipo o concepto, cargo, abono y **saldo progresivo**.
- **Orden estrictamente por fecha y hora.** El dashboard ordenaba fechas escritas como texto y descuadraba el saldo progresivo.

---

## 5. M2 · Productos

### 5.1 Catálogo (`/reportes/productos`)
**Pestaña "Catálogo de Artículos"**, con filtros de año, búsqueda y cantidad de filas. Tabla ordenable con estas columnas:

| Columna | Cálculo |
|---|---|
| Código · Descripción | Maestro del producto |
| Grupo / Marca | Maestro del producto |
| Precio A / D | Listas de precio vigentes. El **costo promedio** se muestra aparte y **no** como "precio D" |
| Stock | Existencia comercial actual |
| U. Vend. · Monto ($) | Unidades y venta del periodo |
| Dev. ($) | Devoluciones del periodo |
| Acción | Abre el detalle del producto |

**Pestaña "Análisis por Grupos / Familias"**. En el ERP, la "familia" es la **categoría** del producto (árbol Frenos › Pastillas); además se puede agrupar por **código común** (el mismo artículo en todas sus marcas). Por grupo muestra: total de artículos, unidades vendidas, venta, devoluciones, **stock valorizado al costo promedio** y producto líder (el de mayor venta del grupo).

Ambas pestañas se pueden exportar a CSV.

### 5.2 Detalle de producto (`/reportes/productos/[codigo]`)

**Pestaña "Vista General / Anual"**
- **Tarjetas:**

| Tarjeta | Cálculo |
|---|---|
| Venta Total ($) | Venta del producto en el periodo |
| Unidades Vendidas | Cantidad vendida |
| Pedidos / Facturas | Facturas distintas con el producto |
| Stock Actual Disponible | Stock comercial menos lo reservado |
| Días de Inventario | Stock ÷ velocidad diaria |
| Tasa Devolución ($) | Devoluciones ÷ venta, en monto |
| Días sin Inventario | Días del periodo con stock comercial en 0 o menos, **calculados con el kardex** |

- **Gráfico:** tendencia de ventas mensuales ($), con devoluciones.
- **Panel "Análisis de Rotación e Inventario":** velocidad diaria, días y meses de inventario, pendiente en tránsito y pendiente en producción, con las definiciones de la §9.
- **Tabla "Top Clientes Compradores"**: código, nombre, cantidad comprada, monto, número de compras, última compra y enlace al cliente.
- **Ratios de devolución:** en cantidad, en monto y en pedidos.

**Pestaña "Comparativa Multianual"**: año A contra año B, con barras mensuales lado a lado y variación de monto, cantidad, pedidos y devoluciones.

**Pestaña "Stock por Almacén"**: tabla de almacenes con existencia e indicador de si el almacén es vendible (comercial).

**Pestaña "Movimientos"**
- **Kardex:** fecha, documento, tipo, almacén, cantidad (con signo), stock por almacén y stock total progresivo. Se puede exportar.
- **Gráfico mensual por tipo de movimiento:** apertura, recepción, ajuste, venta o despacho, transferencia y NC, por almacén.

---

## 6. M3 · Vendedores

### 6.1 Catálogo (`/reportes/vendedores`)
**Filtros:** año, búsqueda, orden (venta, facturas o clientes) e "Incluir administrativos / casa".

**Tabla ordenable:**

| Columna | Cálculo |
|---|---|
| Código · Nombre · Contacto | Maestro del vendedor |
| Clientes Atendidos | Clientes distintos con factura del vendedor en el periodo |
| Facturas | Facturas del vendedor en el periodo |
| Cobertura de Cartera (%) | Atendidos ÷ asignados (clientes activos con ese vendedor en el maestro) |
| Concentración Top 3 (%) | Venta de sus 3 mayores clientes ÷ su venta total |
| Venta Total ($) | Venta del periodo |
| % Devoluciones | Devoluciones ÷ venta |
| Cumplimiento Meta | Venta ÷ meta del vendedor. "Sin meta" si no hay |
| Acción | Abre el detalle del vendedor |

### 6.2 Detalle de vendedor (`/reportes/vendedores/[codigo]`)

**Pestaña "Vista General / Anual"**
- **Tarjetas:** Venta Total, Facturas Emitidas, Clientes Atendidos, Pedido Promedio, % Cumplimiento Meta y Tasa de Devoluciones ($).
- **Panel de alerta por reglas**, igual que en M1.
- **Gráfico "Rendimiento Comercial Mensual vs Meta ($)"**: barras de venta mensual y línea de la meta mensual (`meta_venta` del mes; si solo hay meta anual, se reparte entre 12).

**Pestaña "Analítica Estratégica & Cartera Dormida"**
- **Indicadores:**
  - cobertura de cartera;
  - concentración top 3;
  - **venta cruzada**: promedio de grupos de producto distintos por factura;
  - **tasa de fuga**: clientes dormidos ÷ asignados.
- **Tabla "Clientes Dormidos / En Riesgo de Fuga"**: clientes asignados sin compras en el periodo, con código, nombre, venta histórica, última compra y días sin comprar. Se marcan "en riesgo" los que superan el parámetro de días (45 por defecto). Orden: venta histórica descendente.

**Pestaña "Comparativa Multianual"**: año A contra año B, con venta, facturas, clientes atendidos, devoluciones y sus variaciones.

**Pestaña "Cartera Activa"**: clientes atendidos en el periodo, con facturas y monto vendido.

**Pestaña "Productos Vendidos"**: los 30 productos principales del vendedor, con unidades y monto.

---

## 7. M4 · Cobranzas

**Tarjetas principales:**

| Tarjeta | Cálculo |
|---|---|
| Total Cobranza Efectiva | Suma de cobros aplicados en el periodo, con el número de pagos |
| Promedio Días de Pago (DSO) | Ponderado por monto (§2), con la mediana debajo |
| Cobranza a Tiempo (≤30 días) | % de cobros con 30 días o menos |
| Efectividad de Cobro (%) | Del total facturado en el periodo, porcentaje ya cancelado: (facturado − saldo pendiente de esas facturas) ÷ facturado |

**Pestaña "Resumen & Velocidad de Cobro"**
- **Distribución de velocidad de cobro:** barras y tarjetas por tramo (0-15 días "Pronto Pago", 16-30 "Puntual", 31-60 "Mora Leve", más de 60 "Mora Crítica"), con monto, cantidad de pagos y porcentaje del cobro.
- **Antigüedad de saldos (aging):** deuda abierta en los tramos corriente (0-30 días), 31-60, 61-90 y más de 90. Muestra monto, número de facturas y porcentaje.
  - Los días se cuentan **hasta hoy**. En el ERP los datos están al día; el dashboard usaba la fecha de corte de la exportación.
  - Un selector permite contar desde la emisión (como el dashboard) o desde el **vencimiento** (mora real).
- **Tendencia mensual:** líneas de días promedio de pago y monto cobrado por mes.

**Pestaña "Promedio por Vendedor"**: vendedor, monto cobrado, número de cobros, días promedio, mediana, % a tiempo, % mora (más de 30 días) y deuda de su cartera. El vendedor se toma de la factura cobrada. Exportable.

**Pestaña "Promedio por Cliente"**
- **Filtros:** búsqueda y categoría: Puntual (≤30 días), Mora leve (31-60), Mora crítica (más de 60) y Con deuda pendiente.
- **Columnas:** cliente, asesor, monto cobrado, cobros, días promedio, mediana, % a tiempo, deuda pendiente y comportamiento.
- Exportable.

**Pestaña "Bancos & Canales"**: por cuenta bancaria o canal de cobro, con monto, transacciones y participación. Sale de `cobro.cuenta_bancaria_id` e `instrumento_id`: el ERP registra en cada cobro el banco donde entró, así que no hace falta cruzar movimientos bancarios.

---

## 8. M5 · Devoluciones

**Tarjetas:**

| Tarjeta | Cálculo |
|---|---|
| Monto Total Devuelto | Devoluciones del periodo |
| Unidades Devueltas | Suma de cantidades devueltas |
| Tasa de Devolución Financiera | Devoluciones ÷ venta bruta (%). En rojo si supera el umbral (5 %) |
| Facturas Afectadas | Facturas de origen distintas con devolución, y su % sobre el total de facturas |
| Costo Operativo Estimado | Devoluciones × costo por devolución (**parámetro**). Si el parámetro no está cargado, la tarjeta no se muestra. En el dashboard eran $15 fijos |

**Pestaña "Resumen & Tendencia Mensual"**: barras de venta contra devoluciones por mes, con la línea del % devuelto.

**Pestaña "Análisis por Cliente"**: cliente, venta, monto devuelto, unidades devueltas, facturas afectadas, % de devolución y **nivel de riesgo**: CRÍTICO (más de 8 %), MODERADO (más de 3 %) o NORMAL. Los umbrales son parámetros.

**Pestaña "Análisis por Vendedor"**: vendedor, venta bruta, monto devuelto, venta neta, facturas afectadas y % de devolución. Excluye los vendedores administrativos y de casa.

**Pestaña "Análisis por Producto"**
- **Columnas:** producto, grupo, unidades vendidas, unidades devueltas, monto devuelto, % de devolución en volumen y la etiqueta **"ALERTA DEFECTO"**.
- **Alerta de defecto:** se marca cuando el % en volumen supera el 5 % y hay 5 o más unidades devueltas. Ambos umbrales son parámetros.
- **Monto devuelto:** sale del importe de la línea de la NC. En el dashboard daba 0 por un error de columna.

Todas las pestañas se pueden exportar a CSV.

---

## 9. M6 · Inventario

**Filtros:** búsqueda, año, estado de salud (Todos, Solo stock cero, Riesgo de quiebre, Demanda reprimida, Sobrestock, Saludables) y cantidad de filas (50 a 500, o todos).

**Tarjetas:**

| Tarjeta | Cálculo |
|---|---|
| Capital Inmovilizado | Σ existencia × **costo promedio**. El dashboard usaba el precio de venta A, lo que inflaba el capital |
| Venta Perdida Estimada | Σ venta perdida por producto (ver abajo) |
| Riesgo de Quiebre · Demanda Reprimida · Sobrestock · Saludables | Cantidad de productos en cada estado |

**Gráfico "Valorización mensual del inventario":** valor al costo al cierre de cada mes, apilado por almacén. Se calcula con el kardex y el costo promedio de cada mes.

### 9.1 Definiciones de rotación (con datos reales del kardex)

| Indicador | Definición |
|---|---|
| Días del periodo | Días del año filtrado; si es el año en curso, hasta hoy. Con "Todos", desde el primer movimiento del producto |
| **Días con stock (DIS)** | Días del periodo en que la existencia comercial al cierre del día fue mayor que 0. **Se calcula con el kardex.** El dashboard lo estimaba con factores fijos (51 % y 65 %) |
| % Disponibilidad | DIS ÷ días del periodo |
| Velocidad básica | Unidades vendidas ÷ días del periodo |
| Velocidad ajustada | Unidades vendidas ÷ DIS (lo que se vende cuando hay existencia) |
| Cobertura real | Stock comercial ÷ velocidad ajustada, en días y en meses |
| Venta perdida estimada | (Días del periodo − DIS) × velocidad ajustada × precio A |
| Pendiente en tránsito | Cantidad ordenada no recibida en órdenes de compra e importaciones abiertas |
| Pendiente en producción | Cantidad de órdenes de producción abiertas menos lo ya entregado |
| Sugerido de compra | max(0, ⌈velocidad ajustada × días de cobertura − (stock comercial + tránsito + producción)⌉). Días de cobertura: **parámetro**, 90 por defecto |

**Estado de salud** (umbrales configurables en `parametro_inventario`; en este orden de prioridad):
1. **RIESGO_QUIEBRE**: stock comercial ≤ 0 o cobertura menor a 15 días.
2. **DEMANDA_REPRIMIDA**: disponibilidad menor al 60 % y velocidad ajustada mayor a 0,1 unidades por día.
3. **SOBRESTOCK**: cobertura mayor a 6 meses con velocidad mayor a 0.
4. **SIN_ROTACION**: hay existencia y no se vendió nada en el periodo.
5. **SALUDABLE**: el resto.

*Entregado (migración 0027):* los indicadores de esta tabla, salvo el pendiente en tránsito y en producción y el sugerido de compra, salen de `fn_disponibilidad` y se muestran en `/reportes/inventario`. Las unidades vendidas son las salidas por venta menos las devoluciones de clientes del kardex. Detalle en la especificación principal, §8.3.

### 9.2 Pestañas
- **"Velocidad Ajustada & Salud de Stock"**: matriz con código y descripción, grupo, stock actual, DIS, velocidad básica, velocidad ajustada, cobertura real, venta perdida y estado de salud. Ordenable; por defecto, por venta perdida descendente.
- **"Sugerido de Órdenes de Compra"**:
  - Tabla con código y descripción, stock, en tránsito, en producción, velocidad ajustada, demanda del horizonte y sugerido en unidades.
  - Botón **"Crear orden de compra"** con las líneas seleccionadas. Esta es una ventaja del ERP: el dashboard solo podía sugerir.
- **"Salud por Grupo / Familia"**: grupo, total de ítems, capital inmovilizado, ítems en quiebre, ítems en sobrestock y venta perdida.

---

## 10. Configuración de metas

Replica la pantalla del dashboard y le agrega la captura manual y el historial:
- **Carga por Excel** con las columnas `TIPO | CODIGO | ANIO | META_VENTA` y, opcionalmente, `MES`.
  - `TIPO` puede ser CLIENTE, VENDEDOR, PRODUCTO, GRUPO o GLOBAL.
  - El código se reconoce por código del ERP o por RIF en el caso de clientes.
  - Se valida fila por fila. Si una fila tiene error, no se guarda nada y se informan las filas con problemas.
- **Captura y edición manual** en una tabla.
- **Versiones:** cada carga crea una versión nueva con usuario y fecha. Las metas quedan pendientes hasta que Gerencia las aprueba.
- **Meta global:** si no hay una fila GLOBAL, se usa la suma de las metas de los vendedores. La pantalla lo indica explícitamente.
- Tabla de referencia con la estructura requerida, igual que en el dashboard.

---

## 11. Diferencias intencionales respecto al dashboard

La presentación es la misma. Estos cálculos cambian porque en el dashboard eran errores o estimaciones:

| Punto | Dashboard | ERP |
|---|---|---|
| Datos | Archivos `.txt` exportados, con atraso | Base de datos propia, al día |
| Anulaciones | No se detectaban: las facturas anuladas contaban como venta | Estado explícito del documento |
| Monto de venta | Total de la factura (con impuestos, según el documento) | Base sin IVA ni IGTF, en USD |
| Sucursal BQTO/CCS | Deducida del código de vendedor | Campo `sucursal` del documento |
| Clientes inactivos | Vendedor "00" | `cliente.estado` |
| Vendedores administrativos | Listas de códigos distintas en cada módulo | `vendedor.tipo` |
| Metas | Valores fijos en el código ($15.000, $150.000) y luego un `.txt` | Tabla `meta_venta` con versiones y aprobación |
| Mix de pagos | Moneda deducida del número de documento | Instrumento real del cobro |
| Días de pago | Cobro contra la primera fila de cargo; a veces un valor fijo de 15 | Enlace real cobro → factura |
| Fuente de Cobranzas | Llegó a usar pagos a **proveedores** | Solo cobros de clientes |
| Bancos | Cruce aproximado con movimientos bancarios | Cuenta bancaria registrada en el cobro |
| Aging | Contra la fecha de corte de la exportación | Contra hoy, desde la emisión o el vencimiento |
| Histórico de clientes | Llegó a mostrar valores simulados | Mismas funciones que el análisis por año |
| Denominador del descuento | Distinto en la vista global y en la de cliente | Una sola regla (§4.1) |
| Monto de devolución por producto | 0 por un error de columna | Importe de la línea de la NC |
| Costo operativo de devoluciones | $15 fijo | Parámetro opcional |
| Días con stock | Factores fijos (51 % y 65 %) | Kardex diario real |
| Capital inmovilizado | Stock × precio de venta | Stock × costo promedio |
| Tránsito y producción | Columna equivocada (salía 0) y producción sin descontar lo despachado | Órdenes abiertas reales |
| Inicio | KPIs escritos en el código | Calculados |

---

## 12. Vistas SQL que alimentan los reportes

Los reportes solo leen de estas vistas. Así las definiciones de la §2 se implementan **una sola vez**.

| Vista | Grano | Columnas principales |
|---|---|---|
| `vw_venta_linea` | Línea de factura emitida | fecha, documento, cliente, vendedor, sucursal, almacén, producto, código común, categoría, grupo, marca, línea de calidad, cantidad, precio de lista, precio cobrado, descuento de línea, promoción, base_usd, costo_usd (foto al emitir) |
| `vw_venta_documento` | Factura emitida | fecha, cliente, vendedor, sucursal, base_usd, total_usd, saldo_usd, cancelada (sí/no), fecha de cancelación |
| `vw_nota_credito_linea` | Línea de NC emitida | fecha, motivo, factura de origen, cliente, vendedor, producto, cantidad, base_usd |
| `vw_cxc_movimiento` | Movimiento de CxC | fecha y hora, cliente, documento, tipo, cargo_usd, abono_usd (para el estado de cuenta con saldo progresivo) |
| `vw_cxc_partida_abierta` | Partida con saldo | cliente, documento, emisión, vencimiento, saldo_usd, días desde emisión, días de mora |
| `vw_cobro_aplicado` | Aplicación cobro → factura | fecha del cobro, cliente, vendedor de la factura, instrumento, cuenta bancaria, monto_usd, días de pago |
| `vw_kardex` | Movimiento de inventario | fecha, producto, almacén, tipo, documento, cantidad, saldo progresivo por almacén y total |
| `vw_existencia_diaria` | Producto × almacén × día | existencia al cierre del día. Es una vista **materializada**, se refresca cada noche y alimenta DIS, días sin inventario y valorización |
| `vw_pendiente_compra` | Producto | en tránsito y en producción pendientes |
| `vw_meta_periodo` | Tipo × entidad × año × mes | meta aprobada vigente |

**Rendimiento:** índices por (fecha, cliente), (fecha, vendedor) y (fecha, producto). Las vistas pesadas (`vw_existencia_diaria` y agregados mensuales) son materializadas y se refrescan cada noche y al cerrar el mes. Cada pantalla debe cargar en menos de 3 s.

---

## 13. Entrega por fases y criterios de aceptación

Los reportes se entregan a medida que existen los datos que los alimentan (§13 de la especificación principal):

| Fase del ERP | Reportes que se habilitan |
|---|---|
| Fase 1 (Maestros) | Configuración de Metas (§10) |
| Fase 2 (Ventas, CxC, inventario) | Inicio, M1 Clientes, M2 Productos (catálogo y detalle anual), M3 Vendedores, M4 Cobranzas, M5 Devoluciones |
| Fase 3 (Compras) | M2 Stock por almacén y Movimientos, M6 Inventario completo (tránsito, producción, sugerido con creación de OC) |
| Fase 3 (ampliación) | M7 Análisis Avanzado (§14): histograma de pedidos y patrones de morosidad en cuanto M4 tiene datos; patrones de velocidad y de quiebres en cuanto M6 está completo |

**Criterios de aceptación:**
1. **Paridad visual:** cada pantalla tiene los módulos, pestañas, tarjetas, gráficos, columnas, filtros y exportaciones descritos aquí, con la misma navegación que el dashboard.
2. **Paridad de cálculo:** existe un conjunto de datos de prueba con resultados calculados a mano. Cada indicador de este documento tiene una prueba automatizada que compara contra ese resultado.
3. **Consistencia entre pantallas:**
   - La venta de un cliente en M1 = la suma de sus líneas en M2 = su aporte en M3.
   - La deuda en M1 = la de M4 = el saldo de la cuenta de CxC en el mayor.
4. **Sin datos inventados:** ninguna pantalla muestra valores de relleno. Sin datos, o ante un error, se ven los estados vacíos o de error de la §1.4.
5. **Rendimiento:** cada pantalla carga en menos de 3 s con el volumen de un año de operación.

---

## 14. M7 · Análisis Avanzado

Módulo nuevo, sin equivalente en el dashboard anterior: no replica una pantalla existente, sino que cruza los mismos datos de M1-M6 para detectar patrones. Usa los mismos filtros comunes (§1.3: año, sucursal, incluir inactivos) más los que se indican en cada pestaña. Todos los umbrales y tamaños de tramo son parámetros en `parametro_reporte` (§1.4: nunca un valor fijo en el código) con un valor de referencia, **pendientes de confirmar con Gerencia** (igual que los demás parámetros de reportes e inventario, [decisiones.md](decisiones.md)).

### 14.1 Histograma de Pedidos (`/reportes/analisis-avanzado/pedidos`)
- **Filtros:** año, sucursal, vendedor, zona (`cliente.zona`), cliente (búsqueda).
- **Definición:** cada pedido es una factura (grano de `vw_venta_documento`; "venta" §2). El histograma agrupa las facturas del periodo en tramos de monto de igual ancho, desde $0 hasta un tope, con un tramo final abierto "más de $X".
  - `HISTOGRAMA_PEDIDOS_TRAMO_USD`: ancho de cada tramo. Valor de referencia **$50**.
  - `HISTOGRAMA_PEDIDOS_TOPE_USD`: monto a partir del cual los pedidos entran en el tramo abierto. Valor de referencia **$1.000**.
- **Gráfico:** barras, una por tramo, con la cantidad de pedidos.
- **Tabla** (exportable): tramo, cantidad de pedidos, % del total, monto total y pedido promedio del tramo.

### 14.2 Patrones de Morosidad (`/reportes/analisis-avanzado/morosidad`)
- **Filtros:** año, sucursal, vendedor, zona.
- **Definición:** cruza el tramo de monto del pedido (los mismos de §14.1) y los **días de crédito** (`condicion_pago.dias`) de la condición de pago **actual** del cliente contra el comportamiento real de cobro. *Nota: la factura no congela la condición de pago del cliente (§3, modelo de datos); si un cliente cambió de plazo, sus facturas antiguas se agrupan con el plazo que tiene hoy, no el que tenía al facturar. Congelarla por factura es un cambio de modelo, pendiente de confirmar con Gerencia.* Por cada combinación (tramo de monto × días de crédito) muestra: cantidad de facturas, **días de pago promedio** ponderado (§2), **% de facturas en mora** (partidas con `dias_vencida > 0` sobre el total de esa celda) y deuda abierta.
- **Objetivo:** ver si los pedidos grandes, o los plazos largos, se pagan más tarde que el resto — sin asumirlo de antemano.
- **Umbral de mora relevante** (para resaltar una celda): `MOROSIDAD_PATRON_PCT`, % de facturas en mora a partir del cual la celda se marca. Valor de referencia **20 %**.
- **Tabla matricial** (exportable): una fila por combinación, ordenable por % de mora o por días de pago.

### 14.3 Patrones de Velocidad tras Quiebre (`/reportes/analisis-avanzado/velocidad-quiebre`)
- **Filtros:** año, grupo/familia de producto, almacén.
- **Definición:** reusa `vw_existencia_diaria` y el kardex de M6 (§9) para ubicar los **episodios de quiebre** de cada producto: tramos de días consecutivos con existencia comercial ≤ 0, con su fecha de inicio y la fecha en que vuelve a haber existencia. Para cada episodio compara la **velocidad de venta** (unidades ÷ día, §9.1) en los `VENTANA_VELOCIDAD_QUIEBRE_DIAS` días previos al quiebre contra los mismos días posteriores a la reposición.
  - `VENTANA_VELOCIDAD_QUIEBRE_DIAS`: tamaño de cada ventana. Valor de referencia **15 días**.
- **Tabla** (exportable): producto, almacén, fecha del quiebre, duración (días), velocidad antes, velocidad después y variación %. Ordenable por variación % descendente, para ubicar primero los productos cuya demanda "explota" al reponerse (demanda reprimida liberada) frente a los que no recuperan su venta.

### 14.4 Patrones de Quiebres de Stock (`/reportes/analisis-avanzado/quiebres`)
- **Filtros:** año, grupo/familia de producto, almacén.
- **Definición:** agrupa los mismos episodios de §14.3 por producto (o por grupo/familia) y muestra: cantidad de episodios en el periodo, duración total y promedio en días, y la **venta perdida estimada** acumulada (§9.1), para priorizar qué productos se quiebran con más frecuencia, no solo los que tienen más venta perdida en un momento dado.
- **Tabla** (exportable), por defecto ordenada por cantidad de episodios descendente; un selector permite ordenar por duración total o por venta perdida.
- **Gráfico:** línea de cantidad de episodios por mes, para ver si los quiebres se concentran en ciertos meses (por ejemplo, antes de una reposición periódica).

**Pendiente de confirmar con Gerencia:** los cuatro parámetros de esta sección (tramos del histograma, umbral de mora relevante y ventana de velocidad) son valores de referencia para empezar a probar; igual que los umbrales de inventario de la [decisión 21 de octubre](decisiones.md), se ajustan cuando Gerencia los revise con datos reales.
