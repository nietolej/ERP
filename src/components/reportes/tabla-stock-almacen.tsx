import { Celda, Etiqueta, Tabla } from '@/components/ui';
import type { StockAlmacenProducto } from '@/lib/reportes/productos';

/** Tabla "Stock por almacén" del detalle de producto (spec_reportes §5.2). */
export function TablaStockAlmacen({ filas }: { filas: StockAlmacenProducto[] }) {
  return (
    <Tabla
      columnas={['Almacén', 'Sucursal', { t: 'Cantidad', derecha: true }, { t: 'Reservado', derecha: true }, { t: 'Disponible', derecha: true }, 'Vendible']}
      vacio="No hay almacenes activos.">
      {filas.map((f) => (
        <tr key={f.almacenId} className="hover:bg-white/[0.03]">
          <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.nombre}</span></Celda>
          <Celda className="text-texto-2">{f.sucursal}</Celda>
          <Celda derecha mono>{f.cantidad}</Celda>
          <Celda derecha mono>{f.reservado}</Celda>
          <Celda derecha mono>{f.disponible}</Celda>
          <Celda><Etiqueta tono={f.vendible ? 'exito' : 'info'}>{f.vendible ? 'Sí' : 'No'}</Etiqueta></Celda>
        </tr>
      ))}
    </Tabla>
  );
}
