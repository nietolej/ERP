import { GraficoEvolucionAnual } from '@/components/grafico-evolucion-anual';
import { GraficoTorta } from '@/components/grafico-torta';
import { Aviso, Celda, KpiCard, Panel, Tabla } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type { AnalisisHistoricoClientes, PartidaAbierta } from '@/lib/reportes/clientes';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Pestaña "Análisis total (histórico)" (spec_reportes §4.2). */
export function PanelHistorico({ h, partidas, anioActual }: { h: AnalisisHistoricoClientes; partidas: PartidaAbierta[]; anioActual: number }) {
  const { total } = h;
  return (
    <div className="space-y-5">
      <Panel titulo="Operaciones totales">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <KpiCard titulo="Venta" valor={monto(total.finanzasMetas.ventaTotalUsd, 'US$ ')} />
          <KpiCard titulo="Ítems" valor={total.volumenOperaciones.itemsVendidos} />
          <KpiCard titulo="Pedidos" valor={String(total.volumenOperaciones.pedidos)} />
          <KpiCard titulo="Ticket promedio" valor={monto(total.volumenOperaciones.ticketPromedioUsd, 'US$ ')} />
          <KpiCard titulo="Última compra" valor={total.volumenOperaciones.ultimaCompra ? fecha(total.volumenOperaciones.ultimaCompra) : '—'} />
        </div>
      </Panel>

      <Panel titulo="Devoluciones y calidad">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard titulo="Monto" valor={monto(total.devoluciones.montoUsd, 'US$ ')} subtitulo={`Índice: ${pct(total.devoluciones.indiceMontoPct)}`} />
          <KpiCard titulo="Ítems" valor={total.devoluciones.items} subtitulo={`Índice: ${pct(total.devoluciones.indiceItemsPct)}`} />
          <KpiCard titulo="Pedidos" valor={String(total.devoluciones.pedidos)} subtitulo={`Índice: ${pct(total.devoluciones.indicePedidosPct)}`} />
        </div>
      </Panel>

      <Panel titulo="Comportamiento de pago">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard titulo="Deuda actual" valor={monto(total.cobranzasCxC.deudaActualUsd, 'US$ ')} />
          <KpiCard titulo="Descuento ponderado" valor={monto(total.descuentos.totalUsd, 'US$ ')} subtitulo={pct(total.descuentos.totalPct)} />
          <KpiCard titulo="Días de pago" valor={total.cobranzasCxC.diasPagoPromedio === null ? 'Sin cobros' : total.cobranzasCxC.diasPagoPromedio.toFixed(1)} />
          <KpiCard titulo="Vencimiento CxC" valor={total.cobranzasCxC.vencimientoMasAntiguo ? fecha(total.cobranzasCxC.vencimientoMasAntiguo) : 'Sin partidas abiertas'} />
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Evolución anual">
          {h.porAnio.length === 0 ? <Aviso>No hay años con venta registrada.</Aviso> : (
            <GraficoEvolucionAnual anioActual={anioActual} datos={h.porAnio.map((a) => ({
              anio: a.anio, venta: Number(a.finanzasMetas.ventaTotalUsd), items: Number(a.volumenOperaciones.itemsVendidos),
              pedidos: a.volumenOperaciones.pedidos, devolucion: Number(a.devoluciones.montoUsd),
              diasPago: a.cobranzasCxC.diasPagoPromedio, descuentoPct: a.descuentos.totalPct, tendencia: Number(a.finanzasMetas.tendenciaUsd),
            }))} />
          )}
        </Panel>
        <Panel titulo="Porcentaje de pagos histórico (instrumento)">
          {total.pagosPorInstrumento.length === 0 ? <Aviso>Sin cobros registrados.</Aviso> : (
            <GraficoTorta datos={total.pagosPorInstrumento.map((p) => ({ nombre: p.instrumento, valor: Number(p.montoUsd) }))} />
          )}
        </Panel>
      </div>

      <Panel titulo="Matriz de indicadores por año">
        <Tabla columnas={['Año', { t: 'Ventas', derecha: true }, { t: 'Ítems', derecha: true }, { t: 'Pedidos', derecha: true },
          { t: 'Ticket promedio', derecha: true }, { t: 'Devoluciones ($)', derecha: true }, { t: 'Índice devolución', derecha: true },
          { t: 'Días de pago', derecha: true }, { t: 'Descuento (%)', derecha: true }]} vacio="No hay años con venta registrada.">
          {h.porAnio.map((a) => (
            <tr key={a.anio} className="hover:bg-white/[0.03]">
              <Celda mono>{a.anio}</Celda>
              <Celda derecha>{monto(a.finanzasMetas.ventaTotalUsd, 'US$ ')}</Celda>
              <Celda derecha mono>{a.volumenOperaciones.itemsVendidos}</Celda>
              <Celda derecha mono>{a.volumenOperaciones.pedidos}</Celda>
              <Celda derecha>{monto(a.volumenOperaciones.ticketPromedioUsd, 'US$ ')}</Celda>
              <Celda derecha>{monto(a.devoluciones.montoUsd, 'US$ ')}</Celda>
              <Celda derecha mono>{pct(a.devoluciones.indiceMontoPct)}</Celda>
              <Celda derecha mono>{a.cobranzasCxC.diasPagoPromedio === null ? '—' : a.cobranzasCxC.diasPagoPromedio.toFixed(1)}</Celda>
              <Celda derecha mono>{pct(a.descuentos.totalPct)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Panel titulo="Estado de cuenta (global)">
        <Tabla columnas={['Número', 'Emisión', { t: 'Monto original', derecha: true }, { t: 'Abonado', derecha: true },
          { t: 'Saldo', derecha: true }, 'Vencimiento', 'Mora']} vacio="No hay partidas abiertas.">
          {partidas.map((p) => (
            <tr key={p.numero} className="hover:bg-white/[0.03]">
              <Celda mono>{p.numero}</Celda>
              <Celda>{fecha(p.emision)}</Celda>
              <Celda derecha>{monto(p.montoOriginalUsd, 'US$ ')}</Celda>
              <Celda derecha>{monto(p.abonadoUsd, 'US$ ')}</Celda>
              <Celda derecha>{monto(p.saldoUsd, 'US$ ')}</Celda>
              <Celda>{fecha(p.vencimiento)}</Celda>
              <Celda className={p.mora.includes('vencido') ? 'text-peligro' : p.mora === 'Al día' ? 'text-exito' : ''}>{p.mora}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </div>
  );
}
