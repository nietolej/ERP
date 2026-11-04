import Link from 'next/link';
import { Celda, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { ProductoVendidoVendedor } from '@/lib/reportes/vendedores';

/** Pestaña "Productos Vendidos" del detalle de vendedor (spec_reportes §6.2): los 30 productos principales. */
export function TablaProductosVendidosVendedor({ filas }: { filas: ProductoVendidoVendedor[] }) {
  return (
    <Tabla columnas={['Código', 'Descripción', { t: 'Unidades', derecha: true }, { t: 'Monto vendido ($)', derecha: true }]}
      vacio="No hay productos vendidos en el periodo seleccionado.">
      {filas.map((p) => (
        <tr key={p.productoId} className="hover:bg-white/[0.03]">
          <Celda mono>{p.codigo}</Celda>
          <Celda><Link href={`/reportes/productos/${p.codigo}`} className="text-acento hover:underline">{p.descripcion}</Link></Celda>
          <Celda derecha mono>{p.cantidad}</Celda>
          <Celda derecha>{monto(p.montoUsd, 'US$ ')}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}
