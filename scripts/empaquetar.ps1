param()
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$archivos = @('src','db','public','package.json','package-lock.json','next.config.ts','tsconfig.json','postcss.config.mjs','.env.example','scripts/migrar.mts','scripts/crear-admin.mts','scripts/entorno.mts','scripts/instalar.ps1','scripts/respaldo.ps1','scripts/programar-respaldo.ps1','docs/instalacion-respaldo.md')
[IO.Directory]::CreateDirectory((Join-Path $PWD 'dist')) | Out-Null
$zip = Join-Path $PWD ('dist/ERP-instalacion-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
& tar.exe -a -cf $zip @archivos
if ($LASTEXITCODE -ne 0) { throw 'Falló el empaquetado.' }
Write-Output $zip
