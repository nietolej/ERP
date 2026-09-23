import type { ReactNode } from 'react';

/** Componentes visuales base, con el estilo del dashboard (spec_reportes §1.2). */

export function Encabezado({ titulo, descripcion, children }: { titulo: string; descripcion?: string; children?: ReactNode }) {
  return (
    <header className="panel mb-5 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div>
        <h1 className="text-xl font-bold">{titulo}</h1>
        {descripcion && <p className="mt-0.5 text-sm text-texto-2">{descripcion}</p>}
      </div>
      {children}
    </header>
  );
}

export function Panel({ titulo, children, className = '' }: { titulo?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-5 ${className}`}>
      {titulo && <h2 className="mb-4 text-base font-semibold">{titulo}</h2>}
      {children}
    </section>
  );
}

type Tono = 'info' | 'exito' | 'advertencia' | 'peligro';
const TONOS: Record<Tono, string> = {
  info: 'border-acento/40 bg-acento/10 text-blue-200',
  exito: 'border-exito/40 bg-exito/10 text-emerald-200',
  advertencia: 'border-advertencia/40 bg-advertencia/10 text-amber-200',
  peligro: 'border-peligro/40 bg-peligro/10 text-red-200',
};

export function Aviso({ tono = 'info', children }: { tono?: Tono; children: ReactNode }) {
  return <div className={`rounded-lg border px-4 py-3 text-sm ${TONOS[tono]}`}>{children}</div>;
}

export function Etiqueta({ tono = 'info', children }: { tono?: Tono; children: ReactNode }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${TONOS[tono]}`}>{children}</span>;
}

export function Tabla({ columnas, children, vacio }: { columnas: (string | { t: string; derecha?: boolean })[]; children: ReactNode; vacio?: string }) {
  const hayFilas = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-borde text-left text-xs uppercase tracking-wider text-texto-2">
            {columnas.map((c) => {
              const t = typeof c === 'string' ? c : c.t;
              const derecha = typeof c !== 'string' && c.derecha;
              return <th key={t} className={`px-3 py-2 font-semibold ${derecha ? 'text-right' : ''}`}>{t}</th>;
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-borde">
          {hayFilas ? children : (
            <tr><td colSpan={columnas.length} className="px-3 py-8 text-center text-texto-2">{vacio ?? 'Sin registros.'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Celda({ children, derecha, mono, className = '' }: { children: ReactNode; derecha?: boolean; mono?: boolean; className?: string }) {
  return <td className={`px-3 py-2 ${derecha ? 'text-right tabular-nums' : ''} ${mono ? 'font-mono' : ''} ${className}`}>{children}</td>;
}

export function Campo({ etiqueta, children, ayuda }: { etiqueta: string; children: ReactNode; ayuda?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-texto-2">{etiqueta}</span>
      {children}
      {ayuda && <span className="mt-1 block text-xs text-texto-2">{ayuda}</span>}
    </label>
  );
}

/** Indicador de estado de un paso de configuración. */
export function Paso({ listo, titulo, detalle }: { listo: boolean; titulo: string; detalle: string }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${listo ? 'bg-exito text-slate-900' : 'bg-slate-600 text-slate-200'}`}>
        {listo ? '✓' : '·'}
      </span>
      <span>
        <span className="font-medium">{titulo}</span>
        <span className="block text-sm text-texto-2">{detalle}</span>
      </span>
    </li>
  );
}
