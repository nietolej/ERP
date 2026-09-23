# ERP Distribuciones Hanei Motors

Sistema administrativo integral de Distribuciones Hanei Motors: datos maestros, ventas, compras, inventario, comisiones, gastos, tesorería, contabilidad, módulo fiscal venezolano y estados financieros.

> **Proyecto independiente.** Este ERP no comparte código, base de datos, usuarios ni procesos con el dashboard de ventas, con su base PostgreSQL/Supabase, con el sistema DBF ni con los archivos `.txt` exportados. La base de datos nace vacía y se llena con la operación diaria desde la fecha de arranque.

## Estado

| Fase | Estado |
|---|---|
| Especificación funcional y técnica | ✅ Lista para revisión |
| Decisiones abiertas ([docs/decisiones.md](docs/decisiones.md)) | ⏳ Pendientes: las toman Gerencia y el contador (la Fase 0 asumió provisionalmente las recomendaciones 1 y 2) |
| **Fase 0: Fundaciones** | 🟡 En curso: núcleo terminado y probado; pendientes abajo |
| Fase 1: Maestros | ⬜ No iniciada |

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
  - un documento no genera dos asientos.
- **Motor de contabilización** ([src/lib/contabilidad/motor.ts](src/lib/contabilidad/motor.ts)):
  - convierte a VES y USD con la tasa del día y decimales exactos;
  - agrega una línea de redondeo si la conversión deja centavos de diferencia;
  - es idempotente.
- **Seguridad**:
  - inicio de sesión con claves scrypt y sesiones guardadas en la base (la cookie lleva un token cuyo hash se guarda);
  - `proxy.ts` en todas las rutas y verificación real en la capa de acceso a datos;
  - roles sin superusuario implícito;
  - cambio obligatorio de la clave temporal.
- **Pantallas**:
  - inicio de sesión y cambio de clave;
  - Inicio con el estado real de la configuración del día 0 y el control de cuadre del mayor;
  - empresa y sucursales, tasas de cambio, parámetros fiscales (validación del contador y nuevas vigencias) y usuarios y roles;
  - periodos contables, plan de cuentas y balance de comprobación en VES y USD;
  - menú de reportes igual al del dashboard: los módulos indican en qué fase se habilitan y no muestran cifras de ejemplo.
- **Calidad:** 33 pruebas automatizadas, tipos, lint y compilación de producción sin errores. CI en [.github/workflows/ci.yml](.github/workflows/ci.yml).

### Fase 0: qué falta

- **Carga automática diaria de la tasa BCV.** Por ahora la tasa se registra a mano; falta definir la fuente de consulta (decisión 2).
- **Prueba de concurrencia de numeración contra PostgreSQL real.** PGlite es de una sola conexión: la numeración sin huecos está probada con transacciones que se revierten; la prueba de dos transacciones simultáneas necesita un servidor PostgreSQL.
- **Límite de intentos de inicio de sesión** (protección contra fuerza bruta).
- **Pantalla de asientos manuales con aprobación** (§3.1). El mayor y sus reglas ya existen en la base.

## Uso

Requiere Node.js 24.

```bash
npm install
npm run db:migrar
npm run db:crear-admin -- --email admin@empresa.com --nombre "Nombre Apellido"
npm run dev
```

- Sin `DATABASE_URL`, el sistema usa **PGlite**, un PostgreSQL embebido que guarda los datos en `./.data/erp`. No hace falta instalar un servidor de base de datos para desarrollar.
- En producción se define `DATABASE_URL=postgres://…` (ver [.env.example](.env.example)). Las mismas migraciones crean la base.
- `db:crear-admin` muestra una clave temporal **una sola vez**. El administrador debe cambiarla al entrar y crear los demás usuarios desde *Configuración → Usuarios y roles*.

| Comando | Qué hace |
|---|---|
| `npm test` | Pruebas automatizadas (cada archivo usa una base PGlite nueva en memoria) |
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
│       ├── contabilidad/ motor de contabilización
│       └── db/           conexión (PGlite / PostgreSQL) y migraciones
├── tests/                pruebas automatizadas
└── docs/                 especificaciones y decisiones
```

## Próximos pasos

1. **Tomar las decisiones abiertas** de [docs/decisiones.md](docs/decisiones.md), empezando por la 1 y la 2, que la Fase 0 asumió de forma provisional.
2. **Validar con el contador** el plan de cuentas y los parámetros fiscales cargados como referencia.
3. **Crear el repositorio remoto** (GitHub u otro), separado del repositorio del dashboard, para que corra la integración continua.
4. **Cerrar los pendientes de la Fase 0** e iniciar la **Fase 1: Maestros**.
