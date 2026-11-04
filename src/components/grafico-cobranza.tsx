'use client';

import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const NOMBRE_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TOOLTIP = { background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 };
const usd = (v: unknown) => `US$ ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/** Barras de monto por tramo (velocidad de cobro y antigüedad de saldos, spec_reportes §7). */
export function GraficoTramos({ datos }: { datos: { tramo: string; monto: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={datos} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="tramo" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={70} tickFormatter={(v: number) => `$${v.toLocaleString('en-US')}`} />
        <Tooltip contentStyle={TOOLTIP} labelStyle={{ color: '#f8fafc' }} formatter={(v) => [usd(v), 'Monto']} />
        <Bar dataKey="monto" fill="#3b82f6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface PuntoTendencia { anio: number; mes: number; monto: number; dias: number | null; }

/** Monto cobrado por mes (barras) y días promedio de pago (línea, eje derecho). */
export function GraficoTendenciaCobranza({ datos }: { datos: PuntoTendencia[] }) {
  const data = datos.map((d) => ({ ...d, etiqueta: `${NOMBRE_MES[d.mes - 1]}-${String(d.anio).slice(2)}` }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="etiqueta" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
        <YAxis yAxisId="monto" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={70} tickFormatter={(v: number) => `$${v.toLocaleString('en-US')}`} />
        <YAxis yAxisId="dias" orientation="right" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip contentStyle={TOOLTIP} labelStyle={{ color: '#f8fafc' }}
          formatter={(v, n) => (n === 'monto' ? [usd(v), 'Cobrado'] : [`${Number(v).toFixed(1)} días`, 'Días promedio'])} />
        <Bar yAxisId="monto" dataKey="monto" name="monto" fill="#3b82f6" radius={[4, 4, 0, 0]} />
        <Line yAxisId="dias" dataKey="dias" name="dias" type="monotone" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
