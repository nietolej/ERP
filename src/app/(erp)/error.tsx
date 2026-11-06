'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Aviso, Panel } from '@/components/ui';

/**
 * Estado de error de todas las pantallas del ERP: si una consulta o un cálculo falla, se muestra este aviso
 * y nunca cifras de ejemplo (AGENTS.md §6). Conserva el menú porque el layout queda fuera del límite.
 * En esta versión de Next el botón de reintento se llama `retry` (no `reset`).
 */
export default function ErrorDePantalla({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // Solo el identificador: sirve para ubicar el error en el registro del servidor, sin datos personales.
    console.error('Error de pantalla', error.digest ?? '');
  }, [error]);

  return (
    <Panel titulo="No se pudo cargar esta pantalla">
      <Aviso tono="peligro">
        Ocurrió un error al preparar la información. No se muestran cifras para no inducir a error.
        {error.digest && <span className="mt-1 block text-xs opacity-80">Código para el administrador: {error.digest}</span>}
      </Aviso>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => retry()} className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white">
          Reintentar
        </button>
        <Link href="/" className="text-sm font-semibold text-acento">← Volver al inicio</Link>
      </div>
    </Panel>
  );
}
