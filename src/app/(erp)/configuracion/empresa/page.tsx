import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { crearSucursal, guardarEmpresa } from '../acciones';

interface Empresa {
  rif: string; razon_social: string; domicilio_fiscal: string | null; contribuyente_especial: boolean;
  agente_retencion_iva: boolean; agente_retencion_islr: boolean; agente_percepcion_igtf: boolean;
}

export default async function EmpresaPage() {
  await exigirRol('administrador');
  const db = await getDb();
  const empresa = (await db.query<Empresa>('select * from empresa')).rows[0];
  const sucursales = (await db.query<{ codigo: string; nombre: string; direccion: string | null; activa: boolean }>(
    'select codigo, nombre, direccion, activa from sucursal order by codigo')).rows;

  const casilla = (nombre: keyof Empresa, texto: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={nombre} defaultChecked={Boolean(empresa?.[nombre])} /> {texto}
    </label>
  );

  return (
    <>
      <Encabezado titulo="Empresa y sucursales" descripcion="Datos fiscales de la empresa (§4.2). La condición fiscal define retenciones e IGTF." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel titulo="Datos de la empresa">
          <Formulario accion={guardarEmpresa} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo etiqueta="RIF" ayuda="Formato J-12345678-9">
                <input name="rif" required defaultValue={empresa?.rif} className="campo" />
              </Campo>
              <Campo etiqueta="Razón social">
                <input name="razon_social" required defaultValue={empresa?.razon_social} className="campo" />
              </Campo>
            </div>
            <Campo etiqueta="Domicilio fiscal">
              <input name="domicilio_fiscal" defaultValue={empresa?.domicilio_fiscal ?? ''} className="campo" />
            </Campo>
            <fieldset className="space-y-2 rounded-lg border border-borde p-3">
              <legend className="px-1 text-xs text-texto-2">Condición fiscal (decisión 3: confirmar con el asesor tributario)</legend>
              {casilla('contribuyente_especial', 'Contribuyente especial')}
              {casilla('agente_retencion_iva', 'Agente de retención de IVA')}
              {casilla('agente_retencion_islr', 'Agente de retención de ISLR')}
              {casilla('agente_percepcion_igtf', 'Agente de percepción de IGTF')}
            </fieldset>
            <BotonEnviar>Guardar</BotonEnviar>
          </Formulario>
        </Panel>

        <Panel titulo="Sucursales">
          <Tabla columnas={['Código', 'Nombre', 'Dirección', 'Estado']} vacio="No hay sucursales registradas.">
            {sucursales.map((s) => (
              <tr key={s.codigo}>
                <Celda mono>{s.codigo}</Celda>
                <Celda>{s.nombre}</Celda>
                <Celda className="text-texto-2">{s.direccion ?? '—'}</Celda>
                <Celda>{s.activa ? 'Activa' : 'Inactiva'}</Celda>
              </tr>
            ))}
          </Tabla>
          <Formulario accion={crearSucursal} className="mt-5 grid gap-3 sm:grid-cols-[8rem_1fr]">
            <Campo etiqueta="Código"><input name="codigo" required placeholder="BQTO" className="campo" /></Campo>
            <Campo etiqueta="Nombre"><input name="nombre" required placeholder="Barquisimeto" className="campo" /></Campo>
            <div className="sm:col-span-2"><Campo etiqueta="Dirección"><input name="direccion" className="campo" /></Campo></div>
            <div><BotonEnviar variante="secundario">Agregar sucursal</BotonEnviar></div>
          </Formulario>
        </Panel>
      </div>
    </>
  );
}
