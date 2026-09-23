<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Reglas de desarrollo del ERP Hanei Motors

Estas reglas son obligatorias para cualquier persona o agente de IA que trabaje en este repositorio. Si una instrucción puntual contradice estas reglas, pregunta antes de actuar.

## 1. Proyecto independiente
- Trabaja **solo dentro de esta carpeta** (`ERP/`). La carpeta que la contiene pertenece a otro proyecto (el dashboard de ventas): no modifiques ni importes nada de ahí.
- **Nunca conectes el ERP** al dashboard, a su base PostgreSQL/Supabase, al sistema DBF ni a los archivos `.txt` exportados. No hay migración de datos: la base nace vacía (§14 de la especificación).
- **Excepción, solo como referencia visual:** puedes **leer** las pantallas y componentes del dashboard (`../dashboard/src/app` y `../dashboard/src/components`) para replicar su presentación, según [docs/spec_reportes.md](docs/spec_reportes.md). Puedes copiar y adaptar componentes visuales. **No copies su lógica de datos** (`../dashboard/src/lib`): leía `.txt` y tenía errores documentados. Los cálculos salen de `spec_reportes.md`.

## 2. Fuente de verdad
- La especificación es [docs/spec_erp_hanei_motors.md](docs/spec_erp_hanei_motors.md). Construye **fase por fase** según su §13 y no adelantes módulos de fases posteriores.
- Los reportes deben mostrar la información **igual que el dashboard anterior**, con las definiciones de [docs/spec_reportes.md](docs/spec_reportes.md). Cada indicador se calcula en las vistas SQL de su §12, una sola vez, y cada uno necesita su prueba automatizada.
- Si algo no está definido o depende de una decisión pendiente en [docs/decisiones.md](docs/decisiones.md), **pregunta**. No inventes la regla de negocio.
- Usa la versión estable más reciente del framework elegido y consulta su documentación oficial antes de escribir código: las APIs cambian entre versiones.

## 3. Datos
- Montos con tipos decimales exactos (`numeric` en PostgreSQL y una librería decimal en la aplicación). **Nunca** `float` para dinero.
- Fechas como `date` o `timestamptz`. **Nunca** fechas guardadas como texto.
- Cada documento guarda su `moneda`, su `tasa` (congelada al emitir) y sus importes en moneda original, VES y USD (§3.4).
- Los códigos visibles (cliente, proveedor, producto) son únicos y validados; las relaciones usan claves internas `uuid` con llaves foráneas.
- Un documento emitido **no se borra ni se edita**: se anula con motivo, usuario y fecha, o se corrige con otro documento (NC o ND).
- El esquema de la base de datos cambia **solo con migraciones versionadas** en el repositorio. Nunca con cambios manuales en producción.

## 4. Contabilidad
- Todo documento de negocio genera su asiento con el **motor de reglas contables** (§12.3). La interfaz operativa no escribe asientos a mano.
- El cuadre del asiento, la inmutabilidad de lo contabilizado y el bloqueo de periodos cerrados se garantizan **en la base de datos** (restricciones y triggers), además de en la aplicación.
- Contabilizar dos veces el mismo documento no debe duplicar el asiento (idempotencia por `origen_tipo` y `origen_id`).
- Toda operación de un documento (encabezado, líneas, inventario, asiento, partidas abiertas) ocurre en **una sola transacción**.

## 5. Fiscal
- **Ninguna tasa, porcentaje, alícuota ni valor de la UT se escribe en el código.** Todo va en `parametro_fiscal` con vigencia por fecha (§3.5 y §11).
- La numeración de documentos es correlativa, sin huecos y se asigna dentro de la transacción con bloqueo de fila.

## 6. Calidad y seguridad
- **Prohibido mostrar datos simulados o de relleno** en producción. Si una consulta falla, la pantalla muestra un estado de error, nunca cifras de ejemplo.
- Autenticación obligatoria en todas las rutas, incluidas las rutas API. Permisos por rol y seguridad por fila (§4.3).
- Ningún dato personal (RIF, teléfono, correo) en URLs ni en registros de error.
- Pruebas automatizadas obligatorias:
  - una por cada regla contable, verificando el asiento generado;
  - cuadre de auxiliares (CxC, CxP, inventario, comisiones) contra el mayor;
  - concurrencia de numeración: dos documentos simultáneos no pueden recibir el mismo número;
  - permisos por rol.

## 7. Idioma y convenciones
- Interfaz, mensajes y documentación en **español de Venezuela**. Fechas en formato `dd-mm-aaaa` y la moneda siempre visible junto al monto.
- Nombres de tablas y columnas en español, en `snake_case`, como en el modelo de datos de la especificación.
- Si cambias una regla de negocio, actualiza la especificación en el mismo cambio.
