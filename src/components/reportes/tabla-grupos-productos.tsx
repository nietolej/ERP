import { Celda, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaGrupoProducto } from '@/lib/reportes/productos';

/** Tabla "Análisis por grupos/familias" (spec_reportes §5.1): por categoría o por código común. */
export function TablaGruposProductos({ filas }: { filas: FilaGrupoProducto[] }) {
  return (
    <Tabla
      columnas={['Grupo', { t: 'Artículos', derecha: true }, { t: 'U. vend.', derecha: true }, { t: 'Venta ($)', derecha: true },
        { t: 'Dev. ($)', derecha: true }, { t: 'Stock valorizado', derecha: true }, 'Producto líder']}
      vacio="No hay productos para agrupar.">
      {filas.map((f) => (
        <tr key={f.id} className="hover:bg-white/[0.03]">
          <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.nombre}</span></Celda>
          <Celda derecha mono>{f.totalArticulos}</Celda>
          <Celda derecha mono>{f.unidadesVendidas}</Celda>
          <Celda derecha>{monto(f.ventaUsd, 'US$ ')}</Celda>
          <Celda derecha className={f.devolucionUsd !== '0.00' ? 'text-peligro' : ''}>{monto(f.devolucionUsd, 'US$ ')}</Celda>
          <Celda derecha className="text-texto-2">{monto(f.stockValorizadoUsd, 'US$ ')}</Celda>
          <Celda className="text-texto-2">{f.productoLider ? `${f.productoLider.codigo} · ${f.productoLider.descripcion}` : '—'}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}
