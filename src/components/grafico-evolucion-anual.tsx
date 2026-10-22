'use client';

import { useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface PuntoAnual {
  anio: number; venta: number; items: number; pedidos: number; devolucion: number; diasPago: number | null; descuentoPct: number | null; tendencia: number;
}

const METRICAS = {
  venta: { etiqueta: 'Venta', formato: (v: number) => `$${v.toLocaleString('en-US')}` },
  items: { etiqueta: 'Ítems vendidos', formato: (v: number) => v.toLocaleString('en-US') },
  pedidos: { etiqueta: 'Pedidos', formato: (v: number) => v.toLocaleString('en-US') },
  devolucion: { etiqueta: 'Devoluciones ($)', formato: (v: number) => `$${v.toLocaleString('en-US')}` },
  diasPago: { etiqueta: 'Días de pago promedio', formato: (v: number) => v.toFixed(1) },
  descuentoPct: { etiqueta: 'Descuento (%)', formato: (v: number) => `${v.toFixed(1)} %` },
} as const;
type Metrica = keyof typeof METRICAS;

/** Barras por año de la métrica elegida; el año en curso agrega la tendencia anualizada de venta en otro color (spec_reportes §4.2). */
export function GraficoEvolucionAnual({ datos, anioActual }: { datos: PuntoAnual[]; anioActual: number }) {
  const [metrica, setMetrica] = useState<Metrica>('venta');
  const m = METRICAS[metrica];
  const data = datos.map((d) => ({
    anio: d.anio, valor: d[metrica] ?? 0,
    tendencia: metrica === 'venta' && d.anio === anioActual ? Math.max(d.tendencia - d.venta, 0) : null,
  }));

  return (
    <div>
      <label className="mb-3 block text-sm">
        <span className="mb-1 block text-texto-2">Métrica</span>
        <select value={metrica} onChange={(e) => setMetrica(e.target.value as Metrica)} className="campo w-auto">
          {(Object.keys(METRICAS) as Metrica[]).map((k) => <option key={k} value={k}>{METRICAS[k].etiqueta}</option>)}
        </select>
      </label>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
          <XAxis dataKey="anio" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={{ stroke: '#ffffff1a' }} tickLine={false} />
          <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={70} tickFormatter={m.formato} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #ffffff1a', borderRadius: 8, fontSize: 13 }}
            labelStyle={{ color: '#f8fafc' }}
            formatter={(v, nombre) => [m.formato(Number(v)), nombre === 'tendencia' ? 'Tendencia anualizada' : m.etiqueta]} />
          <Bar dataKey="valor" name="valor" stackId="a" fill="#3b82f6" radius={metrica === 'venta' ? [0, 0, 0, 0] : [4, 4, 0, 0]} />
          <Bar dataKey="tendencia" name="tendencia" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
