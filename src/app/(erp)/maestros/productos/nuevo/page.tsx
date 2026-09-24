import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { crearProductoAccion } from '../acciones';
import { CamposProducto, opcionesProducto } from '../datos';

export default async function NuevoProductoPage() {
  await exigirRol('almacen');
  const op = await opcionesProducto(await getDb(), hoyCaracas());
  return (
    <>
      <Encabezado titulo="Nuevo producto" descripcion="El código no se puede cambiar después. Los precios los fijan Gerencia o Supervisor de ventas." />
      <Panel>
        <Formulario accion={crearProductoAccion} className="space-y-5">
          <div className="max-w-xs">
            <Campo etiqueta="Código" ayuda="Número de parte o código interno: letras, números, guiones, puntos y barras.">
              <input name="codigo" required maxLength={30} autoComplete="off" className="campo font-mono uppercase" />
            </Campo>
          </div>
          <CamposProducto op={op} />
          <div className="flex justify-end"><BotonEnviar>Registrar producto</BotonEnviar></div>
        </Formulario>
      </Panel>
    </>
  );
}
