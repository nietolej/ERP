import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { ROLES_VEN_VENTAS, buscarDocumentos, verTodosLosDocumentos } from '@/lib/ventas/pedidos';
import { etiquetaDocumento } from '@/lib/ventas/presentacion';

export default async function NotasEntregaPage() {
  const u = await exigirRol(...ROLES_VEN_VENTAS);
  const filas = await buscarDocumentos(await getDb(), u, 'nota_entrega', {});

  return (
    <>
      <Encabezado titulo="Notas de entrega"
        descripcion={`${verTodosLosDocumentos(u) ? 'Documentos en USD que respaldan lo despachado.' : 'Las notas de entrega de sus pedidos.'} Se generan desde un pedido aprobado.`} />
      <Panel>
        <Tabla columnas={['Nota', 'Fecha', 'Pedido', 'Cliente', 'Vendedor', 'Almacén', { t: 'Total (USD)', derecha: true }, 'Estado']}
          vacio="Todavía no hay notas de entrega.">
          {filas.map((n) => {
            const e = etiquetaDocumento(n.estado, n.situacion, 'nota_entrega');
            return (
              <tr key={n.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/ventas/notas-entrega/${n.id}`} className="text-acento hover:underline">{n.numero}</Link></Celda>
                <Celda className="text-texto-2">{n.fecha ?? '—'}</Celda>
                <Celda mono className="text-texto-2">{n.origen_numero ?? '—'}</Celda>
                <Celda>{n.cliente_codigo} · {n.cliente}</Celda>
                <Celda className="text-texto-2">{n.vendedor ?? '—'}</Celda>
                <Celda className="text-texto-2">{n.almacen}</Celda>
                <Celda derecha mono>{monto(n.total_usd, 'US$ ')}</Celda>
                <Celda><Etiqueta tono={e.tono}>{e.texto}</Etiqueta></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>
    </>
  );
}
