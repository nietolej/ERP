'use client';

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { EstadoAccion } from '@/lib/acciones';

type Accion = (estado: EstadoAccion, fd: FormData) => Promise<EstadoAccion>;

const Pendiente = createContext<boolean | null>(null);

/**
 * Ejecuta la acción sin pasar por `<form action>`: React vacía los campos no controlados al
 * terminar una acción de formulario, y el usuario perdería lo escrito cuando hay un error.
 */
export function useEnvio(accion: Accion) {
  const [estado, ejecutar, pendiente] = useActionState(accion, undefined);
  const alEnviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
    startTransition(() => ejecutar(fd));
  };
  return { estado, pendiente, alEnviar };
}

/** Proveedor del estado "procesando" para BotonEnviar en formularios que usan useEnvio. */
export const PendienteProvider = Pendiente.Provider;

/** Formulario que ejecuta una acción de servidor y muestra su resultado. */
export function Formulario({ accion, children, className = '' }: { accion: Accion; children: ReactNode; className?: string }) {
  const { estado, pendiente, alEnviar } = useEnvio(accion);
  const form = useRef<HTMLFormElement>(null);
  // Si la acción salió bien, se limpia el formulario; si falló, se conserva lo escrito.
  useEffect(() => {
    if (estado?.ok) form.current?.reset();
  }, [estado]);
  return (
    <form ref={form} onSubmit={alEnviar} className={className}>
      <Pendiente.Provider value={pendiente}>{children}</Pendiente.Provider>
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
  const enFormulario = useContext(Pendiente);
  const { pending } = useFormStatus();
  const procesando = enFormulario ?? pending;
  const estilos = {
    primario: 'bg-acento hover:bg-acento-hover text-white',
    secundario: 'border border-borde bg-white/5 hover:bg-white/10 text-texto',
    peligro: 'border border-peligro/50 bg-peligro/15 hover:bg-peligro/25 text-red-200',
  }[variante];
  return (
    <button type="submit" disabled={procesando} className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${estilos}`}>
      {procesando ? 'Procesando…' : children}
    </button>
  );
}
