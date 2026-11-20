# Auditoría técnica de NEXO

**19-11-2026 · Rama `retenciones-recibidas` · Commit `4616e66` y cambios locales de presentación de NEXO.**

La revisión cubrió controles de acceso, integridad del mayor, arranque local, selección de base de datos, privacidad de las búsquedas y reportes comerciales. Se contrastaron el código y las migraciones con las especificaciones del repositorio. Las pruebas usaron bases temporales. La revisión fiscal se limitó al comportamiento implementado y a las dependencias de arranque documentadas.

| Prioridad | Hallazgo e impacto | Corrección y criterio de aceptación |
|---|---|---|
| Alta | **Una cuenta de Ventas sin ficha de vendedor puede recibir cifras de otras carteras.** Clientes y Cobranzas pasan un identificador vacío al constructor de filtros, que en ese caso omite la restricción por vendedor. [Clientes](../src/app/(erp)/reportes/clientes/page.tsx) · [Cobranzas](../src/app/(erp)/reportes/cobranzas/page.tsx) · [Filtro SQL](../src/lib/reportes/clientes.ts) | Resolver el alcance de cartera en un único punto. Sin asignación, devolver cero filas o denegar acceso. Probar los totales y el detalle para un vendedor sin ficha, uno con cartera y un supervisor. |
| Alta | **La base no protege completamente las líneas de asientos contabilizados.** En una actualización, el control de inmutabilidad comprueba el asiento de destino. El vínculo con el asiento de origen puede cambiar y el cuadre diferido se comprueba al contabilizar. Una escritura con permisos en la base podría alterar el mayor histórico. Hallazgo de revisión estática. [Control del mayor](../db/migrations/0003_contabilidad.sql) | Impedir que cambie el asiento propietario de una línea mediante una migración nueva. Agregar una prueba que exija que un asiento contabilizado conserve sus líneas originales y sus saldos. |
| Alta | **El lanzador de Windows puede exponer el modo local de desarrollo a la red.** El lanzador inicia Next.js sin limitar la interfaz de escucha. La configuración local examinada permite un usuario de desarrollo con todos los roles. El proceso que estaba en marcha durante la revisión sí escuchaba en la interfaz local. [Lanzador](../abrir-erp.bat) · [Modo de desarrollo](../src/lib/auth/modo-desarrollo.ts) | Limitar el lanzador a la interfaz local y verificar el estado de autenticación al iniciar. Comprobar dirección de escucha e inicio de sesión después de un arranque desde el archivo por lotes. |
| Alta | **Una configuración inválida de producción puede dirigir operaciones a una base local distinta.** Si falta la URL de PostgreSQL o su formato no se reconoce, el selector abre PGlite. Un despliegue con migraciones aplicadas allí puede registrar operaciones fuera de la base prevista. [Selección de base](../src/lib/db/index.ts) | En producción, detener el arranque y las migraciones cuando falte una URL válida. Probar los tres casos de URL válida, ausente y mal formada. |
| Media | **La búsqueda de prospectos incluye el RIF en la URL.** El formulario usa GET y permite buscar por RIF. El dato puede quedar en el historial del navegador y en registros de acceso, en conflicto con el requisito de privacidad. [Prospectos](../src/app/(erp)/crm/prospectos/page.tsx) | Transportar el criterio en el cuerpo de la solicitud. Verificar que buscar y cambiar de filtro conserve la privacidad del identificador. |
| Media | **La variación de ventas de Inicio mezcla meses de distinta duración.** En una prueba aislada con fecha 31-03-2026, febrero sumó USD 100 y marzo USD 200. La función devolvió 33,33 % en lugar de 100 % porque incluyó ventas del 01-03 en el periodo anterior. [Indicador de ventas](../src/lib/reportes/inicio.ts) | Limitar el periodo de comparación al último día del mes anterior. Probar febrero, años bisiestos y meses de 30 días. |
| Media | **El menú ofrece reportes que el rol no puede abrir.** Las entradas M1 a M7 carecen de las restricciones que sí aplican sus páginas. La discrepancia explica el aviso «Sin permiso» observado con la cuenta administradora. [Menú](../src/lib/modulos.ts) | Compartir las reglas de visibilidad entre menú y páginas. Verificar la navegación con cuentas de un solo rol. |
| Media | **Interrumpir el primer arranque puede dejar la instalación sin administrador.** El lanzador decide si debe crear la cuenta por la existencia de la carpeta de datos. Esa carpeta ya existe después de migrar, incluso si el usuario cerró la ventana antes de completar el alta. [Primer arranque](../abrir-erp.bat) | Consultar si existe un administrador activo. Verificar que un segundo arranque pueda continuar el alta interrumpida. |

## Verificaciones ejecutadas

- **718 pruebas aprobadas en dos ejecuciones.** En la primera pasaron 714 pruebas de 68 archivos. Las cuatro pruebas de concurrencia quedaron pendientes porque el entorno restringido de Windows impidió iniciar PostgreSQL temporal. Ejecutado por separado con el servicio local, ese archivo aprobó los cuatro casos, incluidos la numeración de asientos y facturas bajo concurrencia y el control de huecos después de transacciones fallidas.
- Las pruebas incluyeron los cuadres de auxiliares contra el mayor, el cierre mensual y el recorrido de la empresa ficticia de demostración. La revisión de tipos pasó. ESLint terminó con cero errores y una advertencia por una variable sin usar en la prueba de reportes de vendedores.
- El caso de fin de mes se verificó por separado ejecutando la función del tablero con una fecha controlada y datos temporales. Los hallazgos de permisos e inmutabilidad proceden de revisión del código y de las migraciones.
- La compilación de producción pasó con acceso a Google Fonts. La compilación en el entorno con la red restringida falló al descargar Geist y Geist Mono. Esta dependencia importa para preparar un instalador sin conexión.

## Correcciones del 19-11-2026

| Área | Cambio aplicado |
|---|---|
| Cartera | Los reportes comerciales resuelven el vendedor desde la sesión. Si una cuenta de Ventas carece de ficha, se deniega la consulta antes de calcular el reporte. |
| Mayor | La migración 0061 impide cambiar el asiento propietario de una línea. La prueba compara las líneas y sus importes en ambas monedas antes y después de la operación rechazada. |
| Arranque local | El lanzador exige autenticación y escucha en 127.0.0.1. Para reutilizar una instancia verifica la dirección de escucha y la redirección a la pantalla de ingreso. |
| Base de producción | El servidor y el migrador exigen una URL de PostgreSQL válida. Los comandos de preparación cargan la misma configuración de entorno que Next.js. |
| Privacidad del CRM | La búsqueda envía el RIF, el nombre y el estado en el cuerpo de un POST. Los formularios compartidos también usan una acción de servidor para el envío antes de que se cargue JavaScript. |
| Ventas del mes | El cálculo usa aritmética decimal en PostgreSQL y recorta el periodo anterior al día equivalente de ese mes. Las pruebas cubren febrero de 28 y 29 días y meses de 30 y 31 días. |
| Navegación | Los siete reportes del menú BI y los accesos rápidos de Inicio consultan los permisos que exigen las páginas de destino. Se verificaron los doce roles por separado. |
| Administrador inicial | El lanzador comprueba si existe una cuenta administradora activa que pueda iniciar sesión. Si se interrumpió la preparación después de migrar, retoma el alta en el siguiente arranque. |

La suite aprobó 738 pruebas en 70 archivos, incluidas las de concurrencia con PostgreSQL. La compilación de producción y la revisión de tipos pasaron. ESLint terminó sin advertencias ni errores.

En una instancia temporal con PostgreSQL se ejecutaron dos migraciones consecutivas antes del alta inicial y se comprobó que otro arranque reconociera al administrador. Una sesión autenticada buscó dos prospectos ficticios mediante el formulario de la aplicación. Al alternar entre activos y descartados, los resultados cambiaron y la URL permaneció en `/crm/prospectos`.

La migración 0061 se aplicó a la base local durante el reinicio autorizado. Tras el arranque desde Windows, el servidor escuchó en 127.0.0.1:3100. Sin sesión, Inicio redirigió a `/login`, el formulario de ingreso respondió con HTTP 200 y la API protegida devolvió HTTP 401.

## Pendientes de salida a producción

La emisión con número de control real depende de integrar y probar el proveedor de imprenta. El respaldo automático y su restauración siguen pendientes en la hoja de ruta. El cierre de estos puntos requiere una factura validada en el entorno del proveedor y una restauración comprobada de la base y los adjuntos. [Imprenta](../src/lib/fiscal/imprenta.ts) · [Especificación de arranque](spec_erp_hanei_motors.md) · [Pendientes del proyecto](../README.md)

## Dónde probar los flujos

En esta instalación, la cuenta de pruebas con los 12 roles pertenece a la base local del ERP. Un documento que emita allí consume la numeración y afecta los mismos auxiliares y el mismo mayor que las operaciones de los demás usuarios de esa instancia. Para ensayar ventas, cobros, pagos y cierres con datos ficticios, el proyecto dispone de una empresa de demostración en una base separada. [Configuración de la empresa de demostración](../README.md#empresa-ficticia-de-demostración)
