'use client';

import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const NOMBRE_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export interface PuntoDevolucion { anio: number; mes: number; venta: number; devolucion: number; pct: number | null; }

/** Barras de venta y devoluciones por mes, con la línea del % devuelto en el eje derecho (spec_reportes §8). */
export function GraficoDevolucionesMensuales({ datos }: { datos: PuntoDevolucion[] }) {
  const data = datos.map((d) => ({ ...d, etiqueta: `${NOMBRE_MES[d.mes - 1]}-${String(d.anio).slice(2)}` }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="etiqueta" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
        <YAxis yAxisId="usd" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={70} tickFormatter={(v: number) => `$${v.toLocaleString('en-US')}`} />
        <YAxis yAxisId="pct" orientation="right" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 }} labelStyle={{ color: '#f8fafc' }}
          formatter={(v, n) => (n === 'pct' ? [`${Number(v).toFixed(1)} %`, '% devuelto'] : [`US$ ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, n === 'venta' ? 'Venta' : 'Devoluciones'])} />
        <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} formatter={(n) => (n === 'venta' ? 'Venta' : n === 'devolucion' ? 'Devoluciones' : '% devuelto')} />
        <Bar yAxisId="usd" dataKey="venta" fill="#3b82f6" radius={[4, 4, 0, 0]} />
        <Bar yAxisId="usd" dataKey="devolucion" fill="#ef4444" radius={[4, 4, 0, 0]} />
        <Line yAxisId="pct" dataKey="pct" type="monotone" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
