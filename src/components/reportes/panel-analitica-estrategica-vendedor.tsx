import { Celda, Etiqueta, KpiCard, Tabla } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type { AnaliticaEstrategicaVendedor } from '@/lib/reportes/vendedores';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Pestaña "Analítica estratégica & cartera dormida" del detalle de vendedor (spec_reportes §6.2). */
export function PanelAnaliticaEstrategicaVendedor({ a }: { a: AnaliticaEstrategicaVendedor }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard titulo="Cobertura de cartera" valor={pct(a.coberturaCarteraPct)} />
        <KpiCard titulo="Concentración top 3" valor={pct(a.concentracionTop3Pct)} />
        <KpiCard titulo="Venta cruzada" valor={a.ventaCruzada === null ? 'N/A' : `${a.ventaCruzada.toFixed(1)} grupos/factura`} />
        <KpiCard titulo="Tasa de fuga" valor={pct(a.tasaFugaPct)}
          tono={a.tasaFugaPct !== null && a.tasaFugaPct > 0 ? 'advertencia' : undefined} />
      </div>

      <Tabla
        columnas={['Código · Cliente', { t: 'Venta histórica ($)', derecha: true }, { t: 'Última compra', derecha: true },
          { t: 'Días sin comprar', derecha: true }, { t: 'Estado', derecha: true }]}
        vacio="No hay clientes asignados sin compras en el periodo.">
        {a.dormidos.map((d) => (
          <tr key={d.id} className="hover:bg-white/[0.03]">
            <Celda><span className="font-mono">{d.codigo}</span> · {d.nombre}</Celda>
            <Celda derecha>{monto(d.ventaHistoricaUsd, 'US$ ')}</Celda>
            <Celda derecha mono>{d.ultimaCompra ? fecha(d.ultimaCompra) : 'Sin compras'}</Celda>
            <Celda derecha mono>{d.diasSinComprar ?? '—'}</Celda>
            <Celda derecha>{d.enRiesgo ? <Etiqueta tono="peligro">En riesgo de fuga</Etiqueta> : <Etiqueta>Dormido</Etiqueta>}</Celda>
          </tr>
        ))}
      </Tabla>
    </div>
  );
}
