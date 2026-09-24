import { FormularioProveedor, PROVEEDOR_VACIO } from '@/components/formulario-proveedor';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { crearProveedorAccion } from '../acciones';
import { TIPOS, conceptosIslr } from '../datos';

export default async function NuevoProveedorPage() {
  await exigirRol('compras');
  const conceptos = await conceptosIslr(await getDb());
  return (
    <>
      <Encabezado titulo="Nuevo proveedor"
        descripcion="Queda pendiente hasta que Gerencia lo aprueba y le asigna la condición de pago. Si el RIF ya existe como tercero (por ejemplo, es cliente), se enlaza a él." />
      <Panel>
        <FormularioProveedor accion={crearProveedorAccion} modo="alta" tipos={TIPOS} conceptos={conceptos}
          inicial={PROVEEDOR_VACIO} boton="Registrar proveedor" />
      </Panel>
    </>
  );
}
