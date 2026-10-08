import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_REGISTRAN_FACTURA } from '@/lib/compras/facturas';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { crearGastoAccion } from '../../acciones';
import { CamposGasto, opcionesGasto } from '../datos';

export default async function NuevoGastoPage() {
  await exigirRol(...ROLES_REGISTRAN_FACTURA);
  const hoy = hoyCaracas();
  const op = await opcionesGasto(await getDb(), hoy);
  return (
    <>
      <Encabezado titulo="Registrar gasto de importación"
        descripcion="Escriba los datos de la factura del proveedor de servicios y marque las recepciones a las que se aplica. Antes de registrarlo verá cómo se reparte.">
        <Link href="/compras/gastos" className="text-sm text-texto-2 hover:text-texto">← Gastos</Link>
      </Encabezado>
      <Panel>
        <Formulario accion={crearGastoAccion} className="space-y-5">
          <CamposGasto op={op} hoy={hoy} />
          <div className="flex justify-end"><BotonEnviar>Crear borrador</BotonEnviar></div>
        </Formulario>
      </Panel>
    </>
  );
}
