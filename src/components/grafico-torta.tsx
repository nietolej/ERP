'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const COLORES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

export interface PorcionTorta { nombre: string; valor: number; }

/** Torta de porcentaje (pagos por instrumento, spec_reportes §4.1). */
export function GraficoTorta({ datos }: { datos: PorcionTorta[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={datos} dataKey="valor" nameKey="nombre" cx="50%" cy="50%" innerRadius={50} outerRadius={85} paddingAngle={2}>
          {datos.map((d, i) => <Cell key={d.nombre} fill={COLORES[i % COLORES.length]} stroke="none" />)}
        </Pie>
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 }}
          labelStyle={{ color: '#f8fafc' }}
          formatter={(v) => `US$ ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} />
        <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
