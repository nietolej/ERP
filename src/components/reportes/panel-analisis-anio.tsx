import { GraficoTorta } from '@/components/grafico-torta';
import { GraficoVentaDevolucion } from '@/components/grafico-venta-devolucion';
import { Aviso, Celda, KpiCard, Panel, Tabla } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type { AnalisisAnioClientes, TopItemCliente } from '@/lib/reportes/clientes';

const TONO_INSIGHT = { mora: 'peligro', deuda: 'advertencia', devolucion: 'peligro', tendencia: 'exito' } as const;
const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Pestaña "Análisis por año" de M1 Clientes (spec_reportes §4.1), compartida por la vista global y la de un cliente. */
export function PanelAnalisisAnio({ a, topCantidad, topMonto }: {
  a: AnalisisAnioClientes; topCantidad: TopItemCliente[]; topMonto: TopItemCliente[];
}) {
  return (
    <div className="space-y-5">
      {a.insight.tipo && <Aviso tono={TONO_INSIGHT[a.insight.tipo]}>{a.insight.mensaje}</Aviso>}

      <Panel titulo="Finanzas y metas">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard titulo="Venta total" valor={monto(a.finanzasMetas.ventaTotalUsd, 'US$ ')} />
          <KpiCard titulo="Tendencia de venta" valor={monto(a.finanzasMetas.tendenciaUsd, 'US$ ')} />
          <KpiCard titulo="Meta de venta" valor={a.finanzasMetas.metaUsd === null ? 'Sin meta cargada' : monto(a.finanzasMetas.metaUsd, 'US$ ')} />
          <KpiCard titulo="% cumplimiento tendencia" valor={pct(a.finanzasMetas.cumplimientoTendenciaPct)} />
        </div>
      </Panel>

      <Panel titulo="Volumen y operaciones">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard titulo="Pedidos de compra" valor={String(a.volumenOperaciones.pedidos)} />
          <KpiCard titulo="Pedido promedio" valor={monto(a.volumenOperaciones.ticketPromedioUsd, 'US$ ')} />
          <KpiCard titulo="Venta por cantidad de ítems" valor={a.volumenOperaciones.itemsVendidos} />
          <KpiCard titulo="Última compra" valor={a.volumenOperaciones.ultimaCompra ? fecha(a.volumenOperaciones.ultimaCompra) : '—'} />
        </div>
        {a.volumenOperaciones.porSucursal.length > 0 && (
          <Tabla columnas={['Sucursal', { t: 'Venta', derecha: true }, { t: 'Pedidos', derecha: true }, { t: 'Ticket promedio', derecha: true }]} className="mt-4">
            {a.volumenOperaciones.porSucursal.map((s) => (
              <tr key={s.sucursal} className="hover:bg-white/[0.03]">
                <Celda>{s.sucursal}</Celda>
                <Celda derecha mono>{monto(s.ventaUsd, 'US$ ')}</Celda>
                <Celda derecha mono>{s.pedidos}</Celda>
                <Celda derecha mono>{monto(s.ticketUsd, 'US$ ')}</Celda>
              </tr>
            ))}
          </Tabla>
        )}
      </Panel>

      <Panel titulo="Devoluciones">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard titulo="Devoluciones ($)" valor={monto(a.devoluciones.montoUsd, 'US$ ')} subtitulo={`Índice: ${pct(a.devoluciones.indiceMontoPct)}`} />
          <KpiCard titulo="Devoluciones (ítems)" valor={a.devoluciones.items} subtitulo={`Índice: ${pct(a.devoluciones.indiceItemsPct)}`} />
          <KpiCard titulo="Devoluciones (pedidos)" valor={String(a.devoluciones.pedidos)} subtitulo={`Índice: ${pct(a.devoluciones.indicePedidosPct)}`} />
        </div>
      </Panel>

      <Panel titulo="Cobranzas y CxC">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard titulo="Días de pago promedio" valor={a.cobranzasCxC.diasPagoPromedio === null ? 'Sin cobros' : a.cobranzasCxC.diasPagoPromedio.toFixed(1)} />
          <KpiCard titulo="Deuda actual (CxC)" valor={monto(a.cobranzasCxC.deudaActualUsd, 'US$ ')}
            subtitulo={`Emitida en el periodo: ${monto(a.cobranzasCxC.deudaEmitidaEnPeriodoUsd, 'US$ ')}`} />
          <KpiCard titulo="Vencimiento CxC" valor={a.cobranzasCxC.vencimientoMasAntiguo ? fecha(a.cobranzasCxC.vencimientoMasAntiguo) : 'Sin partidas abiertas'} />
        </div>
      </Panel>

      <Panel titulo="Descuentos">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard titulo="Descuento de factura" valor={monto(a.descuentos.facturaUsd, 'US$ ')} subtitulo={pct(a.descuentos.facturaPct)} />
          <KpiCard titulo="Descuento por pronto pago" valor={monto(a.descuentos.prontoPagoUsd, 'US$ ')} subtitulo={pct(a.descuentos.prontoPagoPct)} />
          <KpiCard titulo="Descuento total" valor={monto(a.descuentos.totalUsd, 'US$ ')} subtitulo={pct(a.descuentos.totalPct)} />
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Evolución mensual (ventas vs. devoluciones)">
          <GraficoVentaDevolucion datos={a.evolucionMensual.map((m) => ({ mes: m.mes, venta: Number(m.ventaUsd), devolucion: Number(m.devolucionUsd) }))} />
        </Panel>
        <Panel titulo="Porcentaje de pagos (instrumento)">
          {a.pagosPorInstrumento.length === 0 ? (
            <Aviso>Sin cobros registrados en el periodo.</Aviso>
          ) : (
            <GraficoTorta datos={a.pagosPorInstrumento.map((p) => ({ nombre: p.instrumento, valor: Number(p.montoUsd) }))} />
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <TablaTopItems titulo="Top ítems por cantidad" filas={topCantidad} />
        <TablaTopItems titulo="Top ítems por monto" filas={topMonto} />
      </div>
    </div>
  );
}

function TablaTopItems({ titulo, filas }: { titulo: string; filas: TopItemCliente[] }) {
  return (
    <Panel titulo={titulo}>
      <Tabla columnas={['Producto', 'Última venta', { t: 'Stock', derecha: true }, { t: 'Cantidad', derecha: true }, { t: 'Monto', derecha: true }]}
        vacio="No hay ventas en el periodo seleccionado.">
        {filas.map((f) => (
          <tr key={f.productoId} className="hover:bg-white/[0.03]">
            <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.descripcion}</span></Celda>
            <Celda className="text-texto-2">{f.ultimaVenta ? fecha(f.ultimaVenta) : '—'}</Celda>
            <Celda derecha mono>{f.stockComercial ?? '—'}</Celda>
            <Celda derecha mono>{f.cantidad}</Celda>
            <Celda derecha>{monto(f.montoUsd, 'US$ ')}</Celda>
          </tr>
        ))}
      </Tabla>
    </Panel>
  );
}
