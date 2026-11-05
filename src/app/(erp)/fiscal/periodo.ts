/** El periodo viene como «AAAA-MM» (mes calendario de la fecha del documento); por defecto, el mes en curso en Caracas. */
export function leerPeriodo(valor: string | undefined, hoy: Date = new Date()): { anio: number; mes: number; texto: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(valor ?? '');
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { anio: Number(m[1]), mes: Number(m[2]), texto: `${m[1]}-${m[2]}` };
  const caracas = new Date(hoy.toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  const mes = caracas.getMonth() + 1;
  return { anio: caracas.getFullYear(), mes, texto: `${caracas.getFullYear()}-${String(mes).padStart(2, '0')}` };
}
