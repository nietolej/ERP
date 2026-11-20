# Operaciones ejecutadas en el ERP · 20-11-2026

Una operación representativa por cada una de las 87 actividades. Los casos ejercitaron funciones del ERP, consultas y, en la preparación de algunos escenarios, escrituras directas de configuración. Se usaron bases temporales de prueba y una empresa de demostración persistente en `.data/demo-actividades-20261120`. La prueba se realizó por código.

## Acceso e inicio

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Acceso | Autenticar un usuario de prueba con correo y contraseña. | [autenticacion](../tests/autenticacion.test.ts) |
| Inicio | Consultar las ventas del mes del tablero. | [inicio](../tests/inicio.test.ts) |
| Aprobaciones | Delegar una aprobación en un sustituto vigente. | [flujo](../tests/flujo.test.ts) |
| Adjuntos | Guardar un soporte y comprobar su huella. | [adjuntos](../tests/adjuntos.test.ts) |
| Auditoría | Consultar los movimientos ordenados por fecha. | [auditoria](../tests/auditoria.test.ts) |

## Maestros y metas

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Clientes | Registrar un cliente pendiente. | [clientes](../tests/clientes.test.ts) |
| Vendedores | Dar de alta un vendedor con código correlativo. | [vendedores](../tests/vendedores.test.ts) |
| Proveedores | Registrar un proveedor pendiente. | [proveedores](../tests/proveedores.test.ts) |
| Productos | Crear un artículo con código único. | [productos](../tests/productos.test.ts) |
| Catálogos de productos | Crear una categoría de productos. | [productos](../tests/productos.test.ts) |
| Carga masiva de productos | Validar e importar un lote de productos. | [carga-productos](../tests/carga-productos.test.ts) |
| Almacenes | Crear el almacén de la empresa de demostración. | [siembra-demo](../tests/siembra-demo.test.ts) |
| Bancos | Registrar un banco. | [bancos](../tests/bancos.test.ts) |
| Transportistas | Registrar un transportista de flota propia. | [transportes](../tests/transportes.test.ts) |
| Metas de venta | Cargar un lote de metas. | [metas](../tests/metas.test.ts) |

## CRM y postventa

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Prospectos y contactos | Registrar un prospecto asignado a un vendedor. | [crm](../tests/crm.test.ts) |
| Actividades CRM | Registrar una actividad de seguimiento. | [crm](../tests/crm.test.ts) |
| Cotizaciones | Emitir una cotización con vigencia. | [crm](../tests/crm.test.ts) |
| Oportunidades | Avanzar una oportunidad de etapa. | [crm](../tests/crm.test.ts) |
| Casos de postventa | Abrir un caso por devolución. | [crm](../tests/crm.test.ts) |

## Ventas y facturación

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Pedidos | Emitir un pedido y asignarle correlativo. | [pedidos](../tests/pedidos.test.ts) |
| Crédito | Resolver un pedido retenido por crédito. | [pedidos](../tests/pedidos.test.ts) |
| Notas de entrega | Generar la nota sobre las unidades reservadas. | [pedidos](../tests/pedidos.test.ts) |
| Facturas de venta | Facturar una nota despachada con control simulado. | [facturas](../tests/facturas.test.ts) |
| Notas de crédito y débito | Emitir una nota de crédito por devolución parcial. | [notas](../tests/notas.test.ts) |
| Pronto pago en ventas | Proponer una nota de crédito por pronto pago. | [notas](../tests/notas.test.ts) |
| Ventas perdidas | Registrar una venta perdida con motivo. | [datos-decision](../tests/datos-decision.test.ts) |
| Promociones | Crear una promoción en borrador. | [promociones](../tests/promociones.test.ts) |

## Almacén y transporte

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Preparación de pedidos | Procesar una orden de picking de una nota de entrega. | [despacho](../tests/despacho.test.ts) |
| Empaque y salida | Confirmar la salida y verificar el costo de ventas. | [despacho](../tests/despacho.test.ts) |
| Planificación del transporte | Crear un transporte con número correlativo. | [transportes](../tests/transportes.test.ts) |
| Ejecución del transporte | Registrar la entrega en una parada. | [transportes](../tests/transportes.test.ts) |

## Inventario y producción

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Existencias y movimientos | Consultar existencias históricas por producto. | [datos-decision](../tests/datos-decision.test.ts) |
| Ajustes de inventario | Enviar un ajuste con faltante y sobrante. | [ajustes](../tests/ajustes.test.ts) |
| Conteo físico de apertura | Registrar un conteo por almacén. | [apertura-inventario](../tests/apertura-inventario.test.ts) |
| Producción o ensamblaje | Crear una orden con componentes. | [produccion](../tests/produccion.test.ts) |
| Reposición | Generar una orden desde el sugerido de compra. | [reportes-inventario](../tests/reportes-inventario.test.ts) |

## Compras y cuentas por pagar

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Órdenes de compra | Crear una orden y enviarla a aprobación. | [compras](../tests/compras.test.ts) |
| Recepción de mercancía | Recibir mercancía contra una orden aprobada. | [compras](../tests/compras.test.ts) |
| Facturas de compra | Registrar la factura contra la recepción. | [facturas-compra](../tests/facturas-compra.test.ts) |
| Gastos de importación | Registrar y distribuir un gasto entre los productos recibidos. | [gastos-importacion](../tests/gastos-importacion.test.ts) |
| Notas del proveedor | Registrar una nota de crédito por devolución. | [notas-proveedor](../tests/notas-proveedor.test.ts) |
| Cuentas por pagar | Consultar la partida de un gasto disponible para pago. | [gastos-caja](../tests/gastos-caja.test.ts) |
| Pagos a proveedores | Solicitar un pago. | [pagos-proveedores](../tests/pagos-proveedores.test.ts) |

## Cobranzas, tesorería y gastos

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Cuentas por cobrar | Consultar el saldo abierto de una factura. | [cobros](../tests/cobros.test.ts) |
| Cobros | Registrar un cobro parcial. | [cobros](../tests/cobros.test.ts) |
| Retenciones recibidas | Registrar una retención de IVA de un cliente. | [retenciones-recibidas](../tests/retenciones-recibidas.test.ts) |
| Cuentas de tesorería | Crear una cuenta con su subcuenta contable. | [cobros](../tests/cobros.test.ts) |
| Conciliación bancaria | Cargar un extracto de cuenta. | [conciliacion-bancaria](../tests/conciliacion-bancaria.test.ts) |
| Gastos de proveedor | Registrar una factura de gasto pendiente de aprobación. | [gastos-caja](../tests/gastos-caja.test.ts) |
| Categorías de gasto | Crear una categoría de gasto. | [gastos-caja](../tests/gastos-caja.test.ts) |
| Fondos de caja chica | Crear un fondo con custodio. | [gastos-caja](../tests/gastos-caja.test.ts) |
| Vales de caja chica | Registrar un vale con soporte. | [gastos-caja](../tests/gastos-caja.test.ts) |

## Fiscal

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Libro de ventas | Consultar los documentos del período. | [libros-fiscales](../tests/libros-fiscales.test.ts) |
| Libro de compras | Consultar compras y notas del proveedor. | [libros-fiscales](../tests/libros-fiscales.test.ts) |
| Comprobantes de retención | Emitir el lote de comprobantes del mes. | [comprobantes-retencion](../tests/comprobantes-retencion.test.ts) |
| Declaraciones | Generar la declaración mensual de IVA. | [declaraciones-fiscales](../tests/declaraciones-fiscales.test.ts) |
| IGTF | Consultar el reporte del impuesto percibido y pagado. | [igtf-percibido](../tests/igtf-percibido.test.ts) |

## Contabilidad, activos y comisiones

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Plan de cuentas y períodos | Crear los períodos de la demo. | [siembra-demo](../tests/siembra-demo.test.ts) |
| Asientos | Guardar un asiento manual en borrador. | [asientos-manuales](../tests/asientos-manuales.test.ts) |
| Libros y balance | Consultar los libros contables. | [libros-contables](../tests/libros-contables.test.ts) |
| Estados financieros | Obtener el estado de situación financiera. | [estados-financieros](../tests/estados-financieros.test.ts) |
| Rentabilidad | Consultar el margen por cliente. | [rentabilidad](../tests/rentabilidad.test.ts) |
| Revaluación de divisas | Proponer la revaluación mensual. | [revaluacion](../tests/revaluacion.test.ts) |
| Cierre mensual | Cerrar un mes con sus comprobaciones. | [siembra-demo](../tests/siembra-demo.test.ts) |
| Activos fijos | Procesar la depreciación mensual. | [activos-fijos](../tests/activos-fijos.test.ts) |
| Planes de comisión | Crear un plan con reglas. | [comisiones](../tests/comisiones.test.ts) |
| Liquidaciones de comisión | Generar la liquidación de un vendedor. | [comisiones](../tests/comisiones.test.ts) |

## Configuración y arranque

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| Empresa y sucursales | Dar de alta la empresa y la sucursal ficticias. | [siembra-demo](../tests/siembra-demo.test.ts) |
| Usuarios y roles | Crear usuarios de demostración por rol. | [siembra-demo](../tests/siembra-demo.test.ts) |
| Tasas de cambio | Cargar tasas de cambio para los días simulados. | [siembra-demo](../tests/siembra-demo.test.ts) |
| Parámetros fiscales | Leer el porcentaje vigente de una alícuota. | [productos](../tests/productos.test.ts) |
| Conceptos y tarifas de ISLR | Registrar un concepto y su tarifa para el ensayo. | [retenciones-compra](../tests/retenciones-compra.test.ts) |
| Parámetros de reportes | Consultar los parámetros del módulo. | [parametros-reportes](../tests/parametros-reportes.test.ts) |
| Configuración de pronto pago | Guardar una condición de descuento de prueba. | [notas](../tests/notas.test.ts) |
| Flujos de aprobación | Cambiar la definición de un flujo. | [flujo](../tests/flujo.test.ts) |
| Catálogo de motivos | Crear un motivo de descuento. | [datos-decision](../tests/datos-decision.test.ts) |
| Saldos de apertura | Fijar la fecha de arranque. | [apertura](../tests/apertura.test.ts) |
| Checklist de arranque | Registrar una confirmación con responsable. | [checklist-arranque](../tests/checklist-arranque.test.ts) |

## Reportes y análisis

| Actividad | Operación ejecutada | Evidencia |
|---|---|---|
| M1 · Clientes | Consultar el detalle de ventas y deuda de un cliente. | [reportes-clientes](../tests/reportes-clientes.test.ts) |
| M2 · Productos | Consultar el catálogo con precios y existencias. | [reportes-productos](../tests/reportes-productos.test.ts) |
| M3 · Vendedores | Consultar la cobertura de cartera de los vendedores. | [reportes-vendedores](../tests/reportes-vendedores.test.ts) |
| M4 · Cobranzas | Consultar la velocidad de cobro por tramos. | [reportes-cobranzas](../tests/reportes-cobranzas.test.ts) |
| M5 · Devoluciones | Consultar la tendencia mensual de devoluciones. | [reportes-devoluciones](../tests/reportes-devoluciones.test.ts) |
| M6 · Inventario | Consultar el capital inmovilizado al costo promedio. | [reportes-inventario](../tests/reportes-inventario.test.ts) |
| M7 · Análisis avanzado | Consultar el histograma de pedidos. | [reportes-analisis](../tests/reportes-analisis.test.ts) |
| Exportación | Generar el contenido de un archivo CSV. | [csv](../tests/csv.test.ts) |

La demo dejó 50 facturas de venta, 15 cobros y un mes cerrado. El mayor cerró con 183 asientos y 467 líneas. Diferencia de cuadre: VES 0,00 y USD 0,00.
