'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Celda, Etiqueta, Panel, Tabla } from '@/components/ui';
import type { FilaProspecto } from '@/lib/crm/prospectos';
import { buscarProspectosAccion } from '../acciones';

const FILTROS = [
  { valor: 'activo', texto: 'Activos' },
  { valor: 'convertido', texto: 'Convertidos en clientes' },
  { valor: 'descartado', texto: 'Descartados' },
  { valor: '', texto: 'Todos' },
] as const;
const TONO = { activo: 'info', convertido: 'exito', descartado: 'peligro' } as const;

export function ListaProspectos({ iniciales, estadoInicial }: { iniciales: FilaProspecto[]; estadoInicial: string }) {
  const [resultado, buscar, pendiente] = useActionState(buscarProspectosAccion, null);
  const [texto, setTexto] = useState(resultado?.texto ?? '');
  const [estado, setEstado] = useState(resultado?.estado ?? estadoInicial);
  const filas = resultado?.filas ?? iniciales;

  return (
    <Panel>
      <form action={buscar} className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label>Estado
          <select name="estado" value={estado} onChange={(e) => setEstado(e.target.value)} className="campo">
            {FILTROS.map((f) => <option key={f.valor} value={f.valor}>{f.texto}</option>)}
          </select>
        </label>
        <label>Buscar por RIF o nombre
          <input name="q" value={texto} onChange={(e) => setTexto(e.target.value)} className="campo" />
        </label>
        <button disabled={pendiente} className="rounded-lg border border-borde bg-white/5 px-3 py-2 hover:bg-white/10">
          {pendiente ? 'Buscando…' : 'Buscar'}
        </button>
      </form>
      {resultado?.error ? <p role="alert">{resultado.error}</p> : (
        <Tabla columnas={['RIF', 'Prospecto', 'Vendedor', 'Origen', { t: 'Oportunidades abiertas', derecha: true }, 'Última actividad', 'Registrado', 'Estado']}
          vacio="No hay prospectos con ese filtro.">
          {filas.map((p) => (
            <tr key={p.id} className="hover:bg-white/[0.03]">
              <Celda mono>{p.rif}</Celda>
              <Celda><Link href={`/crm/terceros/${p.id}`} className="text-acento hover:underline">{p.razon_social}</Link></Celda>
              <Celda className="text-texto-2">{p.vendedor}</Celda>
              <Celda className="text-texto-2">{p.origen ?? '—'}</Celda>
              <Celda derecha mono>{p.oportunidades_abiertas}</Celda>
              <Celda className="text-texto-2">{p.ultima_actividad ?? 'Ninguna'}</Celda>
              <Celda className="text-texto-2">{p.creado}</Celda>
              <Celda><Etiqueta tono={TONO[p.estado as keyof typeof TONO]}>{p.estado === 'activo' ? 'Activo' : p.estado === 'convertido' ? 'Cliente' : 'Descartado'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      )}
    </Panel>
  );
}
