import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha } from '@/lib/formato';
import { cambiarEstadoConceptoIslr, crearConceptoIslr } from './acciones';
import { cerrarTarifaIslr, crearTarifaIslr, validarTarifaIslr } from './acciones-tarifas';

export default async function ConceptosIslrPage() {
  const u = await exigirRol('contabilidad', 'jefe_contabilidad', 'compras', 'gerencia', 'auditor');
  const esContador = tieneRol(u, ['contabilidad']);
  const db = await getDb();
  const { rows } = await db.query<{ id: string; codigo: string; descripcion: string; activo: boolean; proveedores: number }>(
    `select c.id, c.codigo, c.descripcion, c.activo,
            (select count(*)::int from proveedor p where p.concepto_islr_id = c.id) as proveedores
       from concepto_islr c order by c.codigo`);
  const { rows: tarifas } = await db.query<{
    id: string; concepto: string; tipo_persona: string; domiciliado: boolean; porcentaje: string; base_minima_ut: string; sustraendo_ut: string;
    vigente_desde: string; vigente_hasta: string | null; validado_por_contador: boolean;
  }>(
    `select t.id, c.codigo as concepto, t.tipo_persona, t.domiciliado, t.porcentaje::text, t.base_minima_ut::text, t.sustraendo_ut::text,
            t.vigente_desde::text, t.vigente_hasta::text, t.validado_por_contador
       from concepto_islr_tarifa t join concepto_islr c on c.id = t.concepto_id
      order by c.codigo, t.tipo_persona, t.domiciliado desc, t.vigente_desde desc`);
  const sinValidar = tarifas.filter((t) => !t.validado_por_contador).length;

  return (
    <>
      <Encabezado titulo="Conceptos de ISLR" descripcion="Catálogo de conceptos del Decreto 1.808 que se asignan a los proveedores, y sus tarifas de retención." />
      <div className="mb-5">
        <Aviso tono="info">
          El catálogo y las tarifas (porcentaje, mínimo y sustraendo en Unidades Tributarias, con vigencia) los carga Contabilidad: no se
          precargan para no escribir normativa en el sistema. Un proveedor con concepto asignado no se contabiliza si su concepto no tiene
          tarifa vigente para su tipo de persona, y solo retiene la empresa marcada como agente de retención de ISLR.
        </Aviso>
      </div>
      <Panel titulo="Conceptos">
        <Tabla columnas={['Código', 'Descripción', { t: 'Proveedores', derecha: true }, 'Estado', esContador ? 'Acción' : '']}
          vacio="Aún no hay conceptos registrados.">
          {rows.map((c) => (
            <tr key={c.id}>
              <Celda mono>{c.codigo}</Celda>
              <Celda>{c.descripcion}</Celda>
              <Celda derecha>{c.proveedores}</Celda>
              <Celda><Etiqueta tono={c.activo ? 'exito' : 'info'}>{c.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
              <Celda>
                {esContador && (
                  <Formulario accion={cambiarEstadoConceptoIslr}>
                    <input type="hidden" name="id" value={c.id} />
                    <BotonEnviar variante="secundario">{c.activo ? 'Inactivar' : 'Reactivar'}</BotonEnviar>
                  </Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      {esContador && (
        <Panel titulo="Registrar concepto" className="mt-5">
          <Formulario accion={crearConceptoIslr} className="grid gap-3 md:grid-cols-[10rem_1fr_auto] md:items-end">
            <Campo etiqueta="Código"><input name="codigo" required maxLength={10} className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Descripción"><input name="descripcion" required maxLength={200} className="campo" /></Campo>
            <div><BotonEnviar>Registrar</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}

      <Panel titulo="Tarifas de retención" className="mt-5">
        {sinValidar > 0 && <div className="mb-3"><Aviso tono="advertencia">{sinValidar} tarifa(s) pendientes de validación por el contador.</Aviso></div>}
        <Tabla columnas={['Concepto', 'Persona', { t: '%', derecha: true }, { t: 'Mínimo (UT)', derecha: true }, { t: 'Sustraendo (UT)', derecha: true }, 'Vigencia', 'Estado', esContador ? 'Acción' : '']}
          vacio="Aún no hay tarifas cargadas: sin ellas no se contabiliza la factura de un proveedor con concepto de ISLR.">
          {tarifas.map((t) => (
            <tr key={t.id}>
              <Celda mono>{t.concepto}</Celda>
              <Celda>{t.tipo_persona === 'N' ? 'Natural' : 'Jurídica'} {t.domiciliado ? 'domiciliada' : 'no domiciliada'}</Celda>
              <Celda derecha mono>{Number(t.porcentaje)}</Celda>
              <Celda derecha mono>{Number(t.base_minima_ut)}</Celda>
              <Celda derecha mono>{Number(t.sustraendo_ut)}</Celda>
              <Celda>{fecha(t.vigente_desde)} → {t.vigente_hasta ? fecha(t.vigente_hasta) : 'vigente'}</Celda>
              <Celda><Etiqueta tono={t.validado_por_contador ? 'exito' : 'advertencia'}>{t.validado_por_contador ? 'validada' : 'sin validar'}</Etiqueta></Celda>
              <Celda>
                {esContador && (
                  <div className="flex flex-wrap gap-2">
                    {!t.validado_por_contador && (
                      <Formulario accion={validarTarifaIslr}><input type="hidden" name="id" value={t.id} /><BotonEnviar variante="secundario">Validar</BotonEnviar></Formulario>
                    )}
                    {!t.vigente_hasta && (
                      <Formulario accion={cerrarTarifaIslr} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={t.id} />
                        <input type="date" name="vigente_hasta" required aria-label="Rige hasta" className="campo w-40" />
                        <BotonEnviar variante="secundario">Cerrar</BotonEnviar>
                      </Formulario>
                    )}
                  </div>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      {esContador && rows.length > 0 && (
        <Panel titulo="Registrar tarifa" className="mt-5">
          <Formulario accion={crearTarifaIslr} className="grid gap-3 md:grid-cols-4 md:items-end">
            <Campo etiqueta="Concepto">
              <select name="concepto_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {rows.filter((c) => c.activo).map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.descripcion}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Tipo de persona">
              <select name="tipo_persona" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option><option value="J">Jurídica</option><option value="N">Natural</option>
              </select>
            </Campo>
            <Campo etiqueta="Domicilio">
              <select name="domiciliado" defaultValue="1" className="campo"><option value="1">Domiciliada</option><option value="0">No domiciliada</option></select>
            </Campo>
            <Campo etiqueta="Porcentaje (%)"><input name="porcentaje" required inputMode="decimal" className="campo text-right" /></Campo>
            <Campo etiqueta="Base mínima (UT)" ayuda="Por debajo no se retiene. Vacío = 0."><input name="base_minima_ut" inputMode="decimal" className="campo text-right" /></Campo>
            <Campo etiqueta="Sustraendo (UT)" ayuda="Se resta de la retención. Vacío = 0."><input name="sustraendo_ut" inputMode="decimal" className="campo text-right" /></Campo>
            <Campo etiqueta="Rige desde"><input type="date" name="vigente_desde" required className="campo" /></Campo>
            <Campo etiqueta="Fuente normativa"><input name="fuente_normativa" maxLength={200} className="campo" placeholder="Decreto 1.808, art. 9" /></Campo>
            <div className="md:col-span-4 flex justify-end"><BotonEnviar>Registrar tarifa</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
