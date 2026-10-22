import { GraficoComparativaAnual } from '@/components/grafico-comparativa-anual';
import { TarjetaComparada } from '@/components/reportes/panel-comparacion';
import { Panel } from '@/components/ui';
import type { ComparativaMultianualProducto } from '@/lib/reportes/productos';

/** Pestaña "Comparativa multianual" del detalle de producto (spec_reportes §5.2). */
export function PanelComparativaProducto({ c }: { c: ComparativaMultianualProducto }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TarjetaComparada titulo="Venta" m={c.venta} simbolo="US$ " />
        <TarjetaComparada titulo="Cantidad" m={c.cantidad} />
        <TarjetaComparada titulo="Pedidos" m={c.pedidos} />
        <TarjetaComparada titulo="Devoluciones" m={c.devolucion} simbolo="US$ " />
      </div>
      <Panel titulo="Venta mensual, año contra año">
        <GraficoComparativaAnual anioA={c.anioA} anioB={c.anioB} datos={c.mensual.map((m) => ({ mes: m.mes, ventaA: Number(m.ventaA), ventaB: Number(m.ventaB) }))} />
      </Panel>
    </div>
  );
}
