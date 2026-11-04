import Link from 'next/link';
import { GraficoDevolucionesMensuales } from '@/components/grafico-devoluciones';
import { Aviso, Celda, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type {
  FilaDevolucionCliente, FilaDevolucionProducto, FilaDevolucionVendedor, NivelRiesgo, PuntoDevolucionMensual, ResumenDevoluciones,
} from '@/lib/reportes/devoluciones';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Tarjetas de M5 (spec_reportes §8), comunes a todas las pestañas. */
export function TarjetasDevoluciones({ r }: { r: ResumenDevoluciones }) {
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiCard titulo="Monto total devuelto" valor={monto(r.montoUsd, 'US$ ')} />
      <KpiCard titulo="Unidades devueltas" valor={Number(r.unidades).toLocaleString('es-VE', { maximumFractionDigits: 2 })} />
      <KpiCard titulo="Tasa de devolución financiera" valor={pct(r.tasaFinancieraPct)} tono={r.tasaSobreUmbral ? 'peligro' : undefined}
        subtitulo={`Devoluciones ÷ venta bruta · umbral ${r.umbralTasaPct} %`} />
      <KpiCard titulo="Facturas afectadas" valor={String(r.facturasAfectadas)} subtitulo={`${pct(r.facturasAfectadasPct)} de ${r.facturasTotal} facturas`} />
      {r.costoOperativoUsd !== null && <KpiCard titulo="Costo operativo estimado" valor={monto(r.costoOperativoUsd, 'US$ ')} />}
    </div>
  );
}

/** Pestaña "Resumen & tendencia mensual" (spec_reportes §8). */
export function PanelDevolucionesResumen({ serie }: { serie: PuntoDevolucionMensual[] }) {
  return (
    <Panel titulo="Venta vs. devoluciones por mes">
      {serie.length === 0 ? <Aviso>No hay ventas ni devoluciones en el periodo seleccionado.</Aviso> : (
        <GraficoDevolucionesMensuales datos={serie.map((s) => ({
          anio: s.anio, mes: s.mes, venta: Number(s.ventaUsd), devolucion: Number(s.devolucionUsd), pct: s.devueltoPct,
        }))} />
      )}
    </Panel>
  );
}

const TONO_RIESGO: Record<NivelRiesgo, 'peligro' | 'advertencia' | 'exito'> = { 'CRÍTICO': 'peligro', MODERADO: 'advertencia', NORMAL: 'exito' };

export function TablaDevolucionesCliente({ filas }: { filas: FilaDevolucionCliente[] }) {
  return (
    <Tabla columnas={['Cliente', { t: 'Venta ($)', derecha: true }, { t: 'Devuelto ($)', derecha: true }, { t: 'Unidades', derecha: true },
      { t: 'Facturas afectadas', derecha: true }, { t: '% devolución', derecha: true }, 'Riesgo']}
      vacio="No hay devoluciones en el periodo seleccionado.">
      {filas.map((f) => (
        <tr key={f.clienteId} className="hover:bg-white/[0.03]">
          <Celda><Link href={`/reportes/clientes/${f.codigo}`} className="text-acento hover:underline"><span className="font-mono">{f.codigo}</span> · {f.nombre}</Link></Celda>
          <Celda derecha>{monto(f.ventaUsd, 'US$ ')}</Celda>
          <Celda derecha>{monto(f.devueltoUsd, 'US$ ')}</Celda>
          <Celda derecha mono>{Number(f.unidades).toLocaleString('es-VE', { maximumFractionDigits: 2 })}</Celda>
          <Celda derecha mono>{f.facturasAfectadas}</Celda>
          <Celda derecha mono>{pct(f.devolucionPct)}</Celda>
          <Celda><Etiqueta tono={TONO_RIESGO[f.riesgo]}>{f.riesgo}</Etiqueta></Celda>
        </tr>
      ))}
    </Tabla>
  );
}

export function TablaDevolucionesVendedor({ filas }: { filas: FilaDevolucionVendedor[] }) {
  return (
    <Tabla columnas={['Vendedor', { t: 'Venta bruta ($)', derecha: true }, { t: 'Devuelto ($)', derecha: true }, { t: 'Venta neta ($)', derecha: true },
      { t: 'Facturas afectadas', derecha: true }, { t: '% devolución', derecha: true }]}
      vacio="No hay ventas en el periodo seleccionado.">
      {filas.map((f) => (
        <tr key={f.vendedorId} className="hover:bg-white/[0.03]">
          <Celda><Link href={`/reportes/vendedores/${f.codigo}`} className="text-acento hover:underline"><span className="font-mono">{f.codigo}</span> · {f.nombre}</Link></Celda>
          <Celda derecha>{monto(f.ventaBrutaUsd, 'US$ ')}</Celda>
          <Celda derecha>{monto(f.devueltoUsd, 'US$ ')}</Celda>
          <Celda derecha>{monto(f.ventaNetaUsd, 'US$ ')}</Celda>
          <Celda derecha mono>{f.facturasAfectadas}</Celda>
          <Celda derecha mono>{pct(f.devolucionPct)}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}

export function TablaDevolucionesProducto({ filas }: { filas: FilaDevolucionProducto[] }) {
  const num = (v: string) => Number(v).toLocaleString('es-VE', { maximumFractionDigits: 2 });
  return (
    <Tabla columnas={['Producto', 'Grupo', { t: 'Vendidas', derecha: true }, { t: 'Devueltas', derecha: true }, { t: 'Devuelto ($)', derecha: true },
      { t: '% en volumen', derecha: true }, 'Alerta']}
      vacio="No hay devoluciones en el periodo seleccionado.">
      {filas.map((f) => (
        <tr key={f.productoId} className="hover:bg-white/[0.03]">
          <Celda><Link href={`/reportes/productos/${f.codigo}`} className="text-acento hover:underline"><span className="font-mono">{f.codigo}</span> · {f.descripcion}</Link></Celda>
          <Celda>{f.grupo ?? '—'}</Celda>
          <Celda derecha mono>{num(f.unidadesVendidas)}</Celda>
          <Celda derecha mono>{num(f.unidadesDevueltas)}</Celda>
          <Celda derecha>{monto(f.devueltoUsd, 'US$ ')}</Celda>
          <Celda derecha mono>{pct(f.devolucionPct)}</Celda>
          <Celda>{f.alertaDefecto && <Etiqueta tono="peligro">ALERTA DEFECTO</Etiqueta>}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}
