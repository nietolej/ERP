import { Celda, Panel, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaRetencion } from '@/lib/compras/retenciones';

/** Retenciones de IVA e ISLR practicadas al contabilizar (spec §7.2 regla 4). Sin retenciones no muestra nada. */
export function TablaRetenciones({ filas, moneda }: { filas: FilaRetencion[]; moneda: string }) {
  if (filas.length === 0) return null;
  return (
    <Panel titulo="Retenciones practicadas" className="mt-5">
      <p className="mb-3 text-sm text-texto-2">
        La cuenta por pagar nació neta de estas retenciones, que quedan por enterar (2.1.04 IVA y 2.1.05 ISLR). El comprobante con su numeración llega con la Fase 4.
      </p>
      <Tabla columnas={['Impuesto', { t: `Base (${moneda})`, derecha: true }, { t: '%', derecha: true }, { t: 'Sustraendo', derecha: true }, { t: `Retenido (${moneda})`, derecha: true }, { t: 'Detalle' }]}>
        {filas.map((r) => (
          <tr key={r.impuesto}>
            <Celda>{r.impuesto === 'iva' ? 'IVA' : 'ISLR'}</Celda>
            <Celda derecha>{monto(r.base)}</Celda>
            <Celda derecha mono>{Number(r.porcentaje)} %</Celda>
            <Celda derecha>{Number(r.sustraendo) > 0 ? monto(r.sustraendo) : '—'}</Celda>
            <Celda derecha>{monto(r.monto)}</Celda>
            <Celda className="text-texto-2">{r.impuesto === 'iva' ? (r.iva_total ? 'Retención al 100 %' : 'Retención general') : `Concepto ${r.concepto}`}</Celda>
          </tr>
        ))}
      </Tabla>
    </Panel>
  );
}
