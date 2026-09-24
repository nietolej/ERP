import { FormularioVendedor } from '@/components/formulario-vendedor';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { crearVendedorAccion } from '../acciones';
import { TIPOS, opcionesVendedor } from '../datos';

export default async function NuevoVendedorPage() {
  await exigirRol('gerencia', 'supervisor_ventas');
  const { sucursales, usuarios } = await opcionesVendedor(await getDb());
  return (
    <>
      <Encabezado titulo="Nuevo vendedor" descripcion="El código (V001, V002…) lo asigna el sistema." />
      <Panel>
        <FormularioVendedor accion={crearVendedorAccion} sucursales={sucursales} usuarios={usuarios} tipos={TIPOS}
          inicial={{ nombre: '', tipo: 'interno', sucursalId: '', usuarioId: '', rif: '' }} />
      </Panel>
    </>
  );
}
