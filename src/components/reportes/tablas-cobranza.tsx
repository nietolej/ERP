import Link from 'next/link';
import { Celda, Etiqueta, Panel, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { BancosCanales, Comportamiento, FilaBancoCanal, FilaCobranzaCliente, FilaCobranzaVendedor } from '@/lib/reportes/cobranzas';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);
const dias = (v: number | null) => (v === null ? 'N/A' : v.toFixed(1));

/** Pestaña "Promedio por vendedor" (spec_reportes §7). */
export function TablaCobranzaVendedor({ filas }: { filas: FilaCobranzaVendedor[] }) {
  return (
    <Tabla columnas={['Vendedor', { t: 'Cobrado ($)', derecha: true }, { t: 'Cobros', derecha: true }, { t: 'Días prom.', derecha: true },
      { t: 'Mediana', derecha: true }, { t: '% a tiempo', derecha: true }, { t: '% mora (>30)', derecha: true }, { t: 'Deuda cartera ($)', derecha: true }]}
      vacio="No hay cobros aplicados en el periodo seleccionado.">
      {filas.map((f) => (
        <tr key={f.vendedorId} className="hover:bg-white/[0.03]">
          <Celda><Link href={`/reportes/vendedores/${f.codigo}`} className="text-acento hover:underline"><span className="font-mono">{f.codigo}</span> · {f.nombre}</Link></Celda>
          <Celda derecha>{monto(f.cobradoUsd, 'US$ ')}</Celda>
          <Celda derecha mono>{f.cobros}</Celda>
          <Celda derecha mono>{dias(f.diasPromedio)}</Celda>
          <Celda derecha mono>{dias(f.diasMediana)}</Celda>
          <Celda derecha mono>{pct(f.aTiempoPct)}</Celda>
          <Celda derecha mono>{pct(f.moraPct)}</Celda>
          <Celda derecha>{monto(f.deudaUsd, 'US$ ')}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}

const TONO: Record<Comportamiento, 'exito' | 'advertencia' | 'peligro' | 'info'> = {
  Puntual: 'exito', 'Mora leve': 'advertencia', 'Mora crítica': 'peligro', 'Sin cobros': 'info',
};

/** Pestaña "Promedio por cliente" (spec_reportes §7): filtros de búsqueda y categoría, con el estado en la URL. */
export function PanelCobranzaCliente({ filas, texto, categoria, anios }: {
  filas: FilaCobranzaCliente[]; texto: string; categoria: string; anios: number[];
}) {
  return (
    <>
      <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
        <input type="hidden" name="tab" value="cliente" />
        {anios.map((a) => <input key={a} type="hidden" name="anios" value={a} />)}
        <label className="block"><span className="mb-1 block text-texto-2">Buscar cliente</span>
          <input name="texto" defaultValue={texto} placeholder="Código o nombre" className="campo" /></label>
        <label className="block"><span className="mb-1 block text-texto-2">Categoría</span>
          <select name="categoria" defaultValue={categoria} className="campo">
            <option value="">Todas</option>
            <option value="puntual">Puntual (≤30 días)</option>
            <option value="mora_leve">Mora leve (31-60)</option>
            <option value="mora_critica">Mora crítica (&gt;60)</option>
            <option value="con_deuda">Con deuda pendiente</option>
          </select></label>
        <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
      </form>
      <Panel>
        <Tabla columnas={['Cliente', 'Asesor', { t: 'Cobrado ($)', derecha: true }, { t: 'Cobros', derecha: true }, { t: 'Días prom.', derecha: true },
          { t: 'Mediana', derecha: true }, { t: '% a tiempo', derecha: true }, { t: 'Deuda pendiente ($)', derecha: true }, 'Comportamiento']}
          vacio="No hay clientes que coincidan en el periodo seleccionado.">
          {filas.map((f) => (
            <tr key={f.clienteId} className="hover:bg-white/[0.03]">
              <Celda><Link href={`/reportes/clientes/${f.codigo}`} className="text-acento hover:underline"><span className="font-mono">{f.codigo}</span> · {f.nombre}</Link></Celda>
              <Celda>{f.asesor ?? '—'}</Celda>
              <Celda derecha>{monto(f.cobradoUsd, 'US$ ')}</Celda>
              <Celda derecha mono>{f.cobros}</Celda>
              <Celda derecha mono>{dias(f.diasPromedio)}</Celda>
              <Celda derecha mono>{dias(f.diasMediana)}</Celda>
              <Celda derecha mono>{pct(f.aTiempoPct)}</Celda>
              <Celda derecha>{monto(f.deudaUsd, 'US$ ')}</Celda>
              <Celda><Etiqueta tono={TONO[f.comportamiento]}>{f.comportamiento}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}

function TablaBancos({ filas, columna }: { filas: FilaBancoCanal[]; columna: string }) {
  return (
    <Tabla columnas={[columna, { t: 'Monto ($)', derecha: true }, { t: 'Transacciones', derecha: true }, { t: 'Participación', derecha: true }]}
      vacio="No hay cobros aplicados en el periodo seleccionado.">
      {filas.map((f) => (
        <tr key={f.nombre}>
          <Celda>{f.nombre}</Celda>
          <Celda derecha>{monto(f.montoUsd, 'US$ ')}</Celda>
          <Celda derecha mono>{f.transacciones}</Celda>
          <Celda derecha mono>{pct(f.participacionPct)}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}

/** Pestaña "Bancos & canales" (spec_reportes §7). */
export function PanelBancosCanales({ b }: { b: BancosCanales }) {
  return (
    <div className="space-y-5">
      <Panel titulo="Por cuenta bancaria"><TablaBancos filas={b.porCuenta} columna="Cuenta" /></Panel>
      <Panel titulo="Por canal de cobro (instrumento)"><TablaBancos filas={b.porInstrumento} columna="Instrumento" /></Panel>
    </div>
  );
}
