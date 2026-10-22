import { GraficoVentasMensuales } from '@/components/grafico-ventas';
import { Aviso, KpiCard, Panel } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { VistaGeneralVendedor } from '@/lib/reportes/vendedores';

const TONO_INSIGHT = { mora: 'peligro', deuda: 'advertencia', devolucion: 'peligro', tendencia: 'exito' } as const;
const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Pestaña "Vista general / anual" del detalle de vendedor (spec_reportes §6.2). */
export function PanelVistaGeneralVendedor({ v }: { v: VistaGeneralVendedor }) {
  return (
    <div className="space-y-5">
      {v.insight.tipo && <Aviso tono={TONO_INSIGHT[v.insight.tipo]}>{v.insight.mensaje}</Aviso>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard titulo="Venta total" valor={monto(v.ventaTotalUsd, 'US$ ')} />
        <KpiCard titulo="Facturas emitidas" valor={String(v.facturas)} />
        <KpiCard titulo="Clientes atendidos" valor={String(v.clientesAtendidos)} />
        <KpiCard titulo="Pedido promedio" valor={monto(v.pedidoPromedioUsd, 'US$ ')} />
        <KpiCard titulo="% cumplimiento meta" valor={v.metaUsd === null ? 'Sin meta' : pct(v.cumplimientoMetaPct)}
          tono={v.cumplimientoMetaPct !== null && v.cumplimientoMetaPct >= 100 ? 'exito' : undefined} />
        <KpiCard titulo="Tasa de devoluciones ($)" valor={pct(v.devolucionesPct)}
          tono={v.devolucionesPct !== null && v.devolucionesPct > 5 ? 'peligro' : undefined} />
      </div>

      <Panel titulo="Rendimiento comercial mensual vs. meta ($)">
        {v.mensual.every((m) => Number(m.ventaUsd) === 0) ? (
          <Aviso>No hay facturas registradas en el periodo seleccionado.</Aviso>
        ) : (
          <GraficoVentasMensuales datos={v.mensual.map((m) => ({
            anio: m.anio, mes: m.mes, venta: Number(m.ventaUsd), meta: m.metaUsd === null ? null : Number(m.metaUsd),
          }))} />
        )}
      </Panel>
    </div>
  );
}
