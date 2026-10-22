import Link from 'next/link';
import { Celda, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaCatalogoProducto } from '@/lib/reportes/productos';

/** Tabla "Catálogo de artículos" (spec_reportes §5.1). El costo promedio se muestra aparte: nunca es "precio D". */
export function TablaCatalogoProductos({ filas }: { filas: FilaCatalogoProducto[] }) {
  return (
    <Tabla
      columnas={['Código · Descripción', 'Grupo / Marca', { t: 'Precio A', derecha: true }, { t: 'Precio D', derecha: true },
        { t: 'Costo prom.', derecha: true }, { t: 'Stock', derecha: true }, { t: 'U. vend.', derecha: true },
        { t: 'Monto ($)', derecha: true }, { t: 'Dev. ($)', derecha: true }]}
      vacio="No hay productos que coincidan.">
      {filas.map((f) => (
        <tr key={f.id} className="hover:bg-white/[0.03]">
          <Celda><Link href={`/reportes/productos/${f.codigo}`} className="font-mono text-acento hover:underline">{f.codigo}</Link>
            <span className="block text-xs text-texto-2">{f.descripcion}</span></Celda>
          <Celda className="text-texto-2">{f.grupo ?? '—'} / {f.marca ?? '—'}</Celda>
          <Celda derecha>{f.precioAUsd === null ? '—' : monto(f.precioAUsd, 'US$ ')}</Celda>
          <Celda derecha>{f.precioDUsd === null ? '—' : monto(f.precioDUsd, 'US$ ')}</Celda>
          <Celda derecha className="text-texto-2">{monto(f.costoPromedioUsd, 'US$ ')}</Celda>
          <Celda derecha mono>{f.stock}</Celda>
          <Celda derecha mono>{f.unidadesVendidas}</Celda>
          <Celda derecha>{monto(f.ventaUsd, 'US$ ')}</Celda>
          <Celda derecha className={f.devolucionUsd !== '0.00' ? 'text-peligro' : ''}>{monto(f.devolucionUsd, 'US$ ')}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}
