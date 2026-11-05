'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useRef } from 'react';
import { aCsv, tablaAFilas } from '@/lib/csv';

/**
 * "Exportar CSV" de una tabla de reporte (spec_reportes §1.4). Solo aparece en /reportes y en los libros de /fiscal, y exporta lo que se ve, con los filtros
 * aplicados. Va dentro de la tabla (`Tabla`), así que cubre todas las de los módulos M1 a M7 sin repetir código en cada pantalla.
 */
export function BotonCsv() {
  const ruta = usePathname();
  const q = useSearchParams();
  const ref = useRef<HTMLButtonElement>(null);
  if (!ruta.startsWith('/reportes') && !ruta.startsWith('/fiscal') && !ruta.startsWith('/contabilidad/estados')) return null;

  function exportar() {
    const tabla = ref.current?.closest('[data-tabla]')?.querySelector('table');
    if (!tabla) return;
    const nombre = [ruta.replace(/^\/(reportes|fiscal|contabilidad)\/?/, '').replace(/\//g, '-') || 'reporte', q.get('tab'), q.get('periodo')].filter(Boolean).join('-');
    const hoy = new Date().toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' }).replace(/\//g, '-');
    const blob = new Blob([aCsv(tablaAFilas(tabla))], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${nombre}-${hoy}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mb-2 flex justify-end">
      <button ref={ref} type="button" onClick={exportar} className="rounded-lg border border-borde px-3 py-1 text-xs font-semibold text-texto-2 hover:text-texto">
        Exportar CSV
      </button>
    </div>
  );
}
