# Registro de decisiones

Estas decisiones condicionan el diseño del ERP (§16 de la [especificación](spec_erp_hanei_motors.md)). Las toman Gerencia y el contador. Cuando se tome una, completa su fila y, si cambia una regla, actualiza la especificación en el mismo cambio.

**Estados:** ⏳ pendiente · ✅ decidida · 🔁 revisar

| # | Decisión | Recomendación | Bloquea | Estado | Decisión tomada | Fecha | Responsable |
|---|---|---|---|---|---|---|---|
| 1 | **Política contable de moneda:** ¿libros legales solo en VES con USD como moneda de reporte, o también libros auxiliares en USD? ¿Se revalúan las partidas en divisas al cierre de cada mes? | Libros legales en VES y USD como moneda de gestión en cada línea | Fase 0 | ⏳ | | | |
| 2 | **Tasa de referencia:** BCV oficial para todo registro legal. ¿Cómo se registra la tasa real de las compras y ventas de divisas? (Hoy hay dos tasas distintas para el mismo día en la operación actual) | BCV oficial para registros; tasa real solo en la operación de cambio, con diferencia a diferencial cambiario | Fase 0 | ⏳ | | | |
| 3 | **Condición fiscal de la empresa:** ¿es contribuyente especial? Define si es agente de retención de IVA y de percepción de IGTF, y el calendario de declaraciones | Confirmar con el asesor tributario | Fase 2 | ⏳ | | | |
| 4 | **Facturación:** ¿imprenta digital (qué proveedor autorizado) o máquina fiscal? ¿Se mantiene la dualidad de facturas fiscales en Bs y notas de entrega en USD, o todo pasa a factura fiscal en divisas con su equivalente en Bs? | Imprenta digital autorizada; definir la dualidad con el asesor | Fase 2 | ⏳ | | | |
| 5 | **Costo promedio:** ¿uno por producto para toda la empresa, o uno por producto y sucursal? | Uno por producto para toda la empresa | Fase 2 | ⏳ | | | |
| 6 | **Comisiones:** base cobrada o facturada, tramos por meta, porcentaje por grupo o marca, penalización por días de cobro y política de reversión | Base cobrada, con reversión por devoluciones | Fase 6 | ⏳ | | | |
| 7 | **Reexpresión por inflación (BA VEN-NIF 2):** ¿aplica en el ejercicio? | Decisión del contador | Fase 6 | ⏳ | | | |
| 8 | **Fecha de arranque** | Primer día de un mes | Fase 5 | ⏳ | | | |
| 9 | **Numeración de facturas al arrancar:** ¿continúa la secuencia actual o empieza una serie nueva? | Validar con el asesor y el proveedor de imprenta | Fase 5 | ⏳ | | | |
| 10 | **Creación del catálogo de productos** (~3.000 artículos) | Durante el conteo físico inicial | Fase 5 | ⏳ | | | |
| 11 | **Convivencia con el sistema actual:** arranque directo o doble registro temporal | Arranque directo: todo en el ERP desde el día 1 | Fase 5 | ⏳ | | | |
| 12 | **Producción o ensamblaje:** ¿órdenes simples o listas de materiales? | Órdenes simples, salvo que el negocio lo requiera | Fase 3 | ⏳ | | | |

## Historial de cambios

| Fecha | Cambio | Autor |
|---|---|---|
| 2026-09-23 | Registro creado a partir de la §16 de la especificación | — |
| 2026-09-23 | **Fase 0 asume provisionalmente las recomendaciones 1 y 2**: cada línea del mayor guarda VES (legal) y USD (gestión), y la tasa BCV es la única fuente para registros (la fuente PARALELO existe solo para gestión). El modelo no cambia si se confirman; si se decide otra cosa, se ajusta con una migración nueva antes de la Fase 2 | Desarrollo |
| 2026-09-24 | **Aprobador de asientos manuales:** se crea el rol *Jefe de contabilidad* (`jefe_contabilidad`), como indica la matriz de la §4.3. Solo ese rol aprueba, y nunca quien registró el asiento | Usuario (confirmado en desarrollo) |
| 2026-09-24 | **Alta y aprobación de clientes:** Facturación registra los clientes y Gerencia los aprueba (asigna condición de pago, límite de crédito y nivel de precio). No se crea un rol de Crédito | Usuario (confirmado en desarrollo) |
| 2026-09-24 | **Administración de vendedores:** Gerencia y Supervisor de ventas registran y modifican los vendedores | Usuario (confirmado en desarrollo) |
| 2026-09-24 | **Cambios de proveedores:** los datos de contacto los cambia Compras directamente; los datos sensibles (razón social, datos fiscales, tipo, país y concepto de ISLR) quedan pendientes hasta que Gerencia los aprueba. La condición de pago la fija Gerencia al aprobar el alta. Desarrollo agregó los datos fiscales (domiciliado, contribuyente especial, agente de retención) a la lista de sensibles porque cambian las retenciones | Usuario (confirmado en desarrollo) |
| 2026-09-24 | **Productos, precios y almacenes:** Almacén crea y modifica productos; Gerencia y Supervisor de ventas fijan precios; Gerencia crea almacenes y asigna sus usuarios | Usuario (confirmado en desarrollo) |
