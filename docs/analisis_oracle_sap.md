# Qué aplicar de Oracle Fusion Cloud ERP y SAP S/4HANA para decidir mejor

> **Estado.** Borrador de análisis (08-10-2026). Son propuestas del equipo de desarrollo; las decisiones, los umbrales y las prioridades deben validarse con Gerencia (§11). Este documento **no cambia ninguna regla vigente**: lo que se acepte se incorpora a la [especificación](spec_erp_hanei_motors.md), a [spec_reportes.md](spec_reportes.md) y al [catálogo de decisiones](catalogo_decisiones.md) en cambios aparte, como pide `AGENTS.md` §2.

---

## 0. Cómo leer este documento

- **Alcance.** Oracle Fusion Cloud ERP (Financials, Procurement, SCM y Fusion Data Intelligence) y SAP S/4HANA (analítica embebida, libro universal, crédito y cobranza, Business Data Cloud). No se contrata ni se integra ningún producto: se toman **patrones** y se implementan en el stack propio (PostgreSQL, vistas SQL y TypeScript).
- **Evidencia.** 🟢 documentación oficial del proveedor leída para este análisis. 🟡 página comercial, guía de diseño o fuente secundaria vista en resumen: orienta, pero hay que confirmarla antes de depender de ella. Las mejoras que publican los proveedores (por ejemplo, una baja de días de cobro) **no se usan como supuestos**.
- **Esfuerzo.** S (días), M (1 a 3 semanas), L (más de 3 semanas) de desarrollo. Es un orden de magnitud, no un compromiso.
- **D1–D14** son las decisiones del [catálogo](catalogo_decisiones.md). **R1–R15** son las recomendaciones de este documento.

---

## 1. Conclusiones

### 1.1 Lo esencial

1. **Lo que hace útiles a Oracle y a SAP para decidir no es la inteligencia artificial, sino la disciplina de datos que tienen debajo:** una sola definición por indicador, un libro contable que coincide con la operación por construcción, excepciones que buscan a quien debe actuar y pronósticos con historia suficiente y error publicado. El núcleo del ERP ya cumple esa disciplina (documentos inmutables, mayor con auxiliares conciliados, motor de flujo, fotos diarias de existencia y costo, catálogos de motivos). Falta la capa que lo convierte en decisiones.
2. **Esa capa casi no existe todavía.** Hechos verificados en el repositorio el 08-10-2026:
   - De las 10 vistas de `spec_reportes.md` §12 no existe ninguna. Solo hay `vw_picking_tiempos`, `vw_meta_periodo`, `vw_meta_anual`, `vw_balance_comprobacion` y `vw_control_cuadre`.
   - Los módulos M1–M6 son pantallas que dicen «se habilita en la Fase N».
   - El Inicio muestra el estado de la configuración y el cuadre del mayor; sus indicadores comerciales dicen que aparecerán cuando haya operaciones.
   - No hay registro de indicadores, alertas ni tablero por rol.
3. **Faltan fuentes de datos de la Fase 2 que alimentan las decisiones más valiosas:** cobros y promesas de pago (D2, D4, D10), notas de crédito con motivo (D9), transporte y flete (D8) y promociones (D3). No existe ninguna tabla de cobros, notas de crédito, transporte, promociones ni pagos. Sin ellas, cobranza, crédito y flujo de caja no tienen con qué analizarse, y los datos **irrecuperables** (§7) empiezan a perderse.
4. **Orden recomendado:** primero los fundamentos (R1, R2, R3 y la conciliación de R6), junto con las victorias rápidas de §5 que ya tienen datos (inventario y compras); cerrar las fuentes pendientes de la Fase 2 antes de abrir pagos y tesorería; y dejar para después lo avanzado (R13–R15).
5. **Qué no copiar** (§8): un almacén de datos separado, la optimización multinivel, la planificación con listas de materiales y los agentes que contabilizan solos. No encajan con dos sucursales, unos 3.000 artículos y las reglas de §3.1 de la especificación.

### 1.2 Las 15 recomendaciones

| # | Recomendación | Inspirada en | Decisiones | Esfuerzo | Cuándo |
|---|---|---|---|---|---|
| R1 | Registro de indicadores con umbrales, historia mínima y semáforo | Capa semántica de Datasphere; fichas KPI de SAP; indicadores de ERP Analytics | todas | M | Ola 1 |
| R2 | Tres capas de datos (vivas, materializadas, fotos de cierre) y esquema analítico | OTBI y Fusion Data Intelligence; analítica embebida y Business Data Cloud | todas | M-L | Ola 1 |
| R3 | Salud de los datos maestros como indicador | Propuesta propia | todas | S | Ola 1 |
| R4 | Alertas con ciclo de vida y resultado | Situation Handling; Account Monitor y agente de libro mayor | D1, D2, D4, D7, D14 | M | Ola 2 |
| R5 | Inicio por rol con navegación hasta el documento | Páginas de resumen y listas analíticas de Fiori; tableros por rol | todas | M | Ola 2 |
| R6 | Cierre continuo y conciliación operativo-mayor | Advanced Financial Closing; libro universal; fotos de antigüedad | D11 | M | Ola 1 y 3 |
| R7 | Capital de trabajo y flujo de caja con niveles de certeza | Pronóstico de caja de Oracle; pronóstico de liquidez de SAP | D10 | L | Ola 2 |
| R8 | Cobranza y crédito: perfil de pago, promesas y puntaje configurable | Cobranzas de Oracle; Credit Management de SAP; predicciones de ERP Analytics | D2, D4 | M-L | Ola 2 |
| R9 | Inventario por segmentos con políticas y stock de seguridad por nivel de servicio | Replenishment Planning; ABC/XYZ y lento movimiento de SAP | D1, D6 | L | Ola 1-2 |
| R10 | Rentabilidad y precio: costo de reposición, margen neto, asignaciones y análisis precio-volumen-mezcla | Material Ledger; análisis de margen; variaciones de precio de compra | D3, D11 | M-L | Ola 2 |
| R11 | Compras y proveedores: desempeño y costo en destino | Analítica de compras y gasto de Oracle; desviaciones GR/IR de SAP | D7 | M | Ola 1-2 |
| R12 | Controles continuos y detección de anomalías | Agente de libro mayor; situaciones de SAP | D14 | M | Ola 2 |
| R13 | Presupuesto y proyección móvil | SAP Analytics Cloud; Oracle EPM | D11 | M | Ola 3 |
| R14 | Modelos predictivos con ciclo de vida y error publicado | Escenarios de ML de SAP; Demand Management | D12 | L | Ola 4 |
| R15 | Asistente de lenguaje natural de solo lectura (opcional) | Joule y agentes de Oracle | todas | M | Ola 4 |

---

## 2. Qué hacen Oracle y SAP (y qué se puede copiar)

| Patrón | Oracle Fusion | SAP S/4HANA | Qué se toma |
|---|---|---|---|
| **Dos niveles de analítica** | OTBI consulta las transacciones vivas con la seguridad de la aplicación; Fusion Data Intelligence (con ERP Analytics) guarda historia, predicciones y datos externos, y Oracle aconseja no cargar lo embebido con historia ni mezcla de fuentes 🟡. El almacén se actualiza a diario, con refresco frecuente en vista previa 🟢 | Analítica embebida sobre vistas CDS: fichas KPI, listas analíticas, páginas de resumen y más de 100 informes multidimensionales 🟢. Business Data Cloud, Datasphere y SAP Analytics Cloud para historia y planificación 🟡 | Vistas vivas para operar y capa materializada con fotos para la historia, ambas en PostgreSQL (R2) |
| **Definición única de cada medida** | ERP Analytics trae medidas, tableros e indicadores prefabricados, enfocados en rentabilidad, capital de trabajo y control del gasto 🟢 | En Datasphere cada medida (por ejemplo, el margen neto) se define una vez y la reutilizan informes, análisis e IA 🟡 | Registro de indicadores (R1) |
| **Libro único con dimensiones** | Los análisis contables permiten bajar del saldo al asiento y al auxiliar 🟡 | Libro universal (ACDOCA): la contabilidad financiera y el análisis de margen leen las mismas líneas, sin conciliar finanzas y costos 🟡. La contabilidad predictiva guarda lo esperado en un libro de extensión, fuera del reporte externo 🟡 | Conciliación continua entre lo operativo y el mayor (R6); dimensiones mínimas en el mayor (R10) |
| **De la cifra al documento** | Tableros por rol y monitores de cuentas con detalle hasta el auxiliar 🟡 | Fichas KPI que abren un detalle predefinido, listas analíticas para buscar causas y actuar, páginas de resumen por rol 🟢 | Inicio por rol y navegación hasta el documento (R5) |
| **Excepciones que buscan a la persona** | Umbrales de saldos y reglas de monitoreo en lenguaje natural en el agente de libro mayor (anunciado en octubre de 2025) 🟡 | Situation Handling: plantillas, aviso por notificación, correo o dentro de la aplicación, estado de cada situación y acción propuesta; su guía pide limitar y agrupar las alertas 🟡 | Alertas con ciclo de vida y resultado (R4) |
| **Predicción acotada a una decisión** | Fecha esperada de cobro y riesgo de cada factura abierta, y pago a tiempo a proveedores (vista previa en la documentación 23R3) 🟢. Pronóstico de caja continuo, dentro de Cloud EPM según su blog 🟡. Demand Management con métodos bayesianos y error MAPE 🟡 | Pronóstico de liquidez con niveles de planificación 🟡. Escenarios de ML para materiales de lento movimiento 🟡. ML para conciliar cobros 🟡 | Estadística transparente primero; modelos solo con historia y error publicado (R7, R8, R9, R14) |
| **Política por segmento** | Replenishment Planning agrupa artículo y ubicación en segmentos con política propia; el stock de seguridad se calcula por días de cobertura o por nivel de servicio (normal, o Poisson si la demanda es intermitente) 🟢. El ABC sirve para el conteo cíclico 🟢 | ABC y XYZ, antigüedad del inventario en tramos y materiales de lento movimiento con proyección 🟡 | Segmentos con políticas editables (R9) |
| **Cierre como proceso medible** | Fotos periódicas de la antigüedad de cartera por fecha contable 🟢 | Advanced Financial Closing: listas de tareas con dependencias, ejecución automática, alertas y aprobaciones 🟡 | Cierre continuo (R6) |
| **Puntaje configurable** | Cobranzas con fórmulas de componentes ponderados (pesos que suman uno, topes) por segmento 🟡 | Credit Management con puntaje y límite por fórmula; el cálculo automático exige una licencia adicional 🟡 | Modelo de puntaje por datos (R8, R11) |
| **Más de una valoración** | Variaciones de precio de compra por tipo, favorables y desfavorables 🟡 | Material Ledger: hasta tres valoraciones en paralelo (legal, grupo, centro de beneficio) por moneda 🟡 | Costo promedio y costo de reposición (R10) |
| **Análisis por unidad primaria** | ERP Analytics convierte todo a la unidad de medida primaria 🟢 | — | Análisis en unidades, kg y m³ con las medidas de empaque ya capturadas (R9, R11) |
| **Asistente sobre un modelo gobernado** | AI Agent Studio y agentes de finanzas (octubre de 2025) 🟡 | Joule y «Just Ask» sobre modelos de SAC, con los permisos del usuario 🟡 | Asistente de solo lectura sobre indicadores registrados (R15) |

**Nota sobre la evidencia.** Las funciones de predicción de ERP Analytics que cito están descritas como *vista previa* en la documentación 23R3 (2023); su estado actual debe confirmarse con Oracle. La mayor parte del material de SAP sobre situaciones, crédito, liquidez y cierre viene de páginas de diseño, blogs y cursos del propio proveedor, vistos en resumen.

---

## 3. Dónde estamos hoy

| Capacidad | Ya existe | Falta |
|---|---|---|
| Datos transaccionales confiables | Documentos inmutables, mayor con triggers, auxiliares iguales al mayor (CxC, inventario, CxP) con pruebas, auditoría, motor de flujo | — |
| Fotos para tener historia | `existencia_diaria`, `costo_diario`, historial de cartera, tasa BCV diaria | Cartera por edades, cuentas por pagar y valor del inventario al cierre de cada mes; historia de límites y condiciones solo en `audit_log` |
| Datos para decidir (catálogo §3) | Motivos de descuento, anulación, merma y venta perdida; demanda no atendida; costo en la línea de venta; tiempos de picking | Motivo de devolución en uso (falta la nota de crédito), gestiones y promesas de cobro, promociones, cotizaciones, canal de venta |
| Compras (Fase 3) | Orden con fecha prometida, recepción, factura con tolerancia, diferencia de precio como ajuste de costo, gastos de importación repartidos | Mínimos, múltiplos y plazo pactado por proveedor y producto; embarque y fecha estimada de llegada; cotizaciones |
| Vistas analíticas (`spec_reportes` §12) | Las 5 vistas mencionadas en §1.1 | Las 10 de §12 |
| Pantallas de reportes | Placeholders M1–M6 | Todo el contenido |
| Inicio | Configuración del arranque y cuadre del mayor | Indicadores comerciales y por rol |
| Registro de indicadores, alertas, tablero por rol | No existen | R1, R4, R5 |
| Cierre mensual | Checklist en la especificación (§12.4) | Herramienta que lo ejecute y lo controle |
| Fase 2 pendiente | — | Cobros y aplicaciones, retenciones recibidas, pronto pago, notas de crédito, débito y devoluciones, transporte |

---

## 4. Recomendaciones

### Bloque A · Fundamentos de la capa analítica

#### R1 · Registro de indicadores (la «capa semántica» del ERP)
- **Qué hacen.** SAP define cada indicador una vez, con umbrales, objetivo y detalle, y en Datasphere comparte una sola definición de las medidas entre informes, análisis e IA 🟡. Oracle entrega medidas e indicadores prefabricados 🟡.
- **Propuesta.** Tabla `indicador` (código, nombre, definición en texto, vista de origen, unidad, sentido bueno, decisión D# y responsable, frecuencia, **historia mínima** en días) y `indicador_umbral` con vigencia (amarillo, rojo, objetivo) que edita Gerencia, con registro en auditoría. Toda tarjeta, semáforo y alerta sale de aquí.
- **Regla.** Ningún indicador sin decisión, responsable, vista y prueba automatizada (principio 1 del catálogo, `AGENTS.md` §2). Si no hay historia mínima, la pantalla lo dice (principio 5).
- **Efecto.** Reemplaza los umbrales «configurables» dispersos de `spec_reportes` (5 % de devolución, 45 días de cliente dormido, 15 días de cobertura, 60 % de disponibilidad…) por datos con vigencia y auditoría.
- **Esfuerzo** M · **Ola** 1 · **Decisiones** todas.

#### R2 · Tres capas de datos y un esquema analítico
- **Qué hacen.** Oracle separa lo vivo (OTBI) de lo histórico (Fusion Data Intelligence) y publica fotos periódicas de antigüedad de cartera por fecha contable 🟢; SAP separa la analítica embebida de Business Data Cloud 🟡.
- **Propuesta**, todo dentro de PostgreSQL:
  1. **Vivas:** las `vw_*` de `spec_reportes` §12, para lo que se opera hoy.
  2. **Materializadas:** agregados diarios y mensuales (`mv_*`), refrescados por la noche y al cerrar el periodo.
  3. **Fotos inmutables:** lo que ya existe (`existencia_diaria`, `costo_diario`) más fotos de cierre mensual de cartera por edades, cuentas por pagar, valor del inventario y tasa, escritas al cerrar el periodo.
- **Seguridad.** Esquema `analitica` y rol `analitica_lectura` de solo lectura. Seguridad por fila en la base (equivale a los controles de acceso de las vistas de SAP) y una prueba por rol para cada vista (`AGENTS.md` §6). Réplica de lectura solo si las pantallas pesadas afectan la operación.
- **Esfuerzo** M-L · **Ola** 1 · **Decisiones** todas.

#### R3 · Salud de los datos maestros como indicador
- **Propuesta propia**, a partir de §5.5 de la especificación y de las medidas de empaque agregadas hace poco. Porcentaje de productos activos con peso, volumen, categoría, aplicación vehicular, precio vigente y costo; clientes con vendedor, condición y límite; proveedores con plazo pactado y mínimo de compra; nombres casi duplicados; productos sin movimiento.
- Cada reporte que depende de un dato muestra su cobertura: por ejemplo, «el 62 % de los productos tiene peso; el reparto por peso no es posible para los demás». Es la contraparte del principio «sin historia suficiente no hay cifra».
- **Esfuerzo** S · **Ola** 1.

#### R4 · Alertas («situaciones») con ciclo de vida y resultado
- **Qué hacen.** SAP detecta situaciones con plantillas, avisa por notificación, correo o dentro de la aplicación, lleva el estado de cada una (abierta, resuelta, obsoleta, inválida) y propone acciones; su guía de diseño pide limitar la cantidad por persona y agruparlas 🟡. Oracle usa umbrales en sus monitores de cuentas y reglas de monitoreo en lenguaje natural en el agente de libro mayor 🟡.
- **Propuesta.** `alerta_regla` (indicador o vista, condición con parámetros, severidad, a quién avisa —un rol o el responsable del objeto: el vendedor del cliente, el comprador de la orden—, acción sugerida con enlace) y `alerta` (regla, objeto, estado *abierta, en gestión, resuelta, descartada, vencida*, responsable, fechas y **resultado** de un catálogo: pagó, se recuperó la venta, se corrigió, falsa alarma).
- **Reglas.** No se duplica una alerta abierta del mismo objeto. Vence y escala como el motor de flujo (sin proceso programado donde se pueda calcular al leer). Hay un máximo visible por persona y agrupación por objeto. **Una alerta sin dueño no se crea.**
- **Cierra el vacío del catálogo** (principio 7 y D14): el resultado queda enlazado a la decisión.
- **Primeras 12 alertas:**
  1. Producto bajo punto de reorden o en riesgo de quiebre (D1).
  2. Cliente al 80 % de su límite de crédito (D2).
  3. Cliente con partida vencida más de N días (D2, D4).
  4. Promesa de pago vencida (D4).
  5. Pedido retenido por crédito sin decidir más de N horas (D2).
  6. Orden de compra con entrega prometida vencida (D7).
  7. Mercancía recibida sin facturar más de N días (cuenta 2.1.02).
  8. Factura de proveedor retenida más de N días (D7).
  9. Precio de lista por debajo del costo de reposición más el margen mínimo (D3).
  10. Tasa BCV del día sin cargar, o diferencia entre un auxiliar y el mayor (integridad).
  11. Picking fuera del objetivo de su prioridad (D8).
  12. Ajuste de inventario pendiente más de N días, o mermas atípicas (D14).
- **Esfuerzo** M · **Ola** 2 · depende de R1.

#### R5 · Inicio por rol con navegación hasta el documento
- **Qué hacen.** Las páginas de resumen de SAP reúnen en tarjetas lo clave de un rol bajo un filtro común y enlazan a informes y aplicaciones; las fichas KPI abren un detalle y las listas analíticas permiten buscar la causa y actuar 🟢. Oracle ofrece tableros por rol 🟡.
- **Propuesta.** Cada rol ve sus tarjetas (generadas desde `indicador`), sus alertas y su bandeja de aprobaciones. Toda cifra se abre en una lista filtrada y, desde ella, en el documento: la trazabilidad de §3.3 de la especificación aplicada a cada indicador. Los filtros comunes (periodo, sucursal, moneda) viajan en la URL, como en el dashboard anterior.
- **Tarjetas por rol (propuesta):**
  - *Gerencia:* ciclo de conversión de efectivo, margen del mes frente a la meta, cartera vencida, caja de las próximas semanas, alertas críticas, aprobaciones.
  - *Compras:* sugerido de compra, órdenes atrasadas, facturas retenidas, variación del precio de compra.
  - *Almacén:* picking frente al objetivo, conteos pendientes, quiebres.
  - *Cobranzas:* promesas de hoy, vencido por tramo.
  - *Ventas:* avance de meta, clientes dormidos, pedidos retenidos.
  - *Contabilidad:* avance del cierre, cuadre de auxiliares, tasa.
  - *Auditor:* hallazgos abiertos.
- Reemplaza las 4 tarjetas fijas de `spec_reportes` §3.
- **Esfuerzo** M · **Ola** 2 · depende de R1 y R4.

#### R6 · Cierre continuo y conciliación entre lo operativo y el mayor
- **Qué hacen.** SAP Advanced Financial Closing arma por periodo listas de tareas con dependencias, ejecución automática, alertas y aprobaciones 🟡. Con el libro universal, finanzas y análisis de margen leen las mismas líneas y no hay que conciliarlos 🟡. Oracle publica fotos periódicas de antigüedad por fecha contable 🟢.
- **Propuesta.**
  1. `cierre_tarea` por periodo, con la lista de §12.4 como plantilla: tareas **automáticas**, cada una apoyada en una vista de control que debe dar cero, y tareas manuales con responsable y evidencia.
  2. `vw_conciliacion_operativo_mayor`: ventas de los documentos frente a 4.1.x, costo de ventas de los movimientos frente a 5.1.01, valor del inventario frente a 1.3.01, CxC, CxP y 2.1.02 frente a sus auxiliares, con la diferencia por periodo. Hoy esos cuadres solo existen como pruebas automatizadas, no como control que corre en la operación.
  3. Fotos de cierre mensual (R2).
- **Criterio de diseño.** El mayor sigue siendo la fuente legal. Las dimensiones mínimas van en el mayor (sucursal, vía centro de costo) y el detalle por producto, cliente y vendedor se queda en las vistas de documentos, conciliadas por el punto 2.
- **Esfuerzo** M · **Ola** 1 (la conciliación) y 3 (el cierre completo).

### Bloque B · Analítica por decisión

#### R7 · Capital de trabajo y flujo de caja con niveles de certeza (D10)
- **Qué hacen.** Oracle describe un pronóstico de caja continuo que combina métodos por línea y periodo y avisa de variaciones relevantes 🟡; su ERP Analytics se centra en rentabilidad, capital de trabajo y control del gasto 🟢. SAP proyecta la liquidez con niveles de planificación y distingue la certeza de cada flujo (facturas, pedidos, compras) 🟡.
- **Propuesta.**
  - **Ciclo de conversión de efectivo:** días de inventario + días de cobro − días de pago, en USD, por mes, con su descomposición y una sensibilidad real calculada con las ventas diarias a crédito («cada día de cobro equivale a US$ X de caja»). Definición única en `vw_capital_trabajo_mes`.
  - **Flujo de caja de 13 semanas por moneda.** Entradas: partidas por cobrar en su **fecha esperada de pago** (R8) y pedidos aprobados por facturar. Salidas: cuentas por pagar por vencimiento, órdenes aprobadas pendientes de recibir (con fecha estimada de llegada), gastos recurrentes, calendario fiscal, comisiones y nómina. Cada línea lleva su **nivel de certeza**: documento contabilizado, compromiso aprobado o estimación recurrente.
  - **Prueba retrospectiva semanal:** lo pronosticado frente a lo real, con el error publicado. Sin historia, «sin dato».
  - **Posición y exposición cambiaria:** activos y pasivos por moneda y efecto de una variación de la tasa (cálculo directo, no modelo).
- **Datos.** Cobros, pagos y bancos (Fases 2 y 3), fecha estimada de llegada, calendario fiscal.
- **Esfuerzo** L · **Ola** 2, después de cobros y pagos.

#### R8 · Cobranza y crédito (D2, D4)
- **Qué hacen.** Oracle puntúa la cobranza con fórmulas de componentes ponderados, gestiona promesas de pago con estado (cumplida o rota) conciliadas contra los cobros y asigna estrategias 🟡; su ERP Analytics ofrece predicción de fecha de cobro y de riesgo por factura abierta 🟢. SAP puntúa el crédito por fórmula y cobra aparte el cálculo automático 🟡.
- **Propuesta.**
  1. **Perfil de pago por cliente** (`vw_cliente_perfil_pago`): mediana y percentil 80 de los días de pago, días ponderados por monto, porcentaje a tiempo, cantidad de pagos, tendencia de los últimos pagos, devoluciones y promesas rotas. Con menos pagos que el mínimo (parámetro): «sin historia suficiente».
  2. **Fecha esperada de pago** por partida = emisión + mediana propia del cliente, y si no hay historia, la del segmento por condición de pago. Alimenta el flujo de caja (R7) y la lista de trabajo.
  3. **Promesas de pago** (`promesa_pago`): cliente, partidas, fecha y monto prometidos, quién la tomó. Estado *vigente, cumplida, rota*, conciliado automáticamente al aplicar un cobro; una promesa rota crea una alerta y baja el puntaje.
  4. **Puntaje configurable** (`modelo_puntaje` y `modelo_puntaje_componente`: indicador, peso, topes, vigencia y versión), un solo mecanismo para clientes y proveedores (R11). Los cambios los aprueba Gerencia por el motor de flujo. El puntaje vigente se guarda en cada excepción de crédito aprobada, para medir después si se decidió bien (D14).
  5. **Lista de trabajo priorizada:** monto × días vencidos × (1 − fiabilidad de promesas).
  6. **Costo implícito del pronto pago:** tasa anualizada equivalente del descuento (entre 10 % y 25 % según la especificación) frente a un **costo de oportunidad** que fija Gerencia, el porcentaje de clientes que lo toman y su efecto en los días de cobro.
  7. Modelos estadísticos (por ejemplo, regresión logística de pago tardío) solo en la Fase 8 y solo si superan a la regla simple en prueba retrospectiva.
- **Esfuerzo** M-L · **Ola** 2, requiere cobros.

#### R9 · Inventario por segmentos con políticas (D1, D6)
- **Qué hacen.** Oracle agrupa artículo y ubicación en segmentos dinámicos con política propia y calcula el stock de seguridad por días de cobertura o por nivel de servicio, con distribución normal si la demanda es regular y Poisson si es intermitente 🟢; el ABC lo usa para el conteo cíclico 🟢. SAP aplica ABC y XYZ, antigüedad en tramos y proyección de materiales de lento movimiento 🟡.
- **Propuesta.**
  1. **Segmentación mensual** (`vw_inventario_segmento`): **ABC** por aporte de margen de 12 meses, **XYZ** por variabilidad de la demanda semanal en los días con existencia, y **FSN** (rápido, lento, sin movimiento) por días desde la última venta.
  2. **`politica_inventario` por segmento**, parámetros que fija Gerencia: nivel de servicio objetivo, cobertura objetivo, método de stock de seguridad y frecuencia de conteo cíclico.
  3. **Plazo de entrega real y su variabilidad** por proveedor y producto (orden aprobada → recepción). Ya es medible con los datos de la Fase 3.
  4. **Stock de seguridad y punto de reorden:** demanda durante el plazo más un margen que sale de la variabilidad de la demanda y del plazo (fórmula estándar de manual); para demanda intermitente, el percentil de Poisson. Se respeta el mínimo y el múltiplo de compra del proveedor. Mientras no haya suficientes entregas o semanas con datos, rige el método de días de cobertura de `spec_reportes` §9.
  5. **Antigüedad del inventario** por tramos (0-30, 31-60, 61-90, 91-180 y más de 180 días desde la última entrada o venta) con su valor al costo; «próximos a ser lentos» (cobertura alta y velocidad en caída). La provisión por obsolescencia es una decisión contable pendiente.
  6. **Nivel de servicio real** (líneas completas sobre líneas pedidas, con la demanda no atendida) y días de quiebre frente al objetivo de cada segmento.
  7. **Transferencias sugeridas entre sucursales** (exceso en una, quiebre en otra) antes de comprar.
  8. **Análisis en unidad primaria** (unidades, kg, m³) con las medidas de empaque ya capturadas.
- **Entrega.** Es la extensión natural del M6 de `spec_reportes` §9, con el botón «Crear orden de compra» que ya es posible. Se empieza por el M6 básico.
- **Esfuerzo** L, por etapas · **Ola** 1-2.

#### R10 · Rentabilidad y precio (D3, D11)
- **Qué hacen.** SAP mantiene hasta tres valoraciones en paralelo por moneda en el Material Ledger y reparte las diferencias de precio y de cambio 🟡; su análisis de margen lee las mismas líneas del libro 🟡. Oracle analiza las variaciones de precio de compra por tipo, favorables y desfavorables 🟡.
- **Propuesta.**
  1. **Dos costos:** el promedio (contable, lo que hay) y el de **reposición** (último costo de compra con su costo en destino, `vw_costo_reposicion`). Se mide el margen sobre ambos: con tasa y costos que se mueven, el margen sobre reposición dice si se puede volver a comprar lo que se vende.
  2. **Precio rezagado:** alerta cuando el precio vigente (A, B o D) deja menos que el margen mínimo sobre el costo de reposición, y comparación de los días desde el último cambio de precio con la variación del costo y de la tasa.
  3. **Margen neto** por cliente, vendedor, canal, sucursal y categoría = venta neta − costo − descuentos − devoluciones − comisión − flete asignado − costo financiero del crédito (días de cobro × costo de oportunidad).
  4. **Reglas de asignación** de gastos comunes y fletes (`regla_asignacion`: driver —venta, líneas, kg o m³ despachados—, vigencia y corrida mensual inmutable). El mismo motor de reparto de los gastos de importación sirve para repartir el flete de un transporte por peso o volumen.
  5. **Análisis precio-volumen-mezcla-costo** entre dos periodos: descompone el cambio de venta y de margen en precio, volumen, mezcla, costo, descuentos y diferencia de tasa. Es un cálculo exacto, la versión determinista de las «explicaciones de variación» que anuncian los asistentes de ambos proveedores 🟡.
  6. Elasticidad y efecto de promociones: Fase 8, como está en la especificación.
- **Datos.** Notas de crédito y devoluciones, comisiones, transporte y promociones, más el canal de venta (§7).
- **Esfuerzo** M-L · **Ola** 2.

#### R11 · Compras y proveedores (D7)
- **Qué hacen.** Oracle mide el gasto por centro de costo y ubicación, el ciclo de la orden, la fuga de contratos y la puntualidad y los rechazos de recepción 🟡. SAP lanza situaciones por desviaciones entre la mercancía recibida y la facturada 🟡.
- **Propuesta.** Un tablero de desempeño por proveedor y marca, casi todo con datos de la Fase 3 (§5): cumplimiento de la fecha prometida, completitud de lo recibido, variación del precio de compra (facturado frente a la orden), costo en destino como porcentaje del valor, devoluciones y rechazos, plazo real y su variabilidad, y concentración (participación de los tres mayores). El puntaje usa el mecanismo de R8 con pesos fijados por Gerencia. Se agregan la captura de **cotizaciones** (ofrecido frente a comprado), de mínimos, múltiplos y fecha estimada de llegada, y una comparación del costo de cada producto bajo los cuatro criterios de reparto del costo en destino (valor, peso, volumen, cantidad).
- **Esfuerzo** M · **Ola** 1 (vistas con datos existentes) y 2.

#### R12 · Controles continuos y detección de anomalías (D14)
- **Qué hacen.** Oracle describe un agente de libro mayor que vigila de forma continua y explica lo que encuentra 🟡; SAP lanza situaciones sobre desviaciones 🟡.
- **Propuesta.** `control_continuo` (regla, vista, umbral, severidad) que genera hallazgos con la misma mecánica de R4, dirigidos al Auditor. Con estadística robusta (mediana y desviación absoluta mediana, percentiles) y **sin aprendizaje automático**:
  - descuentos de un vendedor fuera de lo normal frente a sus pares;
  - precio de compra fuera del rango histórico del producto o del proveedor;
  - ajustes de inventario concentrados por persona, almacén u hora;
  - notas de crédito poco después de un cobro o de liquidar una comisión;
  - asientos manuales cerca del cierre y documentos con fecha retroactiva;
  - un mismo aprobador que aprueba siempre al mismo solicitante;
  - usuarios con combinaciones de roles incompatibles (control detectivo de la segregación de funciones, aunque la base ya impide varias).
- **Esfuerzo** M · **Ola** 2.

### Bloque C · Analítica avanzada

#### R13 · Presupuesto y proyección móvil (D11)
- **Qué hacen.** SAP Analytics Cloud y Oracle EPM ofrecen planificación, variaciones y escenarios 🟡.
- **Propuesta.** Presupuesto por cuenta × centro de costo × mes como **lote versionado y aprobado**, igual que las metas (nace pendiente y lo aprueba Gerencia, distinta de quien lo cargó). Vista de real contra presupuesto; una variación sobre el umbral exige comentario; proyección móvil = real acumulado + resto del año con la tendencia y la estacionalidad ya medidas; escenarios sencillos (tasa, días de cobro, margen) como parámetros del cálculo, no cajas negras.
- **Esfuerzo** M · **Ola** 3.

#### R14 · Modelos predictivos con ciclo de vida y error publicado (D12)
- **Qué hacen.** SAP gestiona los escenarios de ML con ciclo de vida (entrenar, activar, versionar) 🟡; Oracle Demand Management descompone la demanda en base, tendencia, estacionalidad y eventos, y publica el error 🟡. SAP advierte que los pronósticos de ML de la contabilidad predictiva no permiten rastrear el cálculo, por eso se mantienen aparte del reporte externo 🟡.
- **Propuesta.** Registro `modelo` (nombre, versión, alcance, ventana de entrenamiento, método, métricas de prueba retrospectiva en meses no usados para ajustar, estado *borrador, validado, activo, retirado*). Solo se muestran modelos activos, con su error; se retiran solos si el error supera el umbral varios meses seguidos; ningún modelo se activa si no supera la línea base (promedio móvil estacional o ingenuo). Los pronósticos viven aparte de los datos contables y nunca escriben asientos. Es la Fase 8 de la especificación, con al menos 12 meses de datos.
- **Esfuerzo** L · **Ola** 4.

#### R15 · Asistente de lenguaje natural de solo lectura (opcional)
- **Qué hacen.** Joule responde sobre modelos de SAC con los permisos del usuario 🟡; Oracle ofrece AI Agent Studio y agentes de finanzas 🟡. Lo común: trabajan sobre un modelo gobernado y con los derechos de quien pregunta.
- **Propuesta.** Solo después de R1 y R2. El asistente **no escribe SQL contra las tablas operativas**: llama a un catálogo de herramientas de solo lectura (los indicadores y vistas registrados) con la seguridad por fila de quien pregunta, y responde con la cifra, su definición, los filtros, el periodo y el enlace a la lista. Si no hay historia suficiente, lo dice; no calcula por su cuenta. Las preguntas y las exportaciones quedan en el registro de auditoría. **Nunca contabiliza ni aprueba**: el motor contable y el de flujo siguen siendo el único camino de escritura.
- **Decisión previa.** Qué roles pueden consultar costos y márgenes.
- **Esfuerzo** M · **Ola** 4, opcional.

---

## 5. Victorias rápidas con lo que ya se captura

Estas vistas no esperan a ninguna fase nueva: sus datos ya existen.

| # | Vista o indicador | Datos | Decisión |
|---|---|---|---|
| 1 | Mercancía recibida sin facturar, envejecida (cuenta 2.1.02 por recepción) | Recepciones y facturas de compra | Cierre, D7 |
| 2 | Órdenes con entrega prometida vencida, y órdenes sin fecha prometida | `documento_compra` | D7 |
| 3 | Plazo real de entrega por proveedor y producto, y su variabilidad | Orden aprobada → recepción | D1, D7 |
| 4 | Variación del precio de compra (facturado frente a la orden) por proveedor y producto | `factura_compra_linea.dif_precio`, `ajuste_costo` | D7 |
| 5 | Costo en destino como porcentaje del valor, por proveedor, producto y criterio de reparto | `gasto_importacion_reparto` | D7 |
| 6 | Antigüedad y calendario de vencimientos de las cuentas por pagar | `partida_cxp` | D10 |
| 7 | Margen por línea con la foto del costo, descuentos por motivo, ventas perdidas por motivo y producto | `documento_venta_linea`, `motivo`, `demanda_no_atendida` | D3, D5 |
| 8 | M6 básico: velocidad ajustada, cobertura, quiebres y sugerido de compra, con «Crear orden de compra» | `existencia_diaria`, ventas, órdenes pendientes | D1 |
| 9 | Capital inmovilizado y antigüedad del inventario | `producto_costo`, movimientos | D6 |
| 10 | Tiempos de picking frente al objetivo y causas de faltante | `vw_picking_tiempos` | D8 |
| 11 | Salud de los datos maestros (R3) | Maestros | todas |

---

## 6. Vistas y tablas nuevas (resumen)

| Objeto | Grano o contenido | Recomendación |
|---|---|---|
| `indicador`, `indicador_umbral` | Definición, unidad, sentido, decisión, responsable, historia mínima; umbrales con vigencia | R1 |
| `alerta_regla`, `alerta` | Regla; instancia con estado, responsable y resultado | R4 |
| `cierre_tarea` | Tarea por periodo, automática o manual | R6 |
| `vw_conciliacion_operativo_mayor` | Operativo frente a mayor, por periodo y cuenta | R6 |
| `cierre_foto_*` | Cartera por edades, cuentas por pagar, inventario y tasa al cierre | R2, R6 |
| `vw_calidad_maestros` | Completitud por maestro | R3 |
| `vw_cliente_perfil_pago` | Por cliente: mediana, percentil 80, porcentaje a tiempo, cantidad de pagos, promesas | R8 |
| `promesa_pago` | Promesa con estado conciliado contra los cobros | R8 |
| `modelo_puntaje`, `modelo_puntaje_componente` | Pesos, topes, vigencia y versión | R8, R11 |
| `vw_flujo_caja_semana` | Semana × moneda × nivel de certeza | R7 |
| `vw_capital_trabajo_mes` | Días de inventario, de cobro, de pago y ciclo de conversión | R7 |
| `vw_inventario_segmento`, `politica_inventario` | ABC, XYZ y FSN; política por segmento | R9 |
| `vw_inventario_antiguedad` | Tramos con su valor | R9 |
| `proveedor_producto` | Mínimo, múltiplo, plazo pactado y proveedor principal | R9, R11 |
| `vw_costo_reposicion` | Último costo de compra con su costo en destino | R10 |
| `regla_asignacion` | Driver, vigencia y corrida mensual | R10 |
| `vw_pvm` | Precio-volumen-mezcla-costo entre dos periodos | R10 |
| `vw_proveedor_desempeno` | Por proveedor y marca | R11 |
| `control_continuo` | Regla estadística y su umbral | R12 |
| `presupuesto_lote`, `presupuesto_linea` | Cuenta × centro × mes, versionado y aprobado | R13 |
| `modelo` | Versión, prueba retrospectiva y estado | R14 |
| `calendario`, `calendario_evento` | Día hábil, feriado, quincena y calendario fiscal | §7 |

---

## 7. Datos que hay que capturar ya

Complementa la tabla de §3 del [catálogo](catalogo_decisiones.md). Primero lo irrecuperable.

| # | Dato | Dónde se captura | Costo de omitirlo | Decisión |
|---|---|---|---|---|
| 1 | **Canal de venta** en el pedido (mostrador, ruta, teléfono o mensajería, portal). En SAP cada documento de ventas lleva su canal de distribución | Pedido | **Irrecuperable** | D5, D11 |
| 2 | Promociones y su aplicación por línea (ya previsto en la especificación) | Maestro de promociones y pedido | Alto | D3, D12 |
| 3 | Gestiones de cobro y promesas de pago (Fase 2 pendiente) | Cobranzas | Alto | D4, D10 |
| 4 | Motivo y destino de cada devolución (el catálogo ya existe; falta la nota de crédito) | Nota de crédito | **Irrecuperable** | D9 |
| 5 | Cotizaciones de proveedores (ofrecido frente a comprado) | Orden de compra | **Irrecuperable** | D7 |
| 6 | Precio de la competencia cuando se pierde una venta (campo opcional) | Venta perdida | **Irrecuperable** | D3 |
| 7 | Mínimo, múltiplo, plazo pactado y proveedor principal por producto | `proveedor_producto` | Medio | D1 |
| 8 | Embarque y fecha estimada de llegada de las órdenes de importación | Orden o expediente de importación | Alto | D1, D10 |
| 9 | Resultado enlazado a cada decisión (catálogo de resultados) | Alertas y motor de flujo | Alto | D14 |
| 10 | Fotos de cierre mensual: cartera por edades, cuentas por pagar, valor del inventario y tasa | Cierre del periodo | Medio | D2, D10, D11 |
| 11 | Transporte: salida, llegada, incidencias y flete (Fase 2 pendiente) | Transporte | Medio | D8, D11 |
| 12 | Calendario: feriados, quincenas, días hábiles y calendario fiscal | `calendario` | Bajo | D10, D12 |
| 13 | Costo de oportunidad del dinero (parámetro con vigencia) | Configuración | Bajo | D3, D4 |

Ya capturado y sin trabajo pendiente: las medidas de empaque (migración 0022), la fecha prometida de la orden, el costo en destino por compra y el plazo real de entrega, que se deriva. El **costo de reposición** también se deriva: no necesita captura.

---

## 8. Lo que no conviene copiar

| Qué | Por qué no | Cuándo reconsiderarlo |
|---|---|---|
| Almacén de datos o lago de datos separado (Fusion Data Intelligence, Business Data Cloud, Datasphere) | Con dos sucursales y unos 3.000 artículos, PostgreSQL con vistas materializadas y fotos alcanza; otra plataforma suma costo, sincronización y un segundo lugar donde las definiciones pueden divergir | Pantallas de más de 3 s ya materializadas, necesidad real de cruzar fuentes externas masivas, o carga analítica que afecte la operación (primer paso: réplica de lectura) |
| Agentes que crean asientos de ajuste (agente de libro mayor de Oracle, según su anuncio) | Choca con §3.1 de la especificación: la operación no escribe asientos y los manuales se aprueban | Nunca para escribir. Sí para vigilar y proponer |
| Optimización de inventario multinivel y planificación predictiva con listas de materiales (pMRP de SAP, multiescalón de Oracle) | No hay red de distribución compleja ni listas de materiales (decisión 12). pMRP simula planes de producción con BOM, rutas y centros de trabajo | Si se agregan listas de materiales |
| Planificación de reposición dirigida por la demanda (DDMRP) completa | Las políticas por segmento (R9) resuelven lo esencial con menos parámetros | Si las políticas por segmento se quedan cortas |
| Contabilidad predictiva con ML | El crédito ya compromete los pedidos aprobados; no se necesita contabilizar lo esperado | No aplica |
| Consolidación de grupo e intercompañía | Una empresa y dos sucursales | No aplica |
| Aprendizaje automático desde el primer día | Sin 12 meses de operación no hay base (principio 6 del catálogo) | Fase 8 |
| Licencias por unidades de IA o por usuario | Costo recurrente sin necesidad: el stack es propio | No aplica |

---

## 9. Hoja de ruta propuesta

| Ola | Qué | Depende de | Resultado |
|---|---|---|---|
| **0 · Ya (días)** | Capturas de §7 que no dependen de módulos nuevos: canal de venta, `proveedor_producto`, fecha estimada de llegada, calendario, costo de oportunidad, catálogo de resultados | — | Se deja de perder lo irrecuperable |
| **1 · Con las Fases 2 y 3 en curso** | Fuentes pendientes de la Fase 2 (cobros con promesas, notas de crédito con motivo, transporte, promociones). R1, R2, R3, conciliación de R6. Victorias rápidas de §5 (M6 con orden de compra, compras, cuentas por pagar, margen por línea) | Ola 0 | Primeros reportes reales y definiciones únicas |
| **2 · Fases 3 a 6** | R4, R5, R7, R8, R9 completo, R10, R11, R12 | Cobros, pagos y bancos; historia de entregas | Alertas, Inicio por rol, caja, cobranza, inventario por segmentos, rentabilidad |
| **3 · Fase 6** | R13 y el cierre completo de R6 | Estados financieros y comisiones | Presupuesto y cierre medido |
| **4 · Fase 8 (12 meses o más)** | R14 y, si se desea, R15 | Historia suficiente | Pronósticos con error publicado |

**Sobre el orden de la Fase 2.** Conviene cerrar cobros y notas de crédito antes de avanzar con pagos y tesorería, por cuatro razones: la aceptación de la Fase 2 exige el auxiliar de CxC igual al mayor; los reportes M1, M4 y M5 dependen de esos datos; promesas de pago y motivos de devolución solo se pueden capturar desde que existan los módulos; y el crédito del cliente se evalúa con una cartera incompleta mientras no haya cobros.

---

## 10. Reglas que se mantienen

1. **Un indicador, una definición, una vista y una prueba** (`spec_reportes` §2, `AGENTS.md` §2). Sin decisión y responsable, no se construye.
2. **Sin datos inventados.** Sin historia suficiente no hay cifra, y todo pronóstico lleva su error (L9, principio 5).
3. **Umbrales, pesos, niveles de servicio y costo de oportunidad** viven en tablas con vigencia y auditoría, nunca en el código.
4. **La analítica solo lee.** Nada analítico escribe asientos ni documentos; las acciones sugeridas pasan por los flujos existentes (órdenes de compra, ajustes, aprobaciones).
5. **Seguridad por fila y por rol en las vistas**, una prueba por rol para cada vista, exportaciones auditadas y datos personales fuera de las URL (`AGENTS.md` §6).
6. **Montos con decimales exactos**; USD de gestión y VES legal; cada vista dice en qué moneda está.
7. **Alertas con dueño, severidad y límite.** Una alerta sin dueño no se crea.
8. **Lo derivable se deriva; solo se captura lo irrecuperable.**

---

## 11. Preguntas para Gerencia

1. De las 14 decisiones, ¿cuáles duelen más hoy y en qué orden? (cambia las olas de §9). ¿Qué capacidad de este documento usarían cada semana: el flujo de caja de 13 semanas, las alertas, el inventario por segmentos?
2. **Costo de oportunidad del dinero:** ¿qué tasa usar, en USD y en bolívares? Sirve para el pronto pago, el costo financiero del crédito y el margen neto.
3. **Nivel de servicio objetivo** para los productos de mayor, media y menor importancia: ¿qué porcentaje de pedidos completos se quiere cumplir en cada clase?
4. **Precio frente a reposición:** ¿cada cuánto se actualizan hoy las listas A, B y D, y cuál es el margen mínimo sobre el costo de reposición?
5. **Canales de venta reales:** mostrador, ruta, teléfono o mensajería, portal, otros.
6. **Alertas:** ¿quién recibe cuáles y por qué canal (pantalla, correo, mensajería)? ¿Cuántas por persona son tolerables?
7. **Obsolescencia:** ¿se hace provisión por inventario lento y con qué criterio? (lo define el contador)
8. **Presupuesto:** ¿se prepara hoy? ¿A qué nivel (cuenta, centro de costo, sucursal)?
9. **Asistente de lenguaje natural:** ¿se desea y para qué roles? ¿Pueden consultar costos y márgenes?
10. ¿Se acepta completar cobros y notas de crédito antes de seguir con pagos y tesorería, para tener datos de cobranza desde el arranque?
11. **Cotizaciones y tiempos de entrega:** ¿existe registro de cotizaciones o de plazos de proveedores del sistema anterior? Aunque no se importen, sirven como referencia (`AGENTS.md` §1).

---

## 12. Equivalencias de nombres

| En Oracle o SAP | En el ERP |
|---|---|
| Libro universal (ACDOCA) | `asiento_linea` + motor contable + `vw_conciliacion_operativo_mayor` |
| Vista CDS o modelo virtual de datos | `vw_*` |
| Control de acceso de las vistas (DCL) o roles de datos de OTBI | Seguridad por fila + prueba por rol |
| Ficha KPI de Smart Business o indicador de ERP Analytics | `indicador` + `indicador_umbral` |
| Situation Handling | `alerta` |
| Página de resumen o tablero por rol | Inicio por rol |
| Advanced Financial Closing | `cierre_tarea` |
| Gestión del ciclo de vida de escenarios de ML | Registro `modelo` |
| Puntaje de cobranza o de crédito | `modelo_puntaje` |
| Segmentación y conjunto de políticas de Replenishment Planning | `politica_inventario` por segmento |
| Valoración paralela del Material Ledger | Costo promedio + costo de reposición |
| Promise to Pay | `promesa_pago` |
| OTBI o analítica embebida | Vistas vivas |
| Fusion Data Intelligence o Business Data Cloud | Capa materializada + fotos de cierre |
| Joule o agentes de IA | Asistente de solo lectura (R15) |

---

## 13. Fuentes

**Oracle**
- 🟢 [Fusion ERP Analytics: introducción y funciones en vista previa (23R3)](https://docs.oracle.com/en/cloud/saas/analytics/23r3/faiae/chapter-introduction.html)
- 🟢 [Fusion Accounting Hub Analytics (25R4)](https://docs.oracle.com/en/cloud/saas/analytics/25r4/faiae/fusion-accounting-hub-analytics.html)
- 🟢 [Cálculo del stock de seguridad en Replenishment Planning (26B)](https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/26b/faurp/how-safety-stock-is-calculated-in-oracle-replenishment-planning.html)
- 🟡 [Segmentación en Replenishment Planning (23D)](https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/23d/faurp/segmentation-in-oracle-replenishment-planning.html)
- 🟡 [Cuándo usar OTBI y cuándo Fusion Analytics](https://blogs.oracle.com/fusioninsider/learn-when-to-use-otbi-vs-fusion-analytics)
- 🟡 [Agentes de IA para finanzas (anuncio del 15-10-2025)](https://www.oracle.com/news/announcement/ai-world-oracle-ai-agents-help-finance-leaders-accelerate-business-insights-and-boost-efficiency-2025-10-15/)
- 🟡 [Pronóstico de caja con IA (blog de Oracle)](https://blogs.oracle.com/modernfinance/transform-cash-forecasting-with-ai)
- 🟡 [Fórmulas de puntaje de cobranza](https://docs.oracle.com/en/cloud/saas/financials/25a/fairp/scoring-formulas.html)
- 🟡 [Promesa de pago](https://docs.oracle.com/en/cloud/saas/financials/25a/faofc/promise-to-pay.html)
- 🟡 [Analítica de compras (recorrido del producto)](https://www.oracle.com/fusion-data-intelligence/erp-analytics/procurement-product-tour/)
- 🟡 [Estimaciones de plazo de entrega con IA en Supply Chain Planning (CFOtech)](https://cfotech.asia/story/oracle-adds-ai-tools-to-fusion-supply-chain-software)

**SAP**
- 🟢 [Analítica y reportes embebidos en S/4HANA (SAP Learning)](https://learning.sap.com/courses/outlining-cost-management-and-profitability-analysis/discussing-embedded-reporting-and-analytics-in-sap-s-4hana_d9e90624-58ef-47ca-a2c7-d7431cad00db)
- 🟢 [Predictive MRP (SAP Learning)](https://learning.sap.com/courses/exploring-production-planning-in-sap-s-4hana/introducing-predictive-mrp-pmrp-)
- 🟡 [Libro universal (SAP Learning)](https://learning.sap.com/courses/outlining-cost-management-and-profitability-analysis/discussing-the-concept-of-the-universal-journal_f62cf151-5562-44f5-8ff6-df16fb232e94)
- 🟡 [Contabilidad predictiva (SAP PRESS)](https://blog.sap-press.com/predictive-accounting-sap-s4hana)
- 🟡 [Situation Handling (guía de diseño de Fiori)](https://www.sap.com/design-system/fiori-design-web/v1-142/discover/sap-products/sap-s4hana-only/situation-handling/situation-handling)
- 🟡 [Página de resumen y lista analítica (guía de diseño de Fiori)](https://www.sap.com/design-system/fiori-design-web/v1-139/discover/frameworks/sap-fiori-elements/analytical-list-page-overview-page-sap-fiori-elements-2)
- 🟡 [Planificación de liquidez en S/4HANA (SAP PRESS)](https://blog.sap-press.com/liquidity-planning-with-sap-s4hana-finance)
- 🟡 [SAP Credit Management en S/4HANA 1909](https://blogs.sap.com/2019/11/06/sap-credit-management-in-s-4hana-1909/)
- 🟡 [Riesgo de pago tardío de facturas (caso de uso de SAP)](https://www.sap.com/use-cases/predict-risk-of-late-payment-for-invoices)
- 🟡 [Advanced Financial Closing: gestión de listas de tareas](https://blogs.sap.com/2022/03/01/sap-s-4hana-cloud-for-advanced-financial-closing-enhanced-task-list-management/)
- 🟡 [Material Ledger (SAP Learning)](https://learning.sap.com/courses/product-cost-planning-in-sap-s-4hana/describing-material-ledger)
- 🟡 [SAP Business Data Cloud: funciones](https://www.sap.com/products/data-cloud/features.html)
- 🟡 [Capa semántica unificada (SAP Learning)](https://learning.sap.com/courses/guiding-ai-driven-transformation-as-an-sap-enterprise-architect/architecting-the-unified-semantic-layer-the-data-foundation)
