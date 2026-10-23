import { GraficoComparativaAnual } from '@/components/grafico-comparativa-anual';
import { TarjetaComparada } from '@/components/reportes/panel-comparacion';
import { Panel } from '@/components/ui';
import type { ComparativaMultianualVendedor } from '@/lib/reportes/vendedores';

/** Pestaña "Comparativa multianual" del detalle de vendedor (spec_reportes §6.2). */
export function PanelComparativaVendedor({ c }: { c: ComparativaMultianualVendedor }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TarjetaComparada titulo="Venta" m={c.venta} simbolo="US$ " />
        <TarjetaComparada titulo="Facturas" m={c.facturas} />
        <TarjetaComparada titulo="Clientes atendidos" m={c.clientesAtendidos} />
        <TarjetaComparada titulo="Devoluciones" m={c.devolucion} simbolo="US$ " />
      </div>
      <Panel titulo="Venta mensual, año contra año">
        <GraficoComparativaAnual anioA={c.anioA} anioB={c.anioB} datos={c.mensual.map((m) => ({ mes: m.mes, ventaA: Number(m.ventaA), ventaB: Number(m.ventaB) }))} />
      </Panel>
    </div>
  );
}
