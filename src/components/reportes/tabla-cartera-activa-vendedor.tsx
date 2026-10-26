import Link from 'next/link';
import { Celda, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { ClienteCarteraVendedor } from '@/lib/reportes/vendedores';

/** Pestaña "Cartera Activa" del detalle de vendedor (spec_reportes §6.2). */
export function TablaCarteraActivaVendedor({ filas }: { filas: ClienteCarteraVendedor[] }) {
  return (
    <Tabla columnas={['Código', 'Cliente', { t: 'Facturas', derecha: true }, { t: 'Monto vendido ($)', derecha: true }]}
      vacio="No hay clientes atendidos en el periodo seleccionado.">
      {filas.map((c) => (
        <tr key={c.clienteId} className="hover:bg-white/[0.03]">
          <Celda mono>{c.codigo}</Celda>
          <Celda><Link href={`/reportes/clientes/${c.codigo}`} className="text-acento hover:underline">{c.nombre}</Link></Celda>
          <Celda derecha mono>{c.facturas}</Celda>
          <Celda derecha>{monto(c.montoUsd, 'US$ ')}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}
