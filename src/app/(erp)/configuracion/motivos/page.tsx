import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_TIPO_MOTIVO, ROLES_MOTIVOS, TIPOS_MOTIVO, listarMotivos } from '@/lib/maestros/motivos';
import { cambiarEstadoMotivoAccion, crearMotivoAccion } from './acciones';

export default async function MotivosPage() {
  await exigirRol(...ROLES_MOTIVOS);
  const motivos = await listarMotivos(await getDb());

  return (
    <>
      <Encabezado titulo="Motivos"
        descripcion="Catálogos para descuentos, devoluciones, anulaciones, ventas perdidas y mermas. Permiten contar y comparar las causas; un motivo no se borra, se inactiva." />
      <Panel titulo="Agregar un motivo">
        <Formulario accion={crearMotivoAccion} className="flex flex-wrap items-end gap-3">
          <Campo etiqueta="Catálogo">
            <select name="tipo" required defaultValue="" className="campo w-60">
              <option value="" disabled>Seleccione…</option>
              {TIPOS_MOTIVO.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_MOTIVO[t]}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Código" ayuda="Letras, números y guion bajo. No cambia después.">
            <input name="codigo" required maxLength={30} autoComplete="off" className="campo w-48 font-mono uppercase" placeholder="LIQUIDACION" />
          </Campo>
          <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} className="campo w-72" /></Campo>
          <BotonEnviar>Agregar</BotonEnviar>
        </Formulario>
      </Panel>

      {TIPOS_MOTIVO.map((tipo) => (
        <Panel key={tipo} titulo={NOMBRE_TIPO_MOTIVO[tipo]} className="mt-5">
          <Tabla columnas={['Código', 'Nombre', 'Uso', 'Estado', '']}>
            {motivos.filter((m) => m.tipo === tipo).map((m) => (
              <tr key={m.id}>
                <Celda mono>{m.codigo}</Celda>
                <Celda>{m.nombre}</Celda>
                <Celda className="text-texto-2">{m.sistema ? 'Lo usa el sistema' : '—'}</Celda>
                <Celda><Etiqueta tono={m.activo ? 'exito' : 'info'}>{m.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
                <Celda>
                  {!m.sistema && (
                    <Formulario accion={cambiarEstadoMotivoAccion}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="activo" value={m.activo ? 'false' : 'true'} />
                      <BotonEnviar variante="secundario">{m.activo ? 'Inactivar' : 'Reactivar'}</BotonEnviar>
                    </Formulario>
                  )}
                </Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      ))}
    </>
  );
}
