import { CLIENTE_VACIO, FormularioCliente } from '@/components/formulario-cliente';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { crearClienteAccion } from '../acciones';
import { opcionesComerciales } from '../datos';

export default async function NuevoClientePage() {
  await exigirRol('facturacion');
  const { sucursales, vendedores } = await opcionesComerciales(await getDb());
  return (
    <>
      <Encabezado titulo="Nuevo cliente"
        descripcion="Si el RIF ya existe como tercero (por ejemplo, es proveedor), el cliente se enlaza a él y se conservan sus datos." />
      <Panel>
        <FormularioCliente accion={crearClienteAccion} sucursales={sucursales} vendedores={vendedores} inicial={CLIENTE_VACIO} />
      </Panel>
    </>
  );
}
