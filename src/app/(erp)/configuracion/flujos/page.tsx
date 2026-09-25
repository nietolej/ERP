import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { NOMBRE_ROL, ROLES } from '@/lib/auth/constantes';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { listarDefiniciones, OPERADORES, type PasoDefinicion } from '@/lib/flujo/flujo';
import { monto } from '@/lib/formato';
import { agregarPasoAccion, cambiarActivoFlujoAccion, quitarPasoAccion } from './acciones';

const condicion = (p: PasoDefinicion) =>
  p.condicion_campo ? `${p.condicion_campo} ${p.condicion_operador} ${monto(p.condicion_valor ?? '0')}` : 'Siempre';

export default async function FlujosPage() {
  const u = await exigirRol('administrador', 'gerencia', 'auditor');
  const puedeEditar = tieneRol(u, ['gerencia']);
  const definiciones = await listarDefiniciones(await getDb());

  return (
    <>
      <Encabezado titulo="Definición de flujos de aprobación"
        descripcion="Quién aprueba cada tipo de registro, en qué orden y con qué umbrales. Un cambio aplica a las solicitudes nuevas: las que ya están abiertas conservan sus pasos." />
      {!puedeEditar && <Aviso tono="info">Solo Gerencia modifica los flujos. Usted puede consultarlos.</Aviso>}

      <div className="space-y-5">
        {definiciones.map((d) => (
          <Panel key={d.id} titulo={`${d.nombre} · ${d.objeto_tipo}`}>
            <div className="mb-3 flex items-center gap-3 text-sm">
              <Etiqueta tono={d.activo ? 'exito' : 'peligro'}>{d.activo ? 'activo' : 'inactivo'}</Etiqueta>
              {!d.activo && <span className="text-texto-2">Mientras esté inactivo no se pueden crear solicitudes de este tipo.</span>}
              {puedeEditar && (
                <Formulario accion={cambiarActivoFlujoAccion}>
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="activo" value={d.activo ? '0' : '1'} />
                  <BotonEnviar variante="secundario">{d.activo ? 'Inactivar' : 'Activar'}</BotonEnviar>
                </Formulario>
              )}
            </div>
            <Tabla columnas={['Paso', 'Se aplica cuando', 'Aprueba', 'Quien solicita', 'Escalamiento', '']}>
              {d.pasos.map((p, i) => (
                <tr key={p.id}>
                  <Celda mono>{i + 1}</Celda>
                  <Celda mono>{condicion(p)}</Celda>
                  <Celda>{NOMBRE_ROL[p.rol_aprobador]}</Celda>
                  <Celda className="text-texto-2">{p.distinto_del_creador ? 'No puede aprobar' : 'Puede aprobar'}</Celda>
                  <Celda className="text-texto-2">
                    {p.horas_para_escalar && p.escalar_a_rol ? `A ${NOMBRE_ROL[p.escalar_a_rol]} tras ${p.horas_para_escalar} h` : '—'}
                  </Celda>
                  <Celda>
                    {puedeEditar && (
                      <Formulario accion={quitarPasoAccion}>
                        <input type="hidden" name="id" value={p.id} />
                        <BotonEnviar variante="peligro">Quitar</BotonEnviar>
                      </Formulario>
                    )}
                  </Celda>
                </tr>
              ))}
            </Tabla>

            {puedeEditar && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-acento hover:underline">Agregar un paso</summary>
                <Formulario accion={agregarPasoAccion} className="mt-3 grid gap-3 md:grid-cols-3">
                  <input type="hidden" name="definicion_id" value={d.id} />
                  <Campo etiqueta="Rol que aprueba">
                    <select name="rol" required defaultValue="" className="campo">
                      <option value="">Seleccione…</option>
                      {ROLES.map((r) => <option key={r} value={r}>{NOMBRE_ROL[r]}</option>)}
                    </select>
                  </Campo>
                  <Campo etiqueta="Condición: dato" ayuda="Vacío = el paso aplica siempre. Ej.: monto_usd">
                    <input name="condicion_campo" maxLength={40} placeholder="monto_usd" className="campo font-mono" />
                  </Campo>
                  <div className="grid grid-cols-2 gap-3">
                    <Campo etiqueta="Operador">
                      <select name="condicion_operador" defaultValue="" className="campo">
                        <option value="">—</option>
                        {OPERADORES.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </Campo>
                    <Campo etiqueta="Umbral"><input name="condicion_valor" inputMode="decimal" className="campo text-right font-mono" /></Campo>
                  </div>
                  <Campo etiqueta="Escalar tras (horas)"><input name="horas_para_escalar" inputMode="numeric" maxLength={5} className="campo" /></Campo>
                  <Campo etiqueta="Escalar al rol">
                    <select name="escalar_a_rol" defaultValue="" className="campo">
                      <option value="">—</option>
                      {ROLES.map((r) => <option key={r} value={r}>{NOMBRE_ROL[r]}</option>)}
                    </select>
                  </Campo>
                  <label className="flex items-center gap-2 self-end text-sm">
                    <input type="checkbox" name="distinto_del_creador" defaultChecked /> Quien solicita no puede aprobar
                  </label>
                  <div className="md:col-span-3"><BotonEnviar>Agregar paso</BotonEnviar></div>
                </Formulario>
              </details>
            )}
          </Panel>
        ))}
      </div>
    </>
  );
}
