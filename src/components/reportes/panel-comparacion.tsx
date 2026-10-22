import { GraficoTorta } from '@/components/grafico-torta';
import { Aviso, Panel } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type { ComparacionPeriodos, MetricaComparada } from '@/lib/reportes/clientes';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);
const signo = (v: number) => (v > 0 ? '+' : '');

/** Pestaña "Comparación de periodos" (spec_reportes §4.3). */
export function PanelComparacion({ c }: { c: ComparacionPeriodos }) {
  return (
    <div className="space-y-5">
      <Panel>
        <p className="text-sm text-texto-2">
          Periodo A: <strong className="text-texto">{fecha(c.periodoA.desde)} – {fecha(c.periodoA.hasta)}</strong>
          {' '}· Periodo B: <strong className="text-texto">{fecha(c.periodoB.desde)} – {fecha(c.periodoB.hasta)}</strong>
        </p>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <TarjetaComparada titulo="Venta total" m={c.ventaTotal} simbolo="US$ " />
        <TarjetaComparada titulo="Cantidad de ítems" m={c.items} />
        <TarjetaComparada titulo="Pedidos" m={c.pedidos} />
        <TarjetaComparada titulo="Ticket promedio" m={c.ticketPromedio} simbolo="US$ " />
        <TarjetaComparada titulo="Devoluciones ($)" m={c.devolucionMonto} simbolo="US$ " />
        <TarjetaComparada titulo="Devoluciones (ítems)" m={c.devolucionItems} />
        <TarjetaComparada titulo="Devoluciones (pedidos)" m={c.devolucionPedidos} />
        <TarjetaSimple titulo="Índice de devolución" a={pct(c.indiceDevolucionMontoPct.a)} b={pct(c.indiceDevolucionMontoPct.b)} />
        <TarjetaComparada titulo="Descuento ponderado" m={c.descuentoPonderado} simbolo="US$ " />
        <TarjetaSimple titulo="Días de pago promedio" a={c.diasPagoPromedio.a === null ? 'Sin cobros' : c.diasPagoPromedio.a.toFixed(1)}
          b={c.diasPagoPromedio.b === null ? 'Sin cobros' : c.diasPagoPromedio.b.toFixed(1)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Porcentaje de pagos · Periodo A">
          {c.pagosA.length === 0 ? <Aviso>Sin cobros en el periodo A.</Aviso> :
            <GraficoTorta datos={c.pagosA.map((p) => ({ nombre: p.instrumento, valor: Number(p.montoUsd) }))} />}
        </Panel>
        <Panel titulo="Porcentaje de pagos · Periodo B">
          {c.pagosB.length === 0 ? <Aviso>Sin cobros en el periodo B.</Aviso> :
            <GraficoTorta datos={c.pagosB.map((p) => ({ nombre: p.instrumento, valor: Number(p.montoUsd) }))} />}
        </Panel>
      </div>

      <Panel titulo="Panel global">
        <div className="grid gap-4 sm:grid-cols-3">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-texto-2">Última compra</p>
            <p className="mt-1 text-lg font-bold">{c.global.ultimaCompra ? fecha(c.global.ultimaCompra) : '—'}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wider text-texto-2">Deuda actual</p>
            <p className="mt-1 text-lg font-bold">{monto(c.global.deudaActualUsd, 'US$ ')}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wider text-texto-2">Vencimiento CxC</p>
            <p className="mt-1 text-lg font-bold">{c.global.vencimientoMasAntiguo ? fecha(c.global.vencimientoMasAntiguo) : 'Sin partidas abiertas'}</p></div>
        </div>
      </Panel>
    </div>
  );
}

export function TarjetaComparada({ titulo, m, simbolo = '' }: { titulo: string; m: MetricaComparada; simbolo?: string }) {
  return (
    <div className="panel p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-texto-2">{titulo}</p>
      <div className="mt-2 flex items-baseline gap-4">
        <span title="Periodo A" className="text-lg font-bold tabular-nums">{simbolo}{m.a}</span>
        <span className="text-texto-2">→</span>
        <span title="Periodo B" className="text-lg font-bold tabular-nums">{simbolo}{m.b}</span>
      </div>
      <p className="mt-1 text-xs text-texto-2">{signo(Number(m.variacionAbsoluta))}{simbolo}{m.variacionAbsoluta} ({signo(m.variacionPct)}{m.variacionPct.toFixed(1)} %)</p>
    </div>
  );
}

function TarjetaSimple({ titulo, a, b }: { titulo: string; a: string; b: string }) {
  return (
    <div className="panel p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-texto-2">{titulo}</p>
      <div className="mt-2 flex items-baseline gap-4">
        <span title="Periodo A" className="text-lg font-bold tabular-nums">{a}</span>
        <span className="text-texto-2">→</span>
        <span title="Periodo B" className="text-lg font-bold tabular-nums">{b}</span>
      </div>
    </div>
  );
}
