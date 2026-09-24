@echo off
rem ERP Hanei Motors: arranca el entorno de desarrollo y abre el navegador.
rem Doble clic para usarlo. Cerrar esta ventana detiene el ERP.
chcp 65001 >nul
title ERP Hanei Motors
cd /d "%~dp0"
set PUERTO=3100
set URL=http://localhost:%PUERTO%

where npm >nul 2>nul
if errorlevel 1 (
  echo No se encontró Node.js. Instale Node.js 24 desde https://nodejs.org y vuelva a intentar.
  pause
  exit /b 1
)

rem Si el ERP ya está corriendo, solo abre el navegador.
netstat -ano | findstr /r /c:":%PUERTO% .*LISTENING" >nul
if not errorlevel 1 (
  echo El ERP ya está corriendo. Abriendo %URL% ...
  start "" %URL%
  exit /b 0
)

if not exist node_modules (
  echo Instalando dependencias, la primera vez tarda unos minutos...
  call npm install
  if errorlevel 1 goto error
)

set PRIMERA=0
if not exist ".data\erp" set PRIMERA=1

echo Preparando la base de datos...
call npm run db:migrar
if errorlevel 1 goto error

if "%PRIMERA%"=="0" goto arrancar

:admin
echo.
echo ============================================================
echo  Primera vez: se crea el usuario administrador del ERP.
echo ============================================================
set EMAIL=
set NOMBRE=
set /p EMAIL=Correo del administrador:
set /p NOMBRE=Nombre y apellido:
call npm run db:crear-admin -- --email "%EMAIL%" --nombre "%NOMBRE%"
if errorlevel 1 (
  echo No se pudo crear el administrador. Intente de nuevo.
  goto admin
)
echo.
echo ANOTE LA CLAVE TEMPORAL DE ARRIBA: no se vuelve a mostrar.
echo Deberá cambiarla la primera vez que entre.
pause

:arrancar
echo.
echo Iniciando el ERP en %URL% ...
echo No cierre esta ventana mientras use el ERP.
rem Abre el navegador cuando el servidor tenga tiempo de arrancar.
start "" /min cmd /c "timeout /t 8 /nobreak >nul && start %URL%"
call npm run dev -- -p %PUERTO%
goto fin

:error
echo.
echo Ocurrió un error. Revise los mensajes de arriba.
pause
exit /b 1

:fin
pause
