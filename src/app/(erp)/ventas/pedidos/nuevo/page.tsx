import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { buscarClientes } from '@/lib/maestros/clientes';
import { ROLES_VENDEN } from '@/lib/ventas/pedidos';
import { crearPedidoAccion } from '../../acciones';

export default async function NuevoPedidoPage() {
  const u = await exigirRol(...ROLES_VENDEN);
  const db = await getDb();
  const [clientes, almacenes] = await Promise.all([
    buscarClientes(db, u, { estado: 'activo' }, 1000),
    db.query<{ id: string; codigo: string; nombre: string }>(
      `select id, codigo, nombre from almacen where activo and permite_venta order by codigo`).then((r) => r.rows),
  ]);

  return (
    <>
      <Encabezado titulo="Nuevo pedido" descripcion="El precio sale de la lista del cliente; el número lo asigna el sistema al emitir.">
        <Link href="/ventas/pedidos" className="text-sm text-texto-2 hover:text-texto">← Pedidos</Link>
      </Encabezado>
      <Panel>
        {clientes.length === 0 ? (
          <Aviso tono="advertencia">No hay clientes activos a los que pueda venderles. Los clientes nuevos deben aprobarse primero.</Aviso>
        ) : almacenes.length === 0 ? (
          <Aviso tono="advertencia">No hay almacenes habilitados para vender. Gerencia puede crearlos en Almacenes.</Aviso>
        ) : (
          <Formulario accion={crearPedidoAccion} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo etiqueta="Cliente">
                <select name="cliente_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {clientes.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.razon_social}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Almacén">
                <select name="almacen_id" required defaultValue={almacenes.length === 1 ? almacenes[0].id : ''} className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {almacenes.map((a) => <option key={a.id} value={a.id}>{a.codigo} · {a.nombre}</option>)}
                </select>
              </Campo>
              <div className="sm:col-span-2">
                <Campo etiqueta="Observaciones">
                  <textarea name="observaciones" rows={2} maxLength={300} className="campo" />
                </Campo>
              </div>
            </div>
            <div className="flex justify-end"><BotonEnviar>Crear pedido</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>
    </>
  );
}
