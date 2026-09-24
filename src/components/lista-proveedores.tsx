'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import { Aviso, Celda, Etiqueta, Tabla } from '@/components/ui';
import type { FilaProveedor } from '@/lib/maestros/proveedores';

type Buscar = (texto: string, estado: string) => Promise<{ filas: FilaProveedor[] } | { error: string }>;

const TONO = { pendiente: 'advertencia', activo: 'exito', inactivo: 'info', bloqueado: 'peligro' } as const;

/** Lista de proveedores con búsqueda. El texto buscado viaja por acción de servidor, nunca en la URL. */
export function ListaProveedores({ iniciales, buscar, limite, tipos }: {
  iniciales: FilaProveedor[]; buscar: Buscar; limite: number; tipos: Record<string, string>;
}) {
  const [filas, setFilas] = useState(iniciales);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    iniciar(async () => {
      const r = await buscar(String(fd.get('texto') ?? ''), String(fd.get('estado') ?? ''));
      if ('error' in r) {
        setError(r.error);
        setFilas([]);
      } else {
        setError(null);
        setFilas(r.filas);
      }
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={enviar} className="flex flex-wrap items-end gap-2 text-sm">
        <input name="texto" placeholder="Código, RIF o nombre" autoComplete="off" className="campo w-72" aria-label="Buscar" />
        <select name="estado" className="campo w-auto" aria-label="Estado" defaultValue="">
          <option value="">Todos los estados</option>
          <option value="pendiente">Pendientes</option>
          <option value="activo">Activos</option>
          <option value="inactivo">Inactivos</option>
          <option value="bloqueado">Bloqueados</option>
        </select>
        <button disabled={pendiente} className="rounded-lg border border-borde bg-white/5 px-3 py-2 font-semibold hover:bg-white/10 disabled:opacity-50">
          {pendiente ? 'Buscando…' : 'Buscar'}
        </button>
      </form>
      {error ? <Aviso tono="peligro">{error}</Aviso> : (
        <>
          <Tabla columnas={['Código', 'RIF', 'Razón social', 'Tipo', 'País', 'Estado']} vacio="No hay proveedores que coincidan.">
            {filas.map((p) => (
              <tr key={p.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/maestros/proveedores/${p.id}`} className="text-acento hover:underline">{p.codigo}</Link></Celda>
                <Celda mono>{p.rif}</Celda>
                <Celda><Link href={`/maestros/proveedores/${p.id}`} className="hover:underline">{p.razon_social}</Link></Celda>
                <Celda className="text-texto-2">{tipos[p.tipo] ?? p.tipo}</Celda>
                <Celda mono className="text-texto-2">{p.pais}</Celda>
                <Celda>
                  <span className="flex flex-wrap gap-1">
                    <Etiqueta tono={TONO[p.estado as keyof typeof TONO] ?? 'info'}>{p.estado}</Etiqueta>
                    {p.cambio_pendiente && <Etiqueta tono="advertencia">cambio por aprobar</Etiqueta>}
                  </span>
                </Celda>
              </tr>
            ))}
          </Tabla>
          {filas.length >= limite && <p className="text-sm text-texto-2">Se muestran los primeros {limite}. Afine la búsqueda para ver el resto.</p>}
        </>
      )}
    </div>
  );
}
