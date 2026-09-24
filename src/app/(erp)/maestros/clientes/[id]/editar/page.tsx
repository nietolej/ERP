import { notFound } from 'next/navigation';
import { FormularioCliente } from '@/components/formulario-cliente';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { actualizarClienteAccion } from '../../acciones';
import { UUID, opcionesComerciales } from '../../datos';

export default async function EditarClientePage({ params }: { params: Promise<{ id: string }> }) {
  await exigirRol('facturacion', 'gerencia');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();

  const { rows } = await db.query<{
    codigo: string; rif: string; razon_social: string; nombre_comercial: string | null; domiciliado: boolean;
    contribuyente_especial: boolean; agente_retencion_iva: boolean; direccion_fiscal: string | null;
    telefono: string | null; email: string | null; sucursal_id: string | null; vendedor_id: string | null; zona: string | null;
  }>(
    `select c.codigo, t.rif, t.razon_social, t.nombre_comercial, t.domiciliado, t.contribuyente_especial,
            t.agente_retencion_iva, t.direccion_fiscal, t.telefono, t.email, c.sucursal_id, c.vendedor_id, c.zona
       from cliente c join tercero t on t.id = c.tercero_id where c.tercero_id = $1`, [id]);
  const c = rows[0];
  if (!c) notFound();
  const { sucursales, vendedores } = await opcionesComerciales(db);

  return (
    <>
      <Encabezado titulo={`Editar ${c.codigo}`} descripcion={c.razon_social} />
      <Panel>
        <FormularioCliente accion={actualizarClienteAccion} sucursales={sucursales} vendedores={vendedores}
          inicial={{
            id, rif: c.rif, razonSocial: c.razon_social, nombreComercial: c.nombre_comercial ?? '',
            domiciliado: c.domiciliado, contribuyenteEspecial: c.contribuyente_especial,
            agenteRetencionIva: c.agente_retencion_iva, direccionFiscal: c.direccion_fiscal ?? '',
            telefono: c.telefono ?? '', email: c.email ?? '', sucursalId: c.sucursal_id ?? '',
            vendedorId: c.vendedor_id ?? '', zona: c.zona ?? '',
          }} />
      </Panel>
    </>
  );
}
