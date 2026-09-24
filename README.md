# ERP Distribuciones Hanei Motors

Sistema administrativo integral de Distribuciones Hanei Motors: datos maestros, ventas, compras, inventario, comisiones, gastos, tesorería, contabilidad, módulo fiscal venezolano y estados financieros.

> **Proyecto independiente.** Este ERP no comparte código, base de datos, usuarios ni procesos con el dashboard de ventas, con su base PostgreSQL/Supabase, con el sistema DBF ni con los archivos `.txt` exportados. La base de datos nace vacía y se llena con la operación diaria desde la fecha de arranque.

## Estado

| Fase | Estado |
|---|---|
| Especificación funcional y técnica | ✅ Lista para revisión |
| Decisiones abiertas ([docs/decisiones.md](docs/decisiones.md)) | ⏳ Pendientes: las toman Gerencia y el contador (la Fase 0 asumió provisionalmente las recomendaciones 1 y 2) |
| **Fase 0: Fundaciones** | 🟡 Casi lista: solo falta la carga automática de la tasa BCV, que espera la decisión 2 |
| Fase 1: Maestros | 🟡 En curso: terceros, clientes, vendedores, proveedores, productos y almacenes listos; siguen bancos, metas y adjuntos |

### Fase 0: qué está hecho

- **Base de datos** creada solo con migraciones versionadas ([db/migrations](db/migrations)):
  - usuarios, roles, sesiones y auditoría inmutable;
  - empresa, sucursales, monedas, tasas de cambio, parámetros fiscales con vigencia y numeradores sin huecos;
  - plan de cuentas base, periodos contables, asientos y motor de reglas contables.
- **Integridad garantizada por la base**:
  - un asiento que no cuadra en VES o en USD se rechaza;
  - lo contabilizado es inmutable y se corrige con un reverso;
  - un periodo cerrado solo admite reversos, y uno bloqueado no admite nada ni se reabre;
  - las cuentas controladas por un auxiliar no aceptan asientos manuales;
  - un documento no genera dos asientos;
  - un asiento manual se contabiliza solo con la aprobación de un Jefe de contabilidad activo, que no puede ser quien lo registró.
- **Motor de contabilización** ([src/lib/contabilidad/motor.ts](src/lib/contabilidad/motor.ts)):
  - convierte a VES y USD con la tasa del día y decimales exactos;
  - agrega una línea de redondeo si la conversión deja centavos de diferencia;
  - es idempotente.
- **Seguridad**:
  - inicio de sesión con claves scrypt y sesiones guardadas en la base (la cookie lleva un token cuyo hash se guarda);
  - `proxy.ts` en todas las rutas y verificación real en la capa de acceso a datos;
  - roles sin superusuario implícito;
  - cambio obligatorio de la clave temporal;
  - límite de intentos fallidos por correo y por IP, con el bloqueo registrado en la auditoría. Para que el límite por IP funcione, en producción el servidor debe estar detrás de un proxy inverso que fije `X-Forwarded-For`.
- **Pantallas**:
  - inicio de sesión y cambio de clave;
  - Inicio con el estado real de la configuración del día 0 y el control de cuadre del mayor;
  - empresa y sucursales, tasas de cambio, parámetros fiscales (validación del contador y nuevas vigencias) y usuarios y roles;
  - periodos contables, plan de cuentas y balance de comprobación en VES y USD;
  - asientos contables (libro diario) y asientos manuales: Contabilidad registra el borrador y el Jefe de contabilidad lo aprueba y contabiliza. Quien registra no aprueba, y la base de datos lo impide;
  - menú de reportes igual al del dashboard: los módulos indican en qué fase se habilitan y no muestran cifras de ejemplo.
- **Concurrencia de numeración probada contra PostgreSQL 17 real** ([tests/concurrencia.test.ts](tests/concurrencia.test.ts)): 20 transacciones simultáneas reciben números distintos y sin huecos, también cuando algunas fallan. La prueba falla si se quita el bloqueo de fila.
- **Calidad:** 86 pruebas automatizadas, tipos, lint y compilación de producción sin errores. CI en [.github/workflows/ci.yml](.github/workflows/ci.yml).

### Fase 0: qué falta

- **Carga automática diaria de la tasa BCV.** Por ahora la tasa se registra a mano; falta definir la fuente de consulta (decisión 2).

### Fase 1: qué está hecho

- **Terceros:** un RIF es una sola persona. La base valida el formato y el dígito verificador del SENIAT; también se aplica al RIF de la empresa.
- **Clientes:** Facturación los registra con código automático (C00001…) y quedan pendientes hasta que Gerencia les asigna condición de pago, límite de crédito y nivel de precio. Aviso y confirmación ante nombres parecidos a otro tercero. Un cliente no se borra: se inactiva o se bloquea.
- **Seguridad por fila:** quien solo tiene el rol Ventas ve únicamente los clientes de su vendedor. La búsqueda viaja por acción de servidor para no poner RIF ni nombres en la URL.
- **Vendedores:** Gerencia y Supervisor de ventas los administran. Código automático (V001…), tipo explícito (interno, externo, administrativo o casa) para excluir de rankings y comisiones sin listas de códigos, RIF obligatorio para el externo y enlace a un usuario de Ventas para su cartera.
- **Proveedores:** Compras los registra y Gerencia (otra persona) los aprueba y asigna la condición de pago. Los datos de contacto se cambian directo; los sensibles (razón social, datos fiscales, tipo, país, concepto de ISLR) con una solicitud que aprueba Gerencia. La base impide saltarse ese control, también desde clientes.
- **Conceptos de ISLR:** catálogo que registra Contabilidad (sin tarifas precargadas).
- **Productos:** Almacén los administra (código fijo en mayúsculas, grupos, marcas y referencias cruzadas con búsqueda sin guiones). La alícuota de IVA es una categoría cuyo porcentaje sale de los parámetros fiscales por fecha.
- **Precios:** listas A, B y D en USD que fijan Gerencia y Supervisor de ventas, con vigencia e historial; no se editan ni se borran.
- **Almacenes:** Gerencia los crea y asigna sus usuarios; quien solo tiene el rol Almacén ve únicamente los suyos.
- **Condiciones de pago** base (contado, 15, 30 y 45 días). El descuento por pronto pago lo configura Gerencia.

## Uso

Requiere Node.js 24.

**En Windows, lo más simple:** doble clic en [abrir-erp.bat](abrir-erp.bat). Instala lo que falte, prepara la base, pide los datos del administrador la primera vez y abre el ERP en http://localhost:3100. Cerrar su ventana detiene el ERP.

A mano:

```bash
npm install
npm run db:migrar
npm run db:crear-admin -- --email admin@empresa.com --nombre "Nombre Apellido"
npm run dev
```

- Sin `DATABASE_URL`, el sistema usa **PGlite**, un PostgreSQL embebido que guarda los datos en `./.data/erp`. No hace falta instalar un servidor de base de datos para desarrollar.
- En producción se define `DATABASE_URL=postgres://…` (ver [.env.example](.env.example)). Las mismas migraciones crean la base, que debe estar en **UTF-8** (`create database erp encoding 'UTF8' template template0;`): las migraciones se detienen si no lo está.
- `db:crear-admin` muestra una clave temporal **una sola vez**. El administrador debe cambiarla al entrar y crear los demás usuarios desde *Configuración → Usuarios y roles*.

| Comando | Qué hace |
|---|---|
| `npm test` | Pruebas automatizadas (cada archivo usa una base PGlite nueva en memoria). La de concurrencia usa PostgreSQL real: el servidor de `TEST_DATABASE_URL` si está definida (en un esquema temporal que borra al terminar) o, si no, uno temporal que arranca y borra solo (`embedded-postgres`) |
| `npm run typecheck` · `npm run lint` | Tipos y estilo |
| `npm run build` | Compilación de producción |
| `npm run db:migrar` | Aplica las migraciones pendientes. No permite editar una migración ya aplicada |

## Documentos

| Documento | Para qué sirve |
|---|---|
| [docs/spec_erp_hanei_motors.md](docs/spec_erp_hanei_motors.md) | **Fuente de verdad.** Módulos, modelo de datos, reglas contables y fiscales, hoja de ruta y arranque |
| [docs/spec_reportes.md](docs/spec_reportes.md) | Reportes e indicadores: réplica pantalla por pantalla del dashboard de ventas (M1 a M6, Inicio y Metas), con fórmulas corregidas y calculadas con los datos del ERP |
| [docs/decisiones.md](docs/decisiones.md) | Registro de las decisiones de negocio que condicionan el diseño |
| [AGENTS.md](AGENTS.md) | Reglas obligatorias para quien desarrolle, sea una persona o un agente de IA |

## Estructura

```
ERP/
├── db/migrations/        esquema de la base (solo migraciones versionadas)
├── scripts/              migrar y crear el primer administrador
├── src/
│   ├── proxy.ts          protección de todas las rutas
│   ├── app/              pantallas (Next.js App Router)
│   ├── components/       componentes visuales
│   └── lib/
│       ├── auth/         claves, sesiones, roles y capa de acceso a datos
│       ├── contabilidad/ motor de contabilización y asientos manuales
│       ├── maestros/     RIF, terceros, clientes, vendedores, proveedores, productos y almacenes
│       └── db/           conexión (PGlite / PostgreSQL) y migraciones
├── tests/                pruebas automatizadas
└── docs/                 especificaciones y decisiones
```

## Próximos pasos

1. **Tomar las decisiones abiertas** de [docs/decisiones.md](docs/decisiones.md), empezando por la 1 y la 2, que la Fase 0 asumió de forma provisional.
2. **Validar con el contador** el plan de cuentas y los parámetros fiscales cargados como referencia.
3. **Crear el repositorio remoto** (GitHub u otro), separado del repositorio del dashboard, para que corra la integración continua.
4. **Cerrar los pendientes de la Fase 0** e iniciar la **Fase 1: Maestros**.
