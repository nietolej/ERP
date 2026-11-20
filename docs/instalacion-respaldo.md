# Instalación de ensayo y respaldo del ERP

## Instalar desde cero en Windows

Extraiga el ZIP en una carpeta nueva. Requiere Node.js 22 LTS o posterior compatible con Next.js, npm, acceso al registro npm y a Google Fonts durante la compilación, y una base PostgreSQL UTF-8 vacía y exclusiva del ERP. Para los respaldos, instale las herramientas de cliente de PostgreSQL de la misma versión mayor del servidor y agregue su carpeta bin al PATH.

Copie .env.example como .env.local en la raíz. Configure DATABASE_URL para la base nueva con una cuenta que pueda aplicar migraciones y ADJUNTOS_DIR con una ruta absoluta de acceso restringido. Desde la raíz, ejecute en PowerShell:

```powershell
.\scripts\instalar.ps1
npm.cmd start
```

El instalador pide los datos del primer administrador. Guarde su clave temporal y cámbiela al ingresar. La instalación carga el esquema y los catálogos de las migraciones. La salida a producción requiere además el checklist operativo y la validación fiscal.

## Respaldar cada día

Configure un servicio libpq llamado erp en pg_service.conf para la misma base de DATABASE_URL. Use PGSERVICEFILE y PGPASSFILE con rutas accesibles a la cuenta de la tarea en Windows. El servicio debe identificar host, port, dbname y user. Proporcione la contraseña mediante el archivo pgpass con permisos restringidos. La cuenta PostgreSQL debe poder leer todas las tablas del ERP para obtener un respaldo completo.

Ejecute un respaldo manual y después programe el diario. Sustituya las rutas por las de la instalación. Use un volumen de respaldo separado, protegido mediante cifrado y permisos de acceso. La programación solicita las credenciales de la cuenta Windows que ejecutará la tarea incluso con la sesión cerrada.

```powershell
.\scripts\respaldo.ps1 Respaldar erp E:\Respaldos\ERP D:\ERP\adjuntos
.\scripts\programar-respaldo.ps1 -Servicio erp -Carpeta E:\Respaldos\ERP -Adjuntos D:\ERP\adjuntos -Hora 02:00
```

Cada ejecución publica una carpeta con el volcado, su SHA-256 y los adjuntos verificados. Una carpeta .parcial corresponde a una ejecución incompleta. Revise el resultado de la tarea diariamente y conserve los documentos fiscales por diez años según §15. Los scripts no depuran copias. Resguarde por separado las credenciales, los roles PostgreSQL y la configuración del servidor.

## Probar la restauración cada mes

Configure el servicio erp_ensayo en una instancia aislada con permisos para crear bases. Seleccione una carpeta de respaldo terminada y una ruta nueva para los adjuntos. Ejemplo:

```powershell
.\scripts\respaldo.ps1 Restaurar erp_ensayo 'E:\Respaldos\ERP\CARPETA-DE-LA-COPIA' 'D:\Ensayo\adjuntos-nuevos'
```

Se crea una base con nombre único bajo el usuario del ensayo. El script comprueba el volcado y cada archivo contra el SHA-256 registrado en la base recuperada. Configure una instalación aislada con la base informada y el directorio recuperado, abra un documento con soporte y compruebe el cuadre del mayor y sus auxiliares. Registre la fecha, la copia, el resultado y el responsable. Si falla, conserve el diagnóstico y trate la base del ensayo como incompleta.
