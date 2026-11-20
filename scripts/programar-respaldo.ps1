param(
  [Parameter(Mandatory)][string]$Servicio,
  [Parameter(Mandatory)][string]$Carpeta,
  [Parameter(Mandatory)][string]$Adjuntos,
  [datetime]$Hora = '02:00'
)
$ErrorActionPreference = 'Stop'
if ($Servicio -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Servicio inválido.' }
$script = Join-Path $PSScriptRoot 'respaldo.ps1'
$Carpeta = [IO.Path]::GetFullPath($Carpeta)
$Adjuntos = [IO.Path]::GetFullPath($Adjuntos)
$argumentos = "-NoProfile -NonInteractive -File `"$script`" -Operacion Respaldar -Servicio $Servicio -Carpeta `"$Carpeta`" -Adjuntos `"$Adjuntos`""
$accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentos
$diario = New-ScheduledTaskTrigger -Daily -At $Hora
$cuenta = Get-Credential -Message 'Cuenta de Windows que ejecutará el respaldo diario'
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ERP-respaldo-$Servicio" -Action $accion -Trigger $diario -Settings $config -User $cuenta.UserName -Password $cuenta.GetNetworkCredential().Password
