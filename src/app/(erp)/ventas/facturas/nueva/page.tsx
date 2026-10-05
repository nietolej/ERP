import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { ROLES_FACTURAN, notasPorFacturar } from '@/lib/ventas/facturas';
import { facturarAccion } from '../acciones';

export default async function NuevaFacturaPage() {
  const u = await exigirRol(...ROLES_FACTURAN);
  const notas = await notasPorFacturar(await getDb(), u);
  const porCliente = new Map<string, typeof notas>();
  for (const n of notas) porCliente.set(n.cliente_id, [...(porCliente.get(n.cliente_id) ?? []), n]);

  return (
    <>
      <Encabezado titulo="Facturar notas de entrega"
        descripcion="Notas despachadas que todavía no tienen factura. Se facturan juntas las notas de un mismo cliente, a la tasa BCV de hoy.">
        <Link href="/ventas/facturas" className="text-sm text-texto-2 hover:text-texto">← Facturas</Link>
      </Encabezado>
      {porCliente.size === 0 ? (
        <Aviso>No hay notas de entrega despachadas pendientes de facturar.</Aviso>
      ) : (
        [...porCliente.values()].map((grupo) => (
          <Panel key={grupo[0].cliente_id} titulo={`${grupo[0].cliente_codigo} · ${grupo[0].cliente}`} className="mb-5">
            <Formulario accion={facturarAccion} className="space-y-3">
              <ul className="divide-y divide-borde text-sm">
                {grupo.map((n) => (
                  <li key={n.id}>
                    <label className="flex items-center gap-3 py-2">
                      <input type="checkbox" name="notas" value={n.id} defaultChecked />
                      <Link href={`/ventas/notas-entrega/${n.id}`} className="font-mono text-acento hover:underline">Nota {n.numero}</Link>
                      <span className="text-texto-2">Despachada el {n.fecha}{n.pedido ? ` · pedido ${n.pedido}` : ''}</span>
                      <span className="ml-auto font-mono">{monto(n.total_usd, 'US$ ')}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-texto-2">El monto en USD es referencial: la factura sale en bolívares con los precios convertidos a la tasa del día de la emisión.</p>
              <BotonEnviar>Facturar las seleccionadas</BotonEnviar>
            </Formulario>
          </Panel>
        ))
      )}
    </>
  );
}
