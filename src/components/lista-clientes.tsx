'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import { Aviso, Celda, Etiqueta, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaCliente } from '@/lib/maestros/clientes';

type Buscar = (texto: string, estado: string) => Promise<{ filas: FilaCliente[] } | { error: string }>;

const TONO = { pendiente: 'advertencia', activo: 'exito', inactivo: 'info', bloqueado: 'peligro' } as const;

/** Lista de clientes con búsqueda. El texto buscado viaja por acción de servidor, nunca en la URL. */
export function ListaClientes({ iniciales, buscar, limite }: { iniciales: FilaCliente[]; buscar: Buscar; limite: number }) {
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
          <Tabla columnas={['Código', 'RIF', 'Razón social', 'Vendedor', 'Sucursal', { t: 'Límite de crédito', derecha: true }, 'Estado']}
            vacio="No hay clientes que coincidan.">
            {filas.map((c) => (
              <tr key={c.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/maestros/clientes/${c.id}`} className="text-acento hover:underline">{c.codigo}</Link></Celda>
                <Celda mono>{c.rif}</Celda>
                <Celda><Link href={`/maestros/clientes/${c.id}`} className="hover:underline">{c.razon_social}</Link></Celda>
                <Celda className="text-texto-2">{c.vendedor ?? '—'}</Celda>
                <Celda className="text-texto-2">{c.sucursal ?? '—'}</Celda>
                <Celda derecha>{c.estado === 'pendiente' ? '—' : monto(c.limite_credito_usd, '$')}</Celda>
                <Celda><Etiqueta tono={TONO[c.estado as keyof typeof TONO] ?? 'info'}>{c.estado}</Etiqueta></Celda>
              </tr>
            ))}
          </Tabla>
          {filas.length >= limite && <p className="text-sm text-texto-2">Se muestran los primeros {limite}. Afine la búsqueda para ver el resto.</p>}
        </>
      )}
    </div>
  );
}
