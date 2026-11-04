import Link from 'next/link';
import { GraficoHistogramaPedidos, GraficoQuiebresMensuales } from '@/components/grafico-analisis';
import { Aviso, Celda, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type {
  FilaMorosidad, FilaQuiebreProducto, FilaVelocidadQuiebre, HistogramaPedidos, Morosidad, OrdenMorosidad, OrdenQuiebres, PuntoQuiebreMensual,
  VelocidadQuiebre,
} from '@/lib/reportes/analisis';

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} %`);
const num = (v: string | number, dec = 2) => Number(v).toLocaleString('es-VE', { maximumFractionDigits: dec });

/** §14.1: gráfico de barras y tabla por tramo de monto. */
export function PanelHistogramaPedidos({ h }: { h: HistogramaPedidos }) {
  return (
    <>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <KpiCard titulo="Pedidos (facturas)" valor={String(h.totalPedidos)} />
        <KpiCard titulo="Ancho del tramo" valor={monto(String(h.tramoUsd), 'US$ ')} subtitulo="Parámetro HISTOGRAMA_PEDIDOS_TRAMO_USD" />
        <KpiCard titulo="Tramo abierto desde" valor={monto(String(h.topeUsd), 'US$ ')} subtitulo="Parámetro HISTOGRAMA_PEDIDOS_TOPE_USD" />
      </div>
      <Panel titulo="Pedidos por tramo de monto" className="mb-5">
        {h.totalPedidos === 0 ? <Aviso>No hay pedidos en el periodo seleccionado.</Aviso> : (
          <GraficoHistogramaPedidos datos={h.filas.map((f) => ({ etiqueta: f.etiqueta, pedidos: f.pedidos }))} />
        )}
      </Panel>
      <Panel>
        <Tabla columnas={['Tramo', { t: 'Pedidos', derecha: true }, { t: '% del total', derecha: true }, { t: 'Monto total ($)', derecha: true },
          { t: 'Pedido promedio ($)', derecha: true }]} vacio="No hay pedidos en el periodo seleccionado.">
          {h.totalPedidos === 0 ? [] : h.filas.map((f) => (
            <tr key={f.indice} className="hover:bg-white/[0.03]">
              <Celda>{f.etiqueta}</Celda>
              <Celda derecha mono>{f.pedidos}</Celda>
              <Celda derecha mono>{pct(f.pct)}</Celda>
              <Celda derecha>{monto(f.montoUsd, 'US$ ')}</Celda>
              <Celda derecha>{f.promedioUsd === null ? '—' : monto(f.promedioUsd, 'US$ ')}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}

/** §14.2: matriz de tramo de monto × días de crédito, con las celdas de mora relevante resaltadas. */
export function PanelMorosidad({ m, orden, rutaBase }: { m: Morosidad; orden: OrdenMorosidad; rutaBase: string }) {
  const enlace = (o: OrdenMorosidad, texto: string) => (
    o === orden ? <strong>{texto}</strong> : <Link href={`${rutaBase}&orden=${o}`} className="text-acento hover:underline">{texto}</Link>
  );
  const marcadas = m.filas.filter((f: FilaMorosidad) => f.marcada).length;
  return (
    <Panel>
      <p className="mb-3 text-sm text-texto-2">
        Cada fila cruza el tramo de monto del pedido con los días de crédito que tenía la factura al emitirse. Se marcan las celdas con
        {' '}{m.umbralPct} % o más de facturas en mora (parámetro MOROSIDAD_PATRON_PCT){marcadas > 0 ? `: ${marcadas} en este periodo` : ''}.
        Los días de pago son el promedio ponderado por monto de lo ya cobrado.
      </p>
      <p className="mb-3 text-sm">Ordenar por: {enlace('tramo', 'Tramo y plazo')} · {enlace('mora', '% de mora')} · {enlace('dias', 'Días de pago')}</p>
      <Tabla columnas={['Tramo de monto', { t: 'Días de crédito', derecha: true }, { t: 'Facturas', derecha: true }, { t: 'Días de pago', derecha: true },
        { t: 'En mora', derecha: true }, { t: '% en mora', derecha: true }, { t: 'Deuda abierta ($)', derecha: true }]}
        vacio="No hay facturas en el periodo seleccionado.">
        {m.filas.map((f) => (
          <tr key={`${f.tramo}-${f.diasCredito}`} className={f.marcada ? 'bg-peligro/10' : 'hover:bg-white/[0.03]'}>
            <Celda>{f.etiqueta}</Celda>
            <Celda derecha mono>{f.diasCredito}</Celda>
            <Celda derecha mono>{f.facturas}</Celda>
            <Celda derecha mono>{f.diasPago === null ? '—' : num(f.diasPago, 1)}</Celda>
            <Celda derecha mono>{f.enMora}</Celda>
            <Celda derecha mono>{f.marcada ? <Etiqueta tono="peligro">{pct(f.moraPct)}</Etiqueta> : pct(f.moraPct)}</Celda>
            <Celda derecha>{monto(f.deudaUsd, 'US$ ')}</Celda>
          </tr>
        ))}
      </Tabla>
    </Panel>
  );
}

/** §14.3: velocidad antes y después de cada quiebre. */
export function PanelVelocidadQuiebre({ v }: { v: VelocidadQuiebre }) {
  return (
    <Panel>
      <p className="mb-3 text-sm text-texto-2">
        Velocidad = unidades vendidas ÷ día, en los {v.ventanaDias} días previos al quiebre y en los {v.ventanaDias} posteriores a la reposición
        (parámetro VENTANA_VELOCIDAD_QUIEBRE_DIAS). Sin reposición completa de la ventana no hay variación. Orden: variación descendente.
      </p>
      <Tabla columnas={['Producto', 'Almacén', 'Quiebre', 'Reposición', { t: 'Duración (días)', derecha: true }, { t: 'Vel. antes', derecha: true },
        { t: 'Vel. después', derecha: true }, { t: 'Variación', derecha: true }]} vacio="No hay episodios de quiebre en el periodo seleccionado.">
        {v.filas.map((f: FilaVelocidadQuiebre) => (
          <tr key={`${f.productoId}-${f.almacen}-${f.inicio}`} className="hover:bg-white/[0.03]">
            <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.descripcion}</span></Celda>
            <Celda>{f.almacen}</Celda>
            <Celda mono>{fecha(f.inicio)}</Celda>
            <Celda mono>{f.reposicion ? fecha(f.reposicion) : <Etiqueta tono="advertencia">En quiebre</Etiqueta>}</Celda>
            <Celda derecha mono>{f.duracionDias}</Celda>
            <Celda derecha mono>{num(f.velocidadAntes, 3)}</Celda>
            <Celda derecha mono>{f.velocidadDespues === null ? '—' : num(f.velocidadDespues, 3)}</Celda>
            <Celda derecha mono className={f.variacionPct !== null && f.variacionPct > 0 ? 'text-exito' : f.variacionPct !== null && f.variacionPct < 0 ? 'text-peligro' : ''}>
              {f.variacionPct === null ? '—' : `${f.variacionPct > 0 ? '+' : ''}${f.variacionPct.toFixed(1)} %`}
            </Celda>
          </tr>
        ))}
      </Tabla>
    </Panel>
  );
}

/** §14.4: quiebres por producto y episodios por mes. */
export function PanelQuiebres({ filas, meses, orden, rutaBase }: {
  filas: FilaQuiebreProducto[]; meses: PuntoQuiebreMensual[]; orden: OrdenQuiebres; rutaBase: string;
}) {
  const enlace = (o: OrdenQuiebres, texto: string) => (
    o === orden ? <strong>{texto}</strong> : <Link href={`${rutaBase}&orden=${o}`} className="text-acento hover:underline">{texto}</Link>
  );
  return (
    <>
      <Panel titulo="Episodios de quiebre por mes" className="mb-5">
        {meses.length === 0 ? <Aviso>No hay episodios de quiebre en el periodo seleccionado.</Aviso> : <GraficoQuiebresMensuales datos={meses} />}
      </Panel>
      <Panel>
        <p className="mb-3 text-sm text-texto-2">
          Un episodio es un tramo de días con existencia comercial en cero o menos que sigue a un periodo con existencia. La venta perdida es
          días del episodio × velocidad previa × precio de la lista A vigente.
        </p>
        <p className="mb-3 text-sm">Ordenar por: {enlace('episodios', 'Episodios')} · {enlace('duracion', 'Duración total')} · {enlace('venta_perdida', 'Venta perdida')}</p>
        <Tabla columnas={['Producto', { t: 'Episodios', derecha: true }, { t: 'Duración total (días)', derecha: true }, { t: 'Duración promedio (días)', derecha: true },
          { t: 'Venta perdida ($)', derecha: true }]} vacio="No hay episodios de quiebre en el periodo seleccionado.">
          {filas.map((f) => (
            <tr key={f.productoId} className="hover:bg-white/[0.03]">
              <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.descripcion}</span></Celda>
              <Celda derecha mono>{f.episodios}</Celda>
              <Celda derecha mono>{f.duracionTotalDias}</Celda>
              <Celda derecha mono>{num(f.duracionPromedioDias, 1)}</Celda>
              <Celda derecha>{monto(f.ventaPerdidaUsd, 'US$ ')}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
