param()
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:NODE_ENV = 'production'
function Npm([string[]]$Argumentos) {
  & npm.cmd @Argumentos
  if ($LASTEXITCODE -ne 0) { throw 'La instalación se interrumpió. Revise el paso anterior.' }
}
Npm @('ci','--include=dev')
Npm @('run','build')
Npm @('run','db:migrar')
Npm @('run','db:crear-admin','--','--preparar')
Write-Output 'Instalación preparada. Inicie con npm.cmd start.'
