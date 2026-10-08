import Link from 'next/link';
import { Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { buscarRecepciones } from '@/lib/compras/recepciones';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';

export default async function RecepcionesPage() {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const filas = await buscarRecepciones(await getDb(), u);
  return (
    <>
      <Encabezado titulo="Recepciones de mercancía"
        descripcion="Cada recepción entra al inventario al precio de su orden de compra y queda como mercancía recibida no facturada hasta que llegue la factura del proveedor." />
      <Panel>
        <Tabla columnas={['Recepción', 'Fecha', 'Orden de compra', 'Proveedor', 'Almacén', { t: 'Valor US$', derecha: true }]}
          vacio="Todavía no se ha recibido mercancía.">
          {filas.map((r) => (
            <tr key={r.id} className="hover:bg-white/[0.03]">
              <Celda mono>{r.numero}</Celda>
              <Celda className="text-texto-2">{r.fecha}</Celda>
              <Celda mono><Link href={`/compras/ordenes/${r.orden_id}`} className="text-acento hover:underline">{r.orden}</Link></Celda>
              <Celda>{r.proveedor}</Celda>
              <Celda className="text-texto-2">{r.almacen}</Celda>
              <Celda derecha mono>{monto(r.total_usd)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
