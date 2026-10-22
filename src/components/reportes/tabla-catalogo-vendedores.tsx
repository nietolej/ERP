import { Celda, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaCatalogoVendedor } from '@/lib/reportes/vendedores';

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)} %`);

/** Tabla del catálogo de vendedores (spec_reportes §6.1). */
export function TablaCatalogoVendedores({ filas }: { filas: FilaCatalogoVendedor[] }) {
  return (
    <Tabla
      columnas={['Código · Nombre · Contacto', { t: 'Atendidos', derecha: true }, { t: 'Facturas', derecha: true },
        { t: 'Cobertura', derecha: true }, { t: 'Top 3', derecha: true }, { t: 'Venta ($)', derecha: true },
        { t: 'Devoluciones', derecha: true }, { t: 'Cumplimiento meta', derecha: true }]}
      vacio="No hay vendedores que coincidan.">
      {filas.map((f) => (
        <tr key={f.id} className="hover:bg-white/[0.03]">
          <Celda><span className="font-mono">{f.codigo}</span> · {f.nombre}
            {f.contacto && <span className="block text-xs text-texto-2">{f.contacto}</span>}</Celda>
          <Celda derecha mono>{f.clientesAtendidos}</Celda>
          <Celda derecha mono>{f.facturas}</Celda>
          <Celda derecha mono>{pct(f.coberturaCarteraPct)}</Celda>
          <Celda derecha mono>{pct(f.concentracionTop3Pct)}</Celda>
          <Celda derecha>{monto(f.ventaTotalUsd, 'US$ ')}</Celda>
          <Celda derecha className={f.devolucionesPct !== null && f.devolucionesPct > 0 ? 'text-peligro' : ''}>{pct(f.devolucionesPct)}</Celda>
          <Celda derecha mono>{f.metaUsd === null ? 'Sin meta' : pct(f.cumplimientoMetaPct)}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}
