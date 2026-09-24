'use client';

import { useState } from 'react';
import Decimal from 'decimal.js';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo } from '@/components/ui';
import type { EstadoAccion } from '@/lib/acciones';
import { monto } from '@/lib/formato';

export interface CuentaOpcion {
  id: string;
  codigo: string;
  nombre: string;
}

export interface LineaFormulario {
  cuentaId: string;
  debe: string;
  haber: string;
  glosa: string;
}

interface Props {
  accion: (estado: EstadoAccion, fd: FormData) => Promise<EstadoAccion>;
  cuentas: CuentaOpcion[];
  monedas: string[];
  inicial: { id?: string; fecha: string; descripcion: string; moneda: string; lineas: LineaFormulario[] };
}

const vacia = (): LineaFormulario => ({ cuentaId: '', debe: '', haber: '', glosa: '' });
const IMPORTE = /^\d{1,15}(\.\d{1,2})?$/;
const valor = (v: string) => (IMPORTE.test(v.trim()) ? new Decimal(v.trim()) : new Decimal(0));

/** Encabezado y líneas de un asiento manual, con totales y cuadre en vivo. */
export function FormularioAsiento({ accion, cuentas, monedas, inicial }: Props) {
  const [moneda, setMoneda] = useState(inicial.moneda);
  const [lineas, setLineas] = useState<LineaFormulario[]>(
    inicial.lineas.length >= 2 ? inicial.lineas : [vacia(), vacia()],
  );

  const cambiar = (i: number, campo: keyof LineaFormulario, v: string) =>
    setLineas((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      const nueva = { ...l, [campo]: v };
      // Una línea va al debe o al haber: escribir en uno limpia el otro.
      if (campo === 'debe' && v.trim()) nueva.haber = '';
      if (campo === 'haber' && v.trim()) nueva.debe = '';
      return nueva;
    }));

  const debe = lineas.reduce((s, l) => s.plus(valor(l.debe)), new Decimal(0));
  const haber = lineas.reduce((s, l) => s.plus(valor(l.haber)), new Decimal(0));
  const diferencia = debe.minus(haber);

  return (
    <Formulario accion={accion} className="space-y-5">
      {inicial.id && <input type="hidden" name="id" value={inicial.id} />}
      <input type="hidden" name="lineas" value={JSON.stringify(lineas)} />

      <div className="grid gap-4 sm:grid-cols-[10rem_1fr_8rem]">
        <Campo etiqueta="Fecha">
          <input type="date" name="fecha" defaultValue={inicial.fecha} required className="campo" />
        </Campo>
        <Campo etiqueta="Descripción">
          <input name="descripcion" defaultValue={inicial.descripcion} required maxLength={300} className="campo"
            placeholder="Ej.: Provisión de servicios de septiembre" />
        </Campo>
        <Campo etiqueta="Moneda" ayuda="Se convierte con la tasa BCV de la fecha.">
          <select name="moneda" value={moneda} onChange={(e) => setMoneda(e.target.value)} className="campo">
            {monedas.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Campo>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-borde text-left text-xs uppercase tracking-wider text-texto-2">
              <th className="px-2 py-2 font-semibold">Cuenta</th>
              <th className="px-2 py-2 font-semibold">Glosa</th>
              <th className="px-2 py-2 text-right font-semibold">Debe ({moneda})</th>
              <th className="px-2 py-2 text-right font-semibold">Haber ({moneda})</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-borde">
            {lineas.map((l, i) => (
              <tr key={i}>
                <td className="px-2 py-1.5">
                  <select value={l.cuentaId} onChange={(e) => cambiar(i, 'cuentaId', e.target.value)}
                    className="campo min-w-64" aria-label={`Cuenta de la línea ${i + 1}`}>
                    <option value="">Seleccione…</option>
                    {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.nombre}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input value={l.glosa} onChange={(e) => cambiar(i, 'glosa', e.target.value)} maxLength={200}
                    className="campo min-w-48" aria-label={`Glosa de la línea ${i + 1}`} />
                </td>
                <td className="px-2 py-1.5">
                  <input value={l.debe} onChange={(e) => cambiar(i, 'debe', e.target.value)} inputMode="decimal"
                    placeholder="0.00" className="campo w-32 text-right tabular-nums" aria-label={`Debe de la línea ${i + 1}`} />
                </td>
                <td className="px-2 py-1.5">
                  <input value={l.haber} onChange={(e) => cambiar(i, 'haber', e.target.value)} inputMode="decimal"
                    placeholder="0.00" className="campo w-32 text-right tabular-nums" aria-label={`Haber de la línea ${i + 1}`} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button type="button" disabled={lineas.length <= 2}
                    onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}
                    className="text-xs text-texto-2 hover:text-red-300 disabled:opacity-30">Quitar</button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-borde font-semibold">
              <td className="px-2 py-2">
                <button type="button" onClick={() => setLineas((ls) => [...ls, vacia()])}
                  className="text-sm text-acento hover:underline">+ Agregar línea</button>
              </td>
              <td className="px-2 py-2 text-right text-texto-2">Totales</td>
              <td className="px-2 py-2 text-right tabular-nums">{moneda} {monto(debe.toFixed(2))}</td>
              <td className="px-2 py-2 text-right tabular-nums">{moneda} {monto(haber.toFixed(2))}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={`text-sm ${diferencia.isZero() && !debe.isZero() ? 'text-emerald-300' : 'text-amber-300'}`}>
          {debe.isZero() ? 'Indique los importes de las líneas.'
            : diferencia.isZero() ? 'El asiento cuadra.'
            : `Diferencia: ${moneda} ${monto(diferencia.abs().toFixed(2))} ${diferencia.isPositive() ? 'más en el debe' : 'más en el haber'}.`}
        </p>
        <BotonEnviar>{inicial.id ? 'Guardar cambios' : 'Guardar borrador'}</BotonEnviar>
      </div>
    </Formulario>
  );
}
