'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

export interface ClienteSugerido { id: string; codigo: string; razon_social: string; }
type Buscar = (texto: string) => Promise<ClienteSugerido[]>;

/** Buscador con autocompletado de clientes por código o nombre, hasta 10 resultados (spec_reportes §4). */
export function BuscadorCliente({ buscar }: { buscar: Buscar }) {
  const [texto, setTexto] = useState('');
  const [sugeridos, setSugeridos] = useState<ClienteSugerido[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [, iniciar] = useTransition();

  function cambiar(v: string) {
    setTexto(v);
    const t = v.trim();
    if (t.length < 2) { setSugeridos([]); setAbierto(false); return; }
    iniciar(async () => {
      setSugeridos(await buscar(t));
      setAbierto(true);
    });
  }

  return (
    <div className="relative w-72">
      <input
        value={texto} onChange={(e) => cambiar(e.target.value)} onFocus={() => texto.trim().length >= 2 && setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
        placeholder="Buscar cliente por código o nombre" autoComplete="off" className="campo w-full" aria-label="Buscar cliente" />
      {abierto && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-borde bg-fondo-2 shadow-lg">
          {sugeridos.length === 0 ? (
            <li className="px-3 py-2 text-sm text-texto-2">Sin coincidencias.</li>
          ) : sugeridos.map((c) => (
            <li key={c.id}>
              <Link href={`/reportes/clientes/${c.codigo}`} className="block px-3 py-2 text-sm hover:bg-white/[0.06]">
                <span className="font-mono text-texto-2">{c.codigo}</span> · {c.razon_social}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
