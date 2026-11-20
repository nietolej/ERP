param(
  [Parameter(Mandatory)][ValidateSet('Respaldar','Restaurar')][string]$Operacion,
  [Parameter(Mandatory)][string]$Servicio,
  [Parameter(Mandatory)][string]$Carpeta,
  [Parameter(Mandatory)][string]$Adjuntos
)
$ErrorActionPreference = 'Stop'
# El servicio libpq identifica la instancia. La contraseña se obtiene del archivo pgpass.
$env:PGSERVICE = $Servicio
if ($Servicio -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Nombre de servicio inválido.' }
$Carpeta = [IO.Path]::GetFullPath($Carpeta)
$Adjuntos = [IO.Path]::GetFullPath($Adjuntos)
function Ejecutar([string]$Programa, [string[]]$Argumentos) {
  $salida = & $Programa @Argumentos
  if ($LASTEXITCODE -ne 0) { throw "Falló $Programa (código $LASTEXITCODE)." }
  $salida
}
function CopiarAdjuntos([string]$Db, [string]$Origen, [string]$Destino) {
  $consulta = "select id,hash_sha256 from public.adjunto order by id"
  $filas = Ejecutar 'psql' @('-X','-w','-A','-t','-F',',','-v','ON_ERROR_STOP=1','-d',$Db,'-c',$consulta)
  [IO.Directory]::CreateDirectory($Destino) | Out-Null
  foreach ($fila in $filas) {
    $id,$hash = $fila.Split(',')
    if ($id -notmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or $hash -notmatch '^[0-9a-f]{64}$') { throw 'Referencia de adjunto inválida.' }
    $sub = $id.Substring(0,2)
    $dir = Join-Path $Destino $sub
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $archivo = Join-Path $dir $id
    [IO.File]::Copy((Join-Path (Join-Path $Origen $sub) $id),$archivo)
    if ((Get-FileHash -LiteralPath $archivo).Hash -ne $hash) { throw "Adjunto inválido ($id)." }
  }
}
if ($Operacion -eq 'Respaldar') {
  [IO.Directory]::CreateDirectory($Carpeta) | Out-Null
  $nombre = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')
  $tmp = Join-Path $Carpeta ('.parcial-' + $nombre)
  [IO.Directory]::CreateDirectory($tmp) | Out-Null
  $dump = Join-Path $tmp 'erp.dump'
  Ejecutar 'pg_dump' @('-w','-Fc','-d',"service=$Servicio",'-f',$dump)
  # Los soportes confirmados son inmutables. La consulta posterior incluye todo el volcado.
  CopiarAdjuntos "service=$Servicio" $Adjuntos (Join-Path $tmp 'adjuntos')
  (Get-FileHash -LiteralPath $dump).Hash | Set-Content -Encoding ascii (Join-Path $tmp 'sha256')
  [IO.Directory]::Move($tmp,(Join-Path $Carpeta $nombre))
  Write-Output (Join-Path $Carpeta $nombre)
} else {
  $dump = Join-Path $Carpeta 'erp.dump'
  if ((Get-FileHash -LiteralPath $dump).Hash -ne (Get-Content -LiteralPath (Join-Path $Carpeta 'sha256') -Raw).Trim()) { throw 'Volcado dañado.' }
  if (Test-Path -LiteralPath $Adjuntos) { throw 'El destino de adjuntos debe ser nuevo.' }
  $db = 'erp_restaurado_' + [guid]::NewGuid().ToString('N')
  $conexion = "service=$Servicio dbname=$db"
  Ejecutar 'createdb' @('-w',"--maintenance-db=service=$Servicio",'-T','template0','-E','UTF8',$db)
  Ejecutar 'pg_restore' @('-w','--single-transaction','--exit-on-error','--no-owner','--no-acl','-d',$conexion,$dump)
  $tmp = $Adjuntos + '.' + $db
  CopiarAdjuntos $conexion (Join-Path $Carpeta 'adjuntos') $tmp
  [IO.Directory]::Move($tmp,$Adjuntos)
  Write-Output "Restauración verificada. Base: $db. Adjuntos: $Adjuntos"
}
