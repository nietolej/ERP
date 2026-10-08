import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_REGISTRAN_FACTURA } from '@/lib/compras/facturas';
import { getDb } from '@/lib/db';
import { crearFacturaAccion } from '../../acciones';

export default async function NuevaFacturaCompraPage({ searchParams }: { searchParams: Promise<{ orden?: string }> }) {
  await exigirRol(...ROLES_REGISTRAN_FACTURA);
  const { orden = '' } = await searchParams;
  const db = await getDb();
  // Órdenes aprobadas con mercancía recibida que todavía no se ha facturado completa.
  const { rows: ordenes } = await db.query<{ id: string; texto: string }>(
    `select o.id, 'Orden ' || o.numero || ' · ' || p.codigo || ' · ' || o.moneda as texto
       from documento_compra o join proveedor p on p.tercero_id = o.proveedor_id
      where o.tipo = 'orden_compra' and o.estado = 'aprobada'
        and exists (select 1 from documento_compra_linea l where l.documento_id = o.id
                     and fn_orden_linea_recibida(l.id) > fn_orden_linea_facturada(l.id))
      order by o.numero desc`);
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });

  return (
    <>
      <Encabezado titulo="Registrar factura de proveedor"
        descripcion="Escoja la orden y escriba los datos tal como vienen en la factura; después indique lo facturado de cada producto.">
        <Link href="/compras/facturas" className="text-sm text-texto-2 hover:text-texto">← Facturas</Link>
      </Encabezado>
      <Panel>
        {ordenes.length === 0 ? (
          <Aviso tono="advertencia">No hay mercancía recibida pendiente de facturar. Primero reciba la mercancía contra una orden aprobada.</Aviso>
        ) : (
          <Formulario accion={crearFacturaAccion} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <Campo etiqueta="Orden de compra">
                  <select name="orden_id" required defaultValue={ordenes.some((o) => o.id === orden) ? orden : ''} className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {ordenes.map((o) => <option key={o.id} value={o.id}>{o.texto}</option>)}
                  </select>
                </Campo>
              </div>
              <Campo etiqueta="Número de factura"><input name="numero_factura" required maxLength={40} autoComplete="off" className="campo font-mono uppercase" /></Campo>
              <Campo etiqueta="Número de control"><input name="numero_control" required maxLength={40} autoComplete="off" className="campo font-mono uppercase" /></Campo>
              <Campo etiqueta="Fecha de la factura"><input type="date" name="fecha_factura" required max={hoy} defaultValue={hoy} className="campo" /></Campo>
              <Campo etiqueta="Vence (opcional)" ayuda="Si la deja vacía: fecha de la factura más los días de la condición de pago del proveedor.">
                <input type="date" name="fecha_vencimiento" className="campo" />
              </Campo>
            </div>
            <div className="flex justify-end"><BotonEnviar>Crear factura</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>
    </>
  );
}
