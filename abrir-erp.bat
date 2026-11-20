@echo off
setlocal
rem NEXO: arranca el entorno de desarrollo y abre el navegador.
rem Doble clic para usarlo. Cerrar esta ventana detiene el ERP.
chcp 65001 >nul
title NEXO
cd /d "%~dp0"
set "PUERTO=3100"
set "URL=http://127.0.0.1:%PUERTO%"
set "ERP_SIN_LOGIN=0"

where npm >nul 2>nul
if errorlevel 1 (
  echo No se encontró Node.js. Instale Node.js 24 desde https://nodejs.org y vuelva a intentar.
  pause
  exit /b 1
)

rem Reutiliza el puerto solo si toda la escucha es local y el ERP exige iniciar sesión.
node scripts/estado-puerto.mjs %PUERTO%
if "%ERRORLEVEL%"=="10" (
  start "" "%URL%"
  exit /b 0
)
if errorlevel 1 (
  echo El puerto %PUERTO% está ocupado o no se pudo verificar el acceso local con clave. Cierre la instancia anterior y vuelva a intentar.
  goto error
)

if not exist node_modules (
  echo Instalando dependencias, la primera vez tarda unos minutos...
  call npm install
  if errorlevel 1 goto error
)

echo Preparando la base de datos...
call npm run db:migrar
if errorlevel 1 goto error

call npm run db:crear-admin -- --preparar
if errorlevel 1 goto error

echo.
echo Iniciando el ERP en %URL% ...
echo No cierre esta ventana mientras use el ERP.
rem Abre el navegador cuando el servidor tenga tiempo de arrancar.
start "" /min cmd /c "timeout /t 8 /nobreak >nul && start %URL%"
call npm run dev -- --hostname 127.0.0.1 -p %PUERTO%
if errorlevel 1 goto error
goto fin

:error
echo.
echo Ocurrió un error. Revise los mensajes de arriba.
pause
exit /b 1

:fin
pause
