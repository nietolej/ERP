# Catálogo de decisiones de negocio y datos que las sostienen

**Propósito.** El ERP no solo registra operaciones: debe ayudar a decidir mejor. Este catálogo parte de las **decisiones** que se toman en la distribuidora y deriva de ellas qué dato hay que **capturar desde el primer día**, porque un dato que no se registró no se puede recuperar después.

**Estado.** Borrador de análisis (05-10-2026). Las decisiones, los responsables y las prioridades son **propuestas del equipo de desarrollo y deben validarse con Gerencia** (ver §6). Ningún indicador de aquí se calcula todavía; las definiciones numéricas viven en [spec_reportes.md](spec_reportes.md) y se calcularán en vistas SQL, una sola vez.

**Cómo leerlo**
- ✅ el dato ya se guarda hoy · 🟡 se guarda en parte · ❌ no se guarda y hay que agregarlo.
- **Costo de omitirlo** = qué se pierde si no se captura desde el arranque: *irrecuperable* (el dato no se puede reconstruir), *alto* (se reconstruye con mucho esfuerzo) o *bajo* (se deriva de lo que ya hay).

---

## 1. Principios

1. **Primero la decisión, después el reporte.** Un indicador sin una decisión y un responsable que lo use no se construye.
2. **Capturar en el origen, no reconstruir.** Cada dato lo registra el proceso que lo genera (la recepción, el picking, el cobro), con usuario y hora, nunca una persona después.
3. **Los hechos no se reescriben.** Se agrega un registro nuevo (precio nuevo, movimiento nuevo, nota de crédito); así la historia sirve para analizar.
4. **Una definición, una vista.** Cada indicador se calcula en una vista SQL con su prueba automatizada (regla §2 de `AGENTS.md`).
5. **Sin historia suficiente, no hay cifra.** Un modelo sin datos suficientes lo dice en pantalla en lugar de mostrar un número engañoso, y todo pronóstico lleva su margen de error.
6. **Empezar simple.** Reglas, promedios, clasificación ABC y cobertura en días antes que modelos estadísticos. Se complica solo si lo simple se queda corto.
7. **La decisión también se registra.** Quién decidió, con qué información y qué pasó después; sin eso no se sabe si decidir mejor sirvió.

---

## 2. Las decisiones

Las prioridades son **A** (decide dinero o servicio todos los días), **B** (mensual o por evento) y **C** (estratégica, necesita historia).

### D1 · ¿Cuánto y cuándo comprar cada producto? · Prioridad A
| | |
|---|---|
| **Quién** | Compras, con aprobación de Gerencia según monto |
| **Cuándo** | Semanal, o al caer bajo el punto de reorden |
| **Indicadores** | Cobertura en días · rotación · velocidad de venta ajustada por los días con existencia · punto de reorden · sugerido de compra · quiebres (días sin existencia) · clasificación ABC |
| **Datos que ya existen** | ✅ movimientos de inventario con costo · ✅ existencia actual y reservada por almacén · ✅ demanda no atendida · ✅ ventas por línea |
| **Datos que faltan** | ❌ **existencia al cierre de cada día** por producto y almacén (sin ella no se separa "no se vendió" de "no había") · ❌ **tiempo de entrega real** de cada compra (pedido → recepción) por proveedor · ❌ pedidos de compra pendientes y en tránsito · ❌ cantidad mínima y múltiplo de compra por proveedor · ❌ motivo de cada compra urgente |
| **Costo de omitirlo** | **Irrecuperable** para la existencia diaria; alto para tiempos de entrega |
| **Método inicial** | Velocidad de venta de 90 días sobre los días con existencia × (cobertura deseada + tiempo de entrega) − existencia − lo pendiente |
| **Acción / alerta** | Alerta "producto bajo punto de reorden" y propuesta de orden de compra editable |
| **Fase** | Foto diaria de existencia: **ya** (Fase 2). Tiempos de entrega y compras pendientes: Fase 3 |

### D2 · ¿A quién se le da crédito y cuánto? · Prioridad A
| | |
|---|---|
| **Quién** | Gerencia (aprueba el alta y los pedidos retenidos por crédito) |
| **Cuándo** | Al aprobar un cliente y en cada pedido que excede el límite |
| **Indicadores** | Exposición vs. límite · antigüedad de saldos · días de pago ponderados · % cobrado a tiempo · mora máxima · concentración de la cartera en pocos clientes |
| **Datos que ya existen** | ✅ límite, condición de pago y aprobador del cliente · ✅ pedidos retenidos y su aprobación o rechazo · 🟡 exposición (pedidos y notas; faltan las cuentas por cobrar) |
| **Datos que faltan** | ❌ partidas de CxC y cobros (Fase 2) · ❌ **motivo** de cada excepción aprobada y **resultado** (¿pagó? ¿cuándo?) · ❌ historial de cambios del límite con motivo |
| **Costo de omitirlo** | Alto: sin el resultado no se sabe si Gerencia aprueba bien |
| **Método inicial** | Regla con límite y mora; después, comportamiento de pago histórico del propio cliente |
| **Acción / alerta** | Cliente al 80 % de su límite · cliente con mora mayor a N días (parámetro) |
| **Fase** | CxC: Fase 2. Resultado de excepciones: se captura al construir CxC |

### D3 · ¿Qué precio y qué descuento ofrecer? · Prioridad A
| | |
|---|---|
| **Quién** | Gerencia y Supervisor de ventas fijan listas; Ventas ofrece el descuento |
| **Cuándo** | Al cambiar costos o tasa y en cada pedido |
| **Indicadores** | Margen por línea, producto, cliente y vendedor · descuento promedio y fuga de margen · precio cobrado vs. precio de lista · elasticidad por segmento (Fase 8) |
| **Datos que ya existen** | ✅ precio de lista, precio cobrado, descuento y lista de cada línea · ✅ costo promedio de cada línea (se fija al despachar) · ✅ código común del producto |
| **Datos que faltan** | ❌ **motivo del descuento** (volumen, competencia, cliente clave, error) · ❌ tabla de promociones y su aplicación · ❌ precio de la competencia cuando se perdió una venta |
| **Costo de omitirlo** | **Irrecuperable** para el motivo; alto para promociones |
| **Método inicial** | Margen real vs. margen objetivo por categoría; ranking de descuentos fuera de rango |
| **Acción / alerta** | Pedido con margen bajo el mínimo · descuento que excede el máximo del rol (aún sin umbrales definidos) |
| **Fase** | Motivo del descuento: **ya** (Fase 2). Promociones: antes de abrir descuentos en producción |

### D4 · ¿A quién cobrar primero y cómo? · Prioridad A
| | |
|---|---|
| **Quién** | Cobranzas |
| **Cuándo** | Diario |
| **Indicadores** | Antigüedad por días desde emisión y desde vencimiento · efectividad de cobro · días de pago ponderados · cobros del mes vs. facturado |
| **Datos que ya existen** | ❌ ninguno todavía (llega con facturas y cobros) |
| **Datos que faltan** | ❌ partidas y cobros (Fase 2) · ❌ **gestiones de cobro**: llamada, promesa de pago, fecha prometida, resultado · ❌ motivo de la mora (disputa, falta de liquidez, error de entrega) |
| **Costo de omitirlo** | Alto: sin gestiones no se sabe qué acción funciona |
| **Método inicial** | Lista priorizada por monto × días de vencido × historial de incumplimiento de promesas |
| **Acción / alerta** | Promesa de pago vencida · cliente que pasó de un tramo de antigüedad a otro |
| **Fase** | Fase 2 (junto con cobros) |

### D5 · ¿Qué vendedor y qué cliente reforzar? · Prioridad B
| | |
|---|---|
| **Quién** | Gerencia y Supervisor de ventas |
| **Cuándo** | Mensual |
| **Indicadores** | Cumplimiento de meta · venta y margen por vendedor y cartera · clientes nuevos, activos, en riesgo y perdidos · frecuencia y ticket promedio · concentración |
| **Datos que ya existen** | ✅ metas con versiones y aprobación · ✅ cartera por vendedor · ✅ ventas por línea |
| **Datos que faltan** | ❌ **motivo de pérdida de cliente o de venta** · ❌ visitas y actividades (CRM, Fase 7) · ❌ cambios de cartera con fecha (hoy el cliente tiene un solo vendedor sin historia) |
| **Costo de omitirlo** | Alto para el historial de cartera |
| **Método inicial** | Clasificación de clientes por recencia, frecuencia y monto; semáforo de meta |
| **Acción / alerta** | Cliente sin compra en N días (por su frecuencia habitual) |
| **Fase** | Historial de cartera: Fase 2. Visitas y motivos: Fase 7 |

### D6 · ¿Qué productos descontinuar, rematar o mantener? · Prioridad B
| | |
|---|---|
| **Quién** | Compras y Gerencia |
| **Cuándo** | Trimestral |
| **Indicadores** | Rotación y antigüedad del inventario · capital inmovilizado · margen · aporte por código común · clasificación ABC-XYZ |
| **Datos que ya existen** | ✅ movimientos con fecha y costo · ✅ ventas · ✅ código común y marca |
| **Datos que faltan** | 🟡 existencia diaria (ver D1) · ❌ fecha de última entrada por lote o producto · ❌ motivo de las bajas y mermas |
| **Costo de omitirlo** | Bajo: casi todo se deriva de los movimientos |
| **Método inicial** | Cuadrante rotación × margen con el capital inmovilizado de cada producto |
| **Acción / alerta** | Producto sin venta en N días con existencia |
| **Fase** | Fase 6 (reportes); los datos ya se capturan |

### D7 · ¿Qué proveedor y qué marca conviene? · Prioridad B
| | |
|---|---|
| **Quién** | Compras |
| **Cuándo** | Por compra y trimestral |
| **Indicadores** | Costo de reposición y su variación · cumplimiento de entrega · fallas de calidad y devoluciones por proveedor · costo en destino (flete e importación) |
| **Datos que ya existen** | ✅ proveedores y su alta · ✅ costo promedio |
| **Datos que faltan** | ❌ **cotizaciones recibidas** (precio ofrecido vs. comprado) · ❌ fecha prometida vs. fecha recibida · ❌ devoluciones a proveedor con motivo · ❌ gastos de importación por compra |
| **Costo de omitirlo** | Alto (cotizaciones: irrecuperable) |
| **Método inicial** | Comparativo de costo en destino, entrega y calidad por proveedor y marca |
| **Fase** | Fase 3 |

### D8 · ¿Cómo se despacha mejor? · Prioridad B
| | |
|---|---|
| **Quién** | Almacén y Gerencia |
| **Cuándo** | Semanal |
| **Indicadores** | Espera, picking y ciclo total · líneas por hora · cumplimiento del objetivo por prioridad · faltantes en picking · cumplimiento de la fecha de entrega · entregas con incidencia · costo de flete por entrega |
| **Datos que ya existen** | ✅ marcas de hora del picking y vista `vw_picking_tiempos` · ✅ objetivos por almacén y prioridad · ✅ faltantes con motivo |
| **Datos que faltan** | ❌ transporte: salida, llegada, entrega, incidencias y flete (Fase 2, pendiente) · ❌ ubicación física del producto en el almacén (para medir recorrido) |
| **Costo de omitirlo** | Medio: transporte se captura al construirlo |
| **Método inicial** | Tablero de tiempos vs. objetivo y lista de causas de faltante |
| **Fase** | Picking: **listo**. Transporte: Fase 2 |

### D9 · ¿Qué se devuelve y por qué? · Prioridad B
| | |
|---|---|
| **Quién** | Gerencia, Ventas y Compras |
| **Cuándo** | Mensual |
| **Indicadores** | % devuelto por producto, marca, proveedor, cliente y vendedor · motivo · monto y costo de lo devuelto |
| **Datos que ya existen** | ❌ ninguno todavía (llega con las notas de crédito) |
| **Datos que faltan** | ❌ **motivo de la devolución** en catálogo (defecto, error de despacho, error de pedido, garantía, desistió) · ❌ estado del producto devuelto (reingresa, merma, a proveedor) |
| **Costo de omitirlo** | **Irrecuperable** |
| **Método inicial** | Pareto de motivos y de productos |
| **Fase** | Fase 2 (con NC por devolución) |

### D10 · ¿Cuánto efectivo hay y qué cobertura se tiene? · Prioridad B
| | |
|---|---|
| **Quién** | Tesorería y Gerencia |
| **Cuándo** | Semanal |
| **Indicadores** | Flujo de caja proyectado (cobros esperados vs. pagos programados) · posición en divisas y en bolívares · exposición cambiaria · IGTF pagado |
| **Datos que ya existen** | ✅ tasa BCV diaria con histórico · ✅ importes en VES y USD en cada línea |
| **Datos que faltan** | ❌ CxC y CxP con vencimiento · ❌ **promesas de pago** de clientes · ❌ calendario de pagos fiscales · ❌ tasa real de las operaciones de divisas (decisión 2) |
| **Costo de omitirlo** | Alto |
| **Método inicial** | Cobros esperados por vencimiento ajustados con el comportamiento de pago de cada cliente |
| **Fase** | Fases 2 y 3 |

### D11 · ¿Cuánto cuesta y cuánto deja cada cosa? · Prioridad B
| | |
|---|---|
| **Quién** | Gerencia y Contabilidad |
| **Cuándo** | Mensual |
| **Indicadores** | Resultado por sucursal, vendedor, cliente, producto y categoría · gastos como % de la venta · rentabilidad de cada canal (mostrador vs. ruta) |
| **Datos que ya existen** | ✅ mayor con centro de costo y tercero por línea · ✅ costo de ventas por despacho |
| **Datos que faltan** | ❌ gastos con su centro de costo (Fase 3) · ❌ criterios de reparto de gastos comunes |
| **Costo de omitirlo** | Alto si los gastos no llevan centro de costo desde el día 1 |
| **Fase** | Gastos: Fase 3. Reporte: Fase 6 |

### D12 · ¿Cuánto vender y qué esperar el próximo mes? · Prioridad C
| | |
|---|---|
| **Quién** | Gerencia y Compras |
| **Cuándo** | Mensual |
| **Indicadores** | Pronóstico por producto y por código común, conciliado entre ambos niveles · estacionalidad, feriados y quincenas · efecto de promociones |
| **Datos que faltan** | Requiere **al menos 12 meses** de operación con: existencia diaria, demanda no atendida, precio de lista y cobrado, promociones, costo |
| **Método** | Fase 8: modelos validados contra meses reales, con su error publicado. Antes, promedios móviles estacionales |
| **Costo de omitirlo** | **Irrecuperable** si los datos de arriba no se capturan desde el arranque |

### D13 · ¿Dónde se pierden dinero y tiempo en los procesos? · Prioridad C
| | |
|---|---|
| **Quién** | Gerencia |
| **Cuándo** | Trimestral |
| **Indicadores** | Tiempo entre etapas (pedido → aprobación → nota → picking → salida → factura → cobro) · retrabajos y anulaciones · tiempo de aprobación por tipo y por aprobador · faltantes por causa |
| **Datos que ya existen** | ✅ marcas de hora de cada documento · ✅ decisiones de aprobación con usuario y hora · ✅ anulaciones con motivo |
| **Datos que faltan** | 🟡 catálogo de **motivos de anulación** (hoy es texto libre, difícil de contar) |
| **Costo de omitirlo** | Bajo |
| **Fase** | Reporte en Fase 6; motivos en catálogo desde la Fase 2 |

### D14 · ¿Se decide bien? (control de las decisiones) · Prioridad B
| | |
|---|---|
| **Quién** | Gerencia y Auditoría |
| **Cuándo** | Trimestral |
| **Indicadores** | % de excepciones de crédito que pagaron a tiempo · margen de los pedidos con descuento aprobado · ajustes de inventario por causa y por persona · excepciones por aprobador |
| **Datos que ya existen** | ✅ bitácora de aprobaciones con usuario, paso, comentario y hora |
| **Datos que faltan** | ❌ **resultado enlazado** a cada decisión (el pago del cliente, la venta que dejó, la merma que apareció) |
| **Costo de omitirlo** | Alto: sin resultado enlazado no hay aprendizaje |
| **Fase** | Se enlaza al construir CxC, compras y ajustes |

---

## 3. Datos nuevos a capturar (consolidado)

Orden sugerido por urgencia: primero lo irrecuperable.

**Avance (05-10-2026, migración 0019):** ya se capturan los datos **1** (existencia y costo al cierre de cada día), **2** (motivo del descuento), **4** (motivo de anulación), **6** (historial de cartera) y **12** (ventas perdidas con motivo, manuales y automáticas). Los motivos de devolución y de merma ya están en el catálogo y se usan cuando se construyan las notas de crédito y los ajustes de inventario.

| # | Dato | Decisiones | Costo de omitirlo | Dónde se captura | Fase propuesta |
|---|---|---|---|---|---|
| 1 | **Existencia diaria** (foto al cierre) por producto y almacén | D1, D6, D12 | Irrecuperable | Proceso nocturno sobre `existencia` | **2 (ya)** |
| 2 | **Motivo del descuento** en cada línea (catálogo) | D3 | Irrecuperable | Pedido | **2 (ya)** |
| 3 | **Motivo de devolución** (catálogo) y destino del producto | D9 | Irrecuperable | Nota de crédito por devolución | 2 |
| 4 | **Catálogo de motivos de anulación** (además del texto) | D13 | Bajo | Anulación de documentos | **2 (ya)** |
| 5 | **Gestiones de cobro** y promesas de pago | D4, D10 | Alto | Cobranzas | 2 |
| 6 | **Historial de cartera** (vendedor de cada cliente con fechas) | D5 | Alto | Maestro de clientes | **2 (ya)** |
| 7 | **Resultado enlazado** a cada decisión aprobada | D2, D14 | Alto | Motor de flujo + CxC | 2 y 3 |
| 8 | **Tiempo de entrega real** (pedido → recepción) por proveedor | D1, D7 | Alto | Orden de compra y recepción | 3 |
| 9 | **Cotizaciones de proveedores** (ofrecido vs. comprado) | D7 | Irrecuperable | Orden de compra | 3 |
| 10 | **Gastos con centro de costo** | D11 | Alto | Registro de gastos | 3 |
| 11 | **Promociones** y su aplicación por línea | D3, D12 | Alto | Maestro de promociones y pedido | antes de dar descuentos en producción |
| 12 | **Venta perdida con motivo** (no había, precio, competencia) | D3, D5 | Irrecuperable | Pedido y demanda no atendida | 2 |
| 13 | **Transporte**: salida, llegada, incidencia y flete | D8 | Medio | Transporte | 2 |
| 14 | Cantidad mínima y múltiplo de compra por proveedor | D1 | Bajo | Maestro de proveedores | 3 |

---

## 4. Cambios que implica en el diseño

Sin tocar el motor contable ni el orden fiscal:

1. **Foto diaria de existencia** (`existencia_diaria`): una fila por producto, almacén y día, con cantidad, reservado y costo promedio. La llena un proceso al cierre del día y es solo de inserción.
2. **Catálogos de motivo** (descuento, devolución, anulación, venta perdida, merma) con código, nombre y estado; los documentos guardan el motivo por código y, si hace falta, un texto adicional.
3. **Capa analítica sobre la operativa.** Vistas con las definiciones de `spec_reportes.md` §12; las pesadas se materializan y se refrescan en horario de poca carga. Nunca una segunda copia con lógica propia.
4. **Bitácora de decisión y resultado.** El motor de flujo ya guarda quién decidió; se agrega un vínculo al resultado posterior (pagó, vendió, se perdió).
5. **Alertas configurables** (tabla de reglas con umbral y destinatario), ejecutadas por proceso programado. Los umbrales viven en parámetros, nunca en el código.
6. **Calidad de datos visible.** Cada indicador declara cuántos días de historia exige y, si no los tiene, la pantalla lo dice.

---

## 5. Lo que no cambia
- Cálculo contable y fiscal, numeración, inmutabilidad de documentos y seguridad por rol.
- Las definiciones de los reportes de `spec_reportes.md`.
- La Fase 8 sigue siendo la de los modelos, pero **depende de que los datos de la tabla anterior se capturen desde la Fase 2**.

---

## 6. Qué debe responder Gerencia para cerrar este catálogo
1. ¿Cuáles de estas decisiones **duelen hoy**, y en qué orden? (cambia las prioridades A/B/C)
2. ¿Falta alguna decisión que se tome en la empresa y no esté aquí?
3. ¿Quién toma cada una realmente, y con qué frecuencia?
4. Umbrales: máximo de descuento por rol, margen mínimo, días de mora tolerados, cobertura deseada de inventario, tamaño de la excepción de crédito que cada nivel puede aprobar.
5. ¿Qué motivos usan hoy para descuentos, devoluciones y pérdidas de venta? (para sembrar los catálogos)
6. ¿Se tiene registro de **tiempos de entrega** de proveedores o cotizaciones guardadas del sistema anterior? Si existen, conviene conservarlos como referencia aunque no se importen (§1 de `AGENTS.md`: no hay migración de datos).
