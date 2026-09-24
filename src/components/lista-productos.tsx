'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import { Aviso, Celda, Etiqueta, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaProducto } from '@/lib/maestros/productos';

type Buscar = (texto: string, estado: string) => Promise<{ filas: FilaProducto[] } | { error: string }>;

const precio = (v: string | null) => (v === null ? '—' : monto(v, '$'));

/** Catálogo con búsqueda por código, descripción o referencia cruzada. Precios vigentes hoy. */
export function ListaProductos({ iniciales, buscar, limite }: { iniciales: FilaProducto[]; buscar: Buscar; limite: number }) {
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
        <input name="texto" placeholder="Código, descripción o referencia" autoComplete="off" className="campo w-80" aria-label="Buscar" />
        <select name="estado" className="campo w-auto" aria-label="Estado" defaultValue="activo">
          <option value="activo">Activos</option>
          <option value="inactivo">Inactivos</option>
          <option value="">Todos</option>
        </select>
        <button disabled={pendiente} className="rounded-lg border border-borde bg-white/5 px-3 py-2 font-semibold hover:bg-white/10 disabled:opacity-50">
          {pendiente ? 'Buscando…' : 'Buscar'}
        </button>
      </form>
      {error ? <Aviso tono="peligro">{error}</Aviso> : (
        <>
          <Tabla columnas={['Código', 'Descripción', 'Grupo', 'Marca', 'Unidad',
            { t: 'Lista A', derecha: true }, { t: 'Lista B', derecha: true }, { t: 'Lista D', derecha: true }, 'Estado']}
            vacio="No hay productos que coincidan.">
            {filas.map((p) => (
              <tr key={p.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/maestros/productos/${p.id}`} className="text-acento hover:underline">{p.codigo}</Link></Celda>
                <Celda><Link href={`/maestros/productos/${p.id}`} className="hover:underline">{p.descripcion}</Link></Celda>
                <Celda className="text-texto-2">{p.grupo ?? '—'}</Celda>
                <Celda className="text-texto-2">{p.marca ?? '—'}</Celda>
                <Celda className="text-texto-2">{p.unidad}</Celda>
                <Celda derecha>{precio(p.precio_a)}</Celda>
                <Celda derecha>{precio(p.precio_b)}</Celda>
                <Celda derecha>{precio(p.precio_d)}</Celda>
                <Celda><Etiqueta tono={p.estado === 'activo' ? 'exito' : 'info'}>{p.estado}</Etiqueta></Celda>
              </tr>
            ))}
          </Tabla>
          {filas.length >= limite && <p className="text-sm text-texto-2">Se muestran los primeros {limite}. Afine la búsqueda para ver el resto.</p>}
        </>
      )}
    </div>
  );
}
