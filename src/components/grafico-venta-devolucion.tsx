'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const NOMBRE_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export interface PuntoVentaDevolucion { mes: number; venta: number; devolucion: number; }

/** Evolución mensual: ventas vs. devoluciones, los 12 meses del año de referencia (spec_reportes §4.1). */
export function GraficoVentaDevolucion({ datos }: { datos: PuntoVentaDevolucion[] }) {
  const data = datos.map((d) => ({ ...d, etiqueta: NOMBRE_MES[d.mes - 1] }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="etiqueta" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={70}
          tickFormatter={(v: number) => `$${v.toLocaleString('en-US')}`} />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 }}
          labelStyle={{ color: '#f8fafc' }}
          formatter={(v, nombre) => [`US$ ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, nombre === 'devolucion' ? 'Devoluciones' : 'Ventas']} />
        <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} formatter={(v) => (v === 'devolucion' ? 'Devoluciones' : 'Ventas')} />
        <Bar dataKey="venta" name="venta" fill="#3b82f6" radius={[4, 4, 0, 0]} />
        <Bar dataKey="devolucion" name="devolucion" fill="#ef4444" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
