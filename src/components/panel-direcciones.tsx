import { actualizarDireccionAccion, crearDireccionAccion } from '@/app/(erp)/maestros/clientes/acciones-direcciones';
import { getDb } from '@/lib/db';
import {
  NOMBRE_DIA, listarDirecciones, puedeEditarDirecciones, resumenVentanas, type FilaDireccion,
} from '@/lib/maestros/direcciones';
import { BotonEnviar, Formulario } from './formulario';
import { Campo, Celda, Etiqueta, Panel, Tabla } from './ui';

/** Campos de una dirección de entrega con su horario de recepción. Sirve para crear y para editar. */
function CamposDireccion({ d }: { d?: FilaDireccion }) {
  const rango = (dia: number, n: number) => d?.ventanas.filter((v) => v.dia === dia)[n - 1];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} defaultValue={d?.nombre} placeholder="Sede principal" className="campo" /></Campo>
        <Campo etiqueta="Ciudad"><input name="ciudad" required maxLength={80} defaultValue={d?.ciudad} className="campo" /></Campo>
        <Campo etiqueta="Estado"><input name="entidad_federal" required maxLength={80} defaultValue={d?.entidad_federal} placeholder="Lara" className="campo" /></Campo>
        <div className="md:col-span-3">
          <Campo etiqueta="Dirección completa"><input name="direccion" required maxLength={250} defaultValue={d?.direccion} className="campo" /></Campo>
        </div>
        <Campo etiqueta="Coordenadas (latitud, longitud)" ayuda="Cópielas desde su aplicación de mapas (clic derecho sobre el punto). Vacío = sin ubicar.">
          <input name="coordenadas" defaultValue={d?.latitud ? `${d.latitud}, ${d.longitud}` : ''} placeholder="10.0678, -69.3467" className="campo font-mono" />
        </Campo>
        <Campo etiqueta="Persona de contacto"><input name="contacto_nombre" maxLength={80} defaultValue={d?.contacto_nombre ?? ''} className="campo" /></Campo>
        <Campo etiqueta="Teléfono de contacto"><input name="contacto_telefono" maxLength={40} defaultValue={d?.contacto_telefono ?? ''} className="campo" /></Campo>
        <Campo etiqueta="Minutos de descarga" ayuda="Tiempo que toma entregar en este punto.">
          <input name="minutos_descarga" type="number" min={1} max={480} defaultValue={d?.minutos_descarga ?? 15} className="campo text-right tabular-nums" />
        </Campo>
        <Campo etiqueta="Ventana de recepción" ayuda="Blanda: se intenta respetar y se avisa si no se logra. Dura: el cliente no recibe fuera de su horario.">
          <select name="ventana_tipo" defaultValue={d?.ventana_tipo ?? 'blanda'} className="campo">
            <option value="blanda">Blanda</option><option value="dura">Dura</option>
          </select>
        </Campo>
        <Campo etiqueta="Observaciones" ayuda="Restricciones del punto: tamaño del vehículo, acceso, etc.">
          <input name="observaciones" maxLength={250} defaultValue={d?.observaciones ?? ''} className="campo" />
        </Campo>
      </div>

      <div>
        <p className="mb-1 text-sm text-texto-2">Horario de recepción (hora de Caracas; hasta dos rangos por día, vacío = cualquier hora)</p>
        <div className="overflow-x-auto">
          <table className="text-sm">
            <tbody>
              {[1, 2, 3, 4, 5, 6, 7].map((dia) => (
                <tr key={dia}>
                  <td className="py-1 pr-3 text-texto-2">{NOMBRE_DIA[dia]}</td>
                  {[1, 2].map((n) => (
                    <td key={n} className="py-1 pr-4">
                      <input type="time" name={`v${dia}_${n}_desde`} defaultValue={rango(dia, n)?.desde ?? ''} aria-label={`${NOMBRE_DIA[dia]} desde ${n}`} className="campo !w-auto" />
                      <span className="px-1 text-texto-2">a</span>
                      <input type="time" name={`v${dia}_${n}_hasta`} defaultValue={rango(dia, n)?.hasta ?? ''} aria-label={`${NOMBRE_DIA[dia]} hasta ${n}`} className="campo !w-auto" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="predeterminada" defaultChecked={d?.predeterminada} /> Dirección predeterminada de entrega</label>
    </div>
  );
}

/** Direcciones de entrega de un cliente (§5.1). El llamador ya verificó que el usuario puede ver al cliente. */
export async function PanelDirecciones({ clienteId, usuario, className }: {
  clienteId: string; usuario: { id: string; roles: readonly string[] }; className?: string;
}) {
  const db = await getDb();
  const [direcciones, puedeEditar] = await Promise.all([
    listarDirecciones(db, clienteId),
    puedeEditarDirecciones(db, usuario, clienteId),
  ]);

  return (
    <Panel titulo="Direcciones de entrega" className={className}>
      <p className="mb-4 text-sm text-texto-2">Donde se despacha la mercancía. Una dirección sin ubicar puede despacharse a mano, pero no entra en la optimización de rutas.</p>
      <Tabla columnas={['Dirección', 'Ubicación', 'Horario de recepción', 'Estado', '']} vacio="Este cliente aún no tiene direcciones de entrega.">
        {direcciones.map((d) => (
          <tr key={d.id} className="align-top">
            <Celda>
              <span className="font-medium">{d.nombre}</span>
              {d.predeterminada && <span className="ml-2"><Etiqueta tono="info">predeterminada</Etiqueta></span>}
              <p className="text-xs text-texto-2">{d.direccion} · {d.ciudad}, {d.entidad_federal}</p>
              {d.contacto_nombre && <p className="text-xs text-texto-2">Contacto: {d.contacto_nombre}{d.contacto_telefono ? ` · ${d.contacto_telefono}` : ''}</p>}
              {d.observaciones && <p className="text-xs text-texto-2">{d.observaciones}</p>}
            </Celda>
            <Celda>
              {d.latitud
                ? <span className="font-mono text-xs">{Number(d.latitud).toFixed(5)}, {Number(d.longitud).toFixed(5)}</span>
                : <Etiqueta tono="advertencia">sin ubicar</Etiqueta>}
            </Celda>
            <Celda className="text-texto-2">
              {resumenVentanas(d.ventanas)}
              {d.ventanas.length > 0 && <span className="block text-xs">Ventana {d.ventana_tipo} · descarga {d.minutos_descarga} min</span>}
            </Celda>
            <Celda><Etiqueta tono={d.activa ? 'exito' : 'info'}>{d.activa ? 'activa' : 'inactiva'}</Etiqueta></Celda>
            <Celda>
              {puedeEditar && (
                <details>
                  <summary className="cursor-pointer text-xs text-acento hover:underline">Editar</summary>
                  <Formulario accion={actualizarDireccionAccion} className="mt-3 w-[min(56rem,80vw)] space-y-4">
                    <input type="hidden" name="id" value={d.id} />
                    <CamposDireccion d={d} />
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="activa" defaultChecked={d.activa} /> Dirección activa</label>
                    <BotonEnviar variante="secundario">Guardar dirección</BotonEnviar>
                  </Formulario>
                </details>
              )}
            </Celda>
          </tr>
        ))}
      </Tabla>

      {puedeEditar && (
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-semibold text-acento hover:underline">Nueva dirección de entrega</summary>
          <Formulario accion={crearDireccionAccion} className="mt-4 space-y-4">
            <input type="hidden" name="cliente_id" value={clienteId} />
            <CamposDireccion />
            <BotonEnviar>Registrar dirección</BotonEnviar>
          </Formulario>
        </details>
      )}
    </Panel>
  );
}
