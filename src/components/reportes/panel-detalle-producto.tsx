import Link from 'next/link';
import { GraficoVentaDevolucion } from '@/components/grafico-venta-devolucion';
import { Aviso, Celda, KpiCard, Panel, Tabla } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type { DetalleProductoAnio } from '@/lib/reportes/productos';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Pestaña "Vista general / anual" del detalle de producto (spec_reportes §5.2). */
export function PanelDetalleProducto({ d }: { d: DetalleProductoAnio }) {
  return (
    <div className="space-y-5">
      <Panel>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard titulo="Venta total" valor={monto(d.ventaTotalUsd, 'US$ ')} />
          <KpiCard titulo="Unidades vendidas" valor={d.unidadesVendidas} />
          <KpiCard titulo="Pedidos / facturas" valor={String(d.pedidos)} />
          <KpiCard titulo="Stock actual disponible" valor={d.stockDisponible} />
          <KpiCard titulo="Días de inventario" valor={d.diasInventario ?? 'Sin dato'} />
          <KpiCard titulo="Días sin inventario" valor={d.diasSinInventario === null ? 'Sin dato' : String(d.diasSinInventario)} />
          <KpiCard titulo="Tasa de devolución ($)" valor={pct(d.tasaDevolucionPct)}
            tono={d.tasaDevolucionPct !== null && d.tasaDevolucionPct > 0 ? 'advertencia' : undefined} />
        </div>
      </Panel>

      <Panel titulo="Ratios de devolución">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard titulo="En monto" valor={pct(d.ratiosDevolucion.montoPct)} />
          <KpiCard titulo="En cantidad" valor={pct(d.ratiosDevolucion.cantidadPct)} />
          <KpiCard titulo="En pedidos" valor={pct(d.ratiosDevolucion.pedidosPct)} />
        </div>
      </Panel>

      <Panel titulo="Tendencia de ventas mensuales (con devoluciones)">
        <GraficoVentaDevolucion datos={d.evolucionMensual.map((m) => ({ mes: m.mes, venta: Number(m.ventaUsd), devolucion: Number(m.devolucionUsd) }))} />
      </Panel>

      <Panel titulo="Top clientes compradores">
        <Tabla columnas={['Código', 'Cliente', { t: 'Cantidad', derecha: true }, { t: 'Monto', derecha: true }, { t: 'Compras', derecha: true }, 'Última compra']}
          vacio="No hay ventas en el periodo seleccionado.">
          {d.topClientes.map((c) => (
            <tr key={c.clienteId} className="hover:bg-white/[0.03]">
              <Celda mono>{c.codigo}</Celda>
              <Celda><Link href={`/reportes/clientes/${c.codigo}`} className="text-acento hover:underline">{c.razonSocial}</Link></Celda>
              <Celda derecha mono>{c.cantidad}</Celda>
              <Celda derecha>{monto(c.montoUsd, 'US$ ')}</Celda>
              <Celda derecha mono>{c.compras}</Celda>
              <Celda className="text-texto-2">{c.ultimaCompra ? fecha(c.ultimaCompra) : '—'}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Aviso>
        El panel de rotación e inventario (pendiente en tránsito y en producción), la comparativa multianual y el kardex
        de movimientos quedan para una próxima entrega.
      </Aviso>
    </div>
  );
}
