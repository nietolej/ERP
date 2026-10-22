import { Celda, KpiCard, Panel, Tabla } from '@/components/ui';
import { fecha, monto } from '@/lib/formato';
import type { EstadoCuentaDetalle } from '@/lib/reportes/clientes';

/** Pestaña "Estado de cuenta (detalle)" (spec_reportes §4.4, solo vista de cliente). */
export function PanelEstadoCuenta({ e }: { e: EstadoCuentaDetalle }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard titulo="Total cargos (debe)" valor={monto(e.totalCargosUsd, 'US$ ')} />
        <KpiCard titulo="Total abonos (haber)" valor={monto(e.totalAbonosUsd, 'US$ ')} />
        <KpiCard titulo="Saldo final del periodo" valor={monto(e.saldoFinalUsd, 'US$ ')} />
      </div>

      <Panel titulo="Movimientos del periodo">
        <Tabla columnas={['Fecha', 'Documento', 'Tipo / concepto', { t: 'Cargo', derecha: true }, { t: 'Abono', derecha: true }, { t: 'Saldo', derecha: true }]}
          vacio="No hay movimientos de CxC en el periodo seleccionado.">
          {e.movimientos.map((m, i) => (
            <tr key={`${m.documento}-${i}`} className="hover:bg-white/[0.03]">
              <Celda>{fecha(m.fecha)}</Celda>
              <Celda mono>{m.documento}</Celda>
              <Celda>{m.concepto}</Celda>
              <Celda derecha>{m.cargoUsd === '0.00' ? '—' : monto(m.cargoUsd, 'US$ ')}</Celda>
              <Celda derecha>{m.abonoUsd === '0.00' ? '—' : monto(m.abonoUsd, 'US$ ')}</Celda>
              <Celda derecha mono>{monto(m.saldoUsd, 'US$ ')}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </div>
  );
}
