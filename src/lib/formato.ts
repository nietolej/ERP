/**
 * Formato de presentación (spec_reportes §1.4): montos $1,234.56, fechas dd-mm-aaaa.
 * Los montos llegan como texto decimal desde la base y se formatean sin pasar por float.
 */

const fmtMonto = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTasa = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

// Intl.NumberFormat acepta strings decimales y los formatea con precisión exacta.
type Decimal = string | number;
const n = (v: Decimal) => v as unknown as number;

export function monto(v: Decimal, simbolo = ''): string {
  return `${simbolo}${fmtMonto.format(n(v))}`;
}

export function tasa(v: Decimal): string {
  return fmtTasa.format(n(v));
}

/** 'YYYY-MM-DD' → 'dd-mm-aaaa' */
export function fecha(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const iso = typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
  const [a, m, d] = iso.split('-');
  return `${d}-${m}-${a}`;
}

export function fechaHora(v: Date | string | null | undefined): string {
  if (!v) return '—';
  const f = typeof v === 'string' ? new Date(v) : v;
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(f);
}

/** Fecha de hoy en Venezuela, 'YYYY-MM-DD'. */
export function hoyCaracas(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
}
