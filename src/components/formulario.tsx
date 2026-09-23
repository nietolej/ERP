'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { EstadoAccion } from '@/lib/acciones';

type Accion = (estado: EstadoAccion, fd: FormData) => Promise<EstadoAccion>;

/** Formulario que ejecuta una acción de servidor y muestra su resultado. */
export function Formulario({ accion, children, className = '' }: { accion: Accion; children: ReactNode; className?: string }) {
  const [estado, ejecutar] = useActionState(accion, undefined);
  return (
    <form action={ejecutar} className={className}>
      {children}
      {estado?.error && (
        <p role="alert" className="mt-3 rounded-lg border border-peligro/40 bg-peligro/10 px-3 py-2 text-sm text-red-200 whitespace-pre-line">
          {estado.error}
        </p>
      )}
      {estado?.ok && (
        <p role="status" className="mt-3 rounded-lg border border-exito/40 bg-exito/10 px-3 py-2 text-sm text-emerald-200 whitespace-pre-line">
          {estado.ok}
        </p>
      )}
    </form>
  );
}

export function BotonEnviar({ children, variante = 'primario' }: { children: ReactNode; variante?: 'primario' | 'secundario' | 'peligro' }) {
  const { pending } = useFormStatus();
  const estilos = {
    primario: 'bg-acento hover:bg-acento-hover text-white',
    secundario: 'border border-borde bg-white/5 hover:bg-white/10 text-texto',
    peligro: 'border border-peligro/50 bg-peligro/15 hover:bg-peligro/25 text-red-200',
  }[variante];
  return (
    <button type="submit" disabled={pending} className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${estilos}`}>
      {pending ? 'Procesando…' : children}
    </button>
  );
}
