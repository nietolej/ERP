import Link from 'next/link';
import { GraficoTendenciaCobranza, GraficoTramos } from '@/components/grafico-cobranza';
import { Aviso, Celda, KpiCard, Panel, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { BaseAntiguedad, FilaAntiguedad, FilaVelocidad, PuntoTendenciaCobro, ResumenCobranza } from '@/lib/reportes/cobranzas';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);
const dias = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} días`);

/** Tarjetas principales de M4 (spec_reportes §7), comunes a todas las pestañas. */
export function TarjetasCobranza({ r }: { r: ResumenCobranza }) {
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard titulo="Total cobranza efectiva" valor={monto(r.cobradoUsd, 'US$ ')} subtitulo={`${r.pagos} pagos aplicados`} />
      <KpiCard titulo="Promedio días de pago (DSO)" valor={dias(r.diasPromedio)} subtitulo={`Mediana: ${dias(r.diasMediana)}`} />
      <KpiCard titulo="Cobranza a tiempo (≤30 días)" valor={pct(r.aTiempoPct)} tono={r.aTiempoPct !== null && r.aTiempoPct < 50 ? 'peligro' : undefined} />
      <KpiCard titulo="Efectividad de cobro" valor={pct(r.efectividadPct)}
        subtitulo={`Facturado ${monto(r.facturadoUsd, 'US$ ')} · pendiente ${monto(r.pendienteUsd, 'US$ ')}`} />
    </div>
  );
}

/** Pestaña "Resumen & velocidad de cobro" (spec_reportes §7). */
export function PanelCobranzaResumen({ velocidad, antiguedad, baseAntiguedad, tendencia, rutaBase }: {
  velocidad: FilaVelocidad[]; antiguedad: FilaAntiguedad[]; baseAntiguedad: BaseAntiguedad; tendencia: PuntoTendenciaCobro[]; rutaBase: string;
}) {
  const sinCobros = velocidad.every((v) => v.pagos === 0);
  const sinDeuda = antiguedad.every((a) => a.facturas === 0);
  return (
    <div className="space-y-5">
      <Panel titulo="Distribución de velocidad de cobro">
        {sinCobros ? <Aviso>No hay cobros aplicados en el periodo seleccionado.</Aviso> : (
          <>
            <GraficoTramos datos={velocidad.map((v) => ({ tramo: `${v.etiqueta} (${v.rango})`, monto: Number(v.montoUsd) }))} />
            <Tabla columnas={['Tramo', { t: 'Monto ($)', derecha: true }, { t: 'Pagos', derecha: true }, { t: '% del cobro', derecha: true }]}>
              {velocidad.map((v) => (
                <tr key={v.tramo}>
                  <Celda>{v.etiqueta} <span className="text-xs text-texto-2">({v.rango})</span></Celda>
                  <Celda derecha>{monto(v.montoUsd, 'US$ ')}</Celda>
                  <Celda derecha mono>{v.pagos}</Celda>
                  <Celda derecha mono>{pct(v.pct)}</Celda>
                </tr>
              ))}
            </Tabla>
          </>
        )}
      </Panel>

      <Panel titulo="Antigüedad de saldos">
        <p className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-texto-2">Contar días desde:</span>
          {(['vencimiento', 'emision'] as const).map((b) => (
            <Link key={b} href={`${rutaBase}&base=${b}`}
              className={b === baseAntiguedad ? 'font-semibold text-texto' : 'text-acento hover:underline'}>
              {b === 'vencimiento' ? 'El vencimiento (mora real)' : 'La emisión'}
            </Link>
          ))}
          <span className="text-xs text-texto-2">Deuda abierta a hoy; no depende del año elegido.</span>
        </p>
        {sinDeuda ? <Aviso>No hay deuda abierta.</Aviso> : (
          <>
            <GraficoTramos datos={antiguedad.map((a) => ({ tramo: a.tramo, monto: Number(a.montoUsd) }))} />
            <Tabla columnas={['Tramo', { t: 'Deuda ($)', derecha: true }, { t: 'Facturas', derecha: true }, { t: '% de la deuda', derecha: true }]}>
              {antiguedad.map((a) => (
                <tr key={a.tramo}>
                  <Celda>{a.tramo}</Celda>
                  <Celda derecha>{monto(a.montoUsd, 'US$ ')}</Celda>
                  <Celda derecha mono>{a.facturas}</Celda>
                  <Celda derecha mono>{pct(a.pct)}</Celda>
                </tr>
              ))}
            </Tabla>
          </>
        )}
      </Panel>

      <Panel titulo="Tendencia mensual">
        {tendencia.length === 0 ? <Aviso>No hay cobros aplicados en el periodo seleccionado.</Aviso> : (
          <GraficoTendenciaCobranza datos={tendencia.map((t) => ({ anio: t.anio, mes: t.mes, monto: Number(t.montoUsd), dias: t.diasPromedio }))} />
        )}
      </Panel>
    </div>
  );
}
