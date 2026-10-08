import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_COMPRAN } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { crearOrdenAccion } from '../../acciones';
import { CamposOrden, opcionesOrden } from '../datos';

export default async function NuevaOrdenPage() {
  await exigirRol(...ROLES_COMPRAN);
  const op = await opcionesOrden(await getDb());
  return (
    <>
      <Encabezado titulo="Nueva orden de compra"
        descripcion="Indique el proveedor, dónde se recibirá y cómo se repartirán los gastos de importación; después agregue los productos.">
        <Link href="/compras/ordenes" className="text-sm text-texto-2 hover:text-texto">← Órdenes</Link>
      </Encabezado>
      <Panel>
        <Formulario accion={crearOrdenAccion} className="space-y-5">
          <CamposOrden op={op} />
          <div className="flex justify-end"><BotonEnviar>Crear orden</BotonEnviar></div>
        </Formulario>
      </Panel>
    </>
  );
}
