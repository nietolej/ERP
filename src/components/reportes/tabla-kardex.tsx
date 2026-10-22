import { Celda, Tabla } from '@/components/ui';
import { fechaHora } from '@/lib/formato';
import type { MovimientoKardex } from '@/lib/reportes/productos';

/** Tabla "Movimientos" (kardex) del detalle de producto (spec_reportes §5.2), en orden estricto por fecha y hora. */
export function TablaKardex({ filas }: { filas: MovimientoKardex[] }) {
  return (
    <Tabla
      columnas={['Fecha', 'Documento', 'Tipo', 'Almacén', { t: 'Cantidad', derecha: true }, { t: 'Stock almacén', derecha: true }, { t: 'Stock total', derecha: true }]}
      vacio="No hay movimientos de inventario para este producto.">
      {filas.map((f) => {
        const positiva = !f.cantidad.startsWith('-');
        return (
          <tr key={f.id} className="hover:bg-white/[0.03]">
            <Celda className="text-texto-2">{fechaHora(f.fecha)}</Celda>
            <Celda mono>{f.documento}</Celda>
            <Celda>{f.tipo}</Celda>
            <Celda mono>{f.almacenCodigo}</Celda>
            <Celda derecha mono className={positiva ? 'text-exito' : 'text-peligro'}>{positiva ? '+' : ''}{f.cantidad}</Celda>
            <Celda derecha mono>{f.stockAlmacen}</Celda>
            <Celda derecha mono>{f.stockTotal}</Celda>
          </tr>
        );
      })}
    </Tabla>
  );
}
