'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const COLORES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

export interface PuntoValor { mes: string; almacen: string; valor: number; }

/** Valor al costo del inventario al cierre de cada mes, apilado por almacén (spec_reportes §9). */
export function GraficoValorizacion({ datos }: { datos: PuntoValor[] }) {
  const almacenes = [...new Set(datos.map((d) => d.almacen))];
  const meses = [...new Set(datos.map((d) => d.mes))];
  const data = meses.map((mes) => {
    const fila: Record<string, string | number> = { mes: `${mes.slice(5)}-${mes.slice(2, 4)}` };
    for (const a of almacenes) fila[a] = datos.find((d) => d.mes === mes && d.almacen === a)?.valor ?? 0;
    return fila;
  });
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
        <XAxis dataKey="mes" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={70} tickFormatter={(v: number) => `$${v.toLocaleString('en-US')}`} />
        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 }} labelStyle={{ color: '#f8fafc' }}
          formatter={(v) => `US$ ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} />
        <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
        {almacenes.map((a, i) => <Bar key={a} dataKey={a} stackId="valor" fill={COLORES[i % COLORES.length]} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}
