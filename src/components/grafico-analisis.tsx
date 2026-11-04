'use client';

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const NOMBRE_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const ESTILO_TOOLTIP = { background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 };
const EJE = { fill: '#94a3b8', fontSize: 12 };

export interface BarraTramo { etiqueta: string; pedidos: number; }

/** Barras: una por tramo de monto, con la cantidad de pedidos (spec_reportes §14.1). */
export function GraficoHistogramaPedidos({ datos }: { datos: BarraTramo[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={datos} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="etiqueta" tick={EJE} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
        <YAxis tick={EJE} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
        <Tooltip contentStyle={ESTILO_TOOLTIP} labelStyle={{ color: '#f8fafc' }} formatter={(v) => [String(v), 'Pedidos']} />
        <Bar dataKey="pedidos" fill="#3b82f6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface PuntoEpisodios { anio: number; mes: number; episodios: number; }

/** Línea: episodios de quiebre que empezaron en cada mes (spec_reportes §14.4). */
export function GraficoQuiebresMensuales({ datos }: { datos: PuntoEpisodios[] }) {
  const data = datos.map((d) => ({ ...d, etiqueta: `${NOMBRE_MES[d.mes - 1]}-${String(d.anio).slice(2)}` }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="etiqueta" tick={EJE} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
        <YAxis tick={EJE} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
        <Tooltip contentStyle={ESTILO_TOOLTIP} labelStyle={{ color: '#f8fafc' }} formatter={(v) => [String(v), 'Episodios']} />
        <Line dataKey="episodios" type="monotone" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
