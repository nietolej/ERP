import { execFileSync } from 'node:child_process';

// Códigos para abrir-erp.bat: 0 libre, 10 instancia local con login, 2 ocupado o no verificable.
async function estadoPuerto(puerto) {
  const consulta = "$ErrorActionPreference = 'Stop'; " + '[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()'
    + ` | Where-Object Port -eq ${puerto} | ForEach-Object { [Net.IPAddress]::IsLoopback($_.Address) }`;
  const salida = execFileSync('powershell.exe', ['-NoProfile', '-Command', consulta], { encoding: 'utf8' }).trim();
  if (!salida) return 0;
  if (!salida.split(/\s+/).every((valor) => valor === 'True')) return 2;

  const url = new URL(`http://127.0.0.1:${puerto}/`);
  const respuesta = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const login = respuesta.headers.get('location');
  return respuesta.status === 307 && login && new URL(login, url).href === new URL('/login', url).href ? 10 : 2;
}

try {
  const puerto = Number(process.argv[2]);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw new Error('Puerto inválido');
  process.exitCode = await estadoPuerto(puerto);
} catch {
  process.exitCode = 2;
}
