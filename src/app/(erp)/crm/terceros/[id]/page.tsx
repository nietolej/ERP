import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { listarCasos, NOMBRE_ESTADO_CASO, NOMBRE_TIPO_CASO } from '@/lib/crm/casos';
import { puedeVerTercero, ROLES_CRM, ROLES_VEN_CRM, soloLoSuyo, terceroCrm } from '@/lib/crm/comun';
import { contactosDe, listarActividades, NOMBRE_ACTIVIDAD, TIPOS_ACTIVIDAD } from '@/lib/crm/contactos';
import { listarCotizaciones } from '@/lib/crm/cotizaciones';
import { listarOportunidades, NOMBRE_ETAPA } from '@/lib/crm/oportunidades';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { crearOportunidadAccion, estadoProspectoAccion, guardarContactoAccion, registrarActividadAccion } from '../../acciones';

/** Ficha de CRM de un cliente o prospecto: contactos, oportunidades, cotizaciones, actividades y casos. */
export default async function FichaCrmPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const { id } = await params;
  const db = await getDb();
  const t = await terceroCrm(db, id);
  if (!t || !puedeVerTercero(u, t)) notFound();
  const trabaja = tieneRol(u, [...ROLES_CRM]);
  const activo = (t.es_cliente && t.cliente_estado === 'activo') || (!t.es_cliente && t.prospecto_estado === 'activo');
  const [contactos, oportunidades, cotizaciones, actividades, casos, vendedores] = await Promise.all([
    contactosDe(db, id), listarOportunidades(db, u, { terceroId: id }), listarCotizaciones(db, u, { terceroId: id }),
    listarActividades(db, u, { terceroId: id }, 50), t.es_cliente ? listarCasos(db, u, { clienteId: id }) : Promise.resolve([]),
    trabaja && !soloLoSuyo(u)
      ? db.query<{ id: string; nombre: string }>(`select id, codigo || ' · ' || nombre as nombre from vendedor where estado = 'activo' order by codigo`).then((r) => r.rows)
      : Promise.resolve([]),
  ]);
  const abiertas = oportunidades.filter((o) => !o.cerrada);

  return (
    <>
      <Encabezado titulo={t.razon_social} descripcion={`${t.rif} · ${t.es_cliente ? `Cliente ${t.cliente_codigo}` : 'Prospecto'} · Vendedor: ${t.vendedor ?? '—'}`}>
        <div className="flex items-center gap-3">
          {t.es_cliente
            ? <Etiqueta tono={t.cliente_estado === 'activo' ? 'exito' : 'advertencia'}>{t.cliente_estado === 'pendiente' ? 'Cliente pendiente de aprobación' : `Cliente ${t.cliente_estado}`}</Etiqueta>
            : <Etiqueta tono={t.prospecto_estado === 'activo' ? 'info' : 'peligro'}>{t.prospecto_estado === 'activo' ? 'Prospecto activo' : 'Prospecto descartado'}</Etiqueta>}
          <Link href={t.es_cliente ? `/maestros/clientes/${id}` : '/crm/prospectos'} className="text-sm text-texto-2 hover:text-texto">
            {t.es_cliente ? 'Ficha del cliente →' : '← Prospectos'}
          </Link>
        </div>
      </Encabezado>

      {trabaja && !t.es_cliente && (
        <Panel titulo="Prospecto" className="mb-5">
          <div className="grid gap-4 md:grid-cols-2">
            {t.prospecto_estado === 'activo' ? (
              <Formulario accion={estadoProspectoAccion} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="accion" value="descartar" />
                <Campo etiqueta="Descartar el prospecto (motivo)"><input name="motivo" required className="campo" /></Campo>
                <BotonEnviar variante="peligro">Descartar</BotonEnviar>
              </Formulario>
            ) : (
              <Formulario accion={estadoProspectoAccion}>
                <input type="hidden" name="id" value={id} /><input type="hidden" name="accion" value="reactivar" />
                <BotonEnviar variante="secundario">Reactivar el prospecto</BotonEnviar>
              </Formulario>
            )}
            {vendedores.length > 0 && t.prospecto_estado === 'activo' && (
              <Formulario accion={estadoProspectoAccion} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="accion" value="reasignar" />
                <Campo etiqueta="Reasignar a otro vendedor">
                  <select name="vendedor_id" defaultValue={t.vendedor_id ?? ''} className="campo">
                    {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
                  </select>
                </Campo>
                <BotonEnviar variante="secundario">Reasignar</BotonEnviar>
              </Formulario>
            )}
          </div>
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo={`Contactos (${contactos.filter((c) => c.activo).length})`}>
          <Tabla columnas={['Nombre', 'Cargo', 'Teléfono', 'Correo', '']} vacio="Sin contactos registrados.">
            {contactos.map((c) => (
              <tr key={c.id} className={c.activo ? '' : 'opacity-50'}>
                <Celda>{c.nombre} {c.principal && <Etiqueta>Principal</Etiqueta>}</Celda>
                <Celda className="text-texto-2">{c.cargo ?? '—'}</Celda>
                <Celda className="text-texto-2">{c.telefono ?? '—'}</Celda>
                <Celda className="text-texto-2">{c.correo ?? '—'}</Celda>
                <Celda>
                  {trabaja && (
                    <details>
                      <summary className="cursor-pointer text-xs text-acento">Editar</summary>
                      <Formulario accion={guardarContactoAccion} className="mt-2 grid gap-2">
                        <input type="hidden" name="id" value={c.id} /><input type="hidden" name="tercero_id" value={id} />
                        <input name="nombre" defaultValue={c.nombre} required className="campo" />
                        <input name="cargo" defaultValue={c.cargo ?? ''} placeholder="Cargo" className="campo" />
                        <input name="telefono" defaultValue={c.telefono ?? ''} placeholder="Teléfono" className="campo" />
                        <input name="correo" defaultValue={c.correo ?? ''} placeholder="Correo" className="campo" />
                        <label className="text-xs text-texto-2"><input type="checkbox" name="principal" defaultChecked={c.principal} /> Principal</label>
                        <label className="text-xs text-texto-2"><input type="checkbox" name="activo" defaultChecked={c.activo} /> Activo</label>
                        <BotonEnviar variante="secundario">Guardar</BotonEnviar>
                      </Formulario>
                    </details>
                  )}
                </Celda>
              </tr>
            ))}
          </Tabla>
          {trabaja && (
            <Formulario accion={guardarContactoAccion} className="mt-4 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="tercero_id" value={id} />
              <Campo etiqueta="Nombre"><input name="nombre" required className="campo" /></Campo>
              <Campo etiqueta="Cargo"><input name="cargo" className="campo" /></Campo>
              <Campo etiqueta="Teléfono"><input name="telefono" className="campo" autoComplete="off" /></Campo>
              <Campo etiqueta="Correo"><input name="correo" type="email" className="campo" autoComplete="off" /></Campo>
              <label className="flex items-center gap-2 text-sm text-texto-2"><input type="checkbox" name="principal" /> Contacto principal</label>
              <div className="flex justify-end"><BotonEnviar variante="secundario">Agregar contacto</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>

        <Panel titulo={`Oportunidades (${abiertas.length} abiertas)`}>
          <Tabla columnas={['Oportunidad', 'Etapa', { t: 'Monto US$', derecha: true }, 'Cierre estimado']} vacio="Sin oportunidades.">
            {oportunidades.map((o) => (
              <tr key={o.id}>
                <Celda><Link href={`/crm/oportunidades/${o.id}`} className="text-acento hover:underline">{o.titulo}</Link></Celda>
                <Celda><Etiqueta tono={o.etapa === 'ganada' ? 'exito' : o.etapa === 'perdida' ? 'peligro' : 'info'}>{NOMBRE_ETAPA[o.etapa]}</Etiqueta></Celda>
                <Celda derecha mono>{monto(o.monto_estimado_usd)}</Celda>
                <Celda className="text-texto-2">{o.cerrada ? `Cerrada ${o.cerrada}` : o.cierre_estimado ?? '—'}</Celda>
              </tr>
            ))}
          </Tabla>
          {trabaja && activo && (
            <Formulario accion={crearOportunidadAccion} className="mt-4 grid gap-3 sm:grid-cols-3">
              <input type="hidden" name="tercero_id" value={id} />
              <div className="sm:col-span-3"><Campo etiqueta="Nueva oportunidad"><input name="titulo" required placeholder="Qué se le quiere vender" className="campo" /></Campo></div>
              <Campo etiqueta="Monto estimado US$"><input name="monto" inputMode="decimal" defaultValue="0" className="campo" /></Campo>
              <Campo etiqueta="Cierre estimado"><input name="cierre" type="date" className="campo" /></Campo>
              <div className="flex items-end justify-end"><BotonEnviar variante="secundario">Crear</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>

        <Panel titulo="Cotizaciones">
          <Tabla columnas={['Número', 'Emitida', 'Vigente hasta', { t: 'Total US$', derecha: true }, 'Estado']} vacio="Sin cotizaciones.">
            {cotizaciones.map((q) => (
              <tr key={q.id}>
                <Celda mono><Link href={`/crm/cotizaciones/${q.id}`} className="text-acento hover:underline">{q.numero ?? 'Borrador'}</Link></Celda>
                <Celda className="text-texto-2">{q.fecha ?? '—'}</Celda>
                <Celda className="text-texto-2">{q.vigente_hasta ?? '—'}</Celda>
                <Celda derecha mono>{monto(q.total)}</Celda>
                <Celda>{q.vencida ? <Etiqueta tono="advertencia">Vencida</Etiqueta> : q.estado}</Celda>
              </tr>
            ))}
          </Tabla>
          {trabaja && activo && (
            <div className="mt-4 flex justify-end">
              <Link href={`/crm/cotizaciones?tercero=${id}`} className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Nueva cotización</Link>
            </div>
          )}
        </Panel>

        <Panel titulo="Actividades">
          {trabaja && (
            <Formulario accion={registrarActividadAccion} className="mb-4 grid gap-3 sm:grid-cols-3">
              <input type="hidden" name="tercero_id" value={id} />
              <Campo etiqueta="Tipo">
                <select name="tipo" required defaultValue="visita" className="campo">
                  {TIPOS_ACTIVIDAD.map((x) => <option key={x} value={x}>{NOMBRE_ACTIVIDAD[x]}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Fecha y hora" ayuda="Vacío: ahora."><input name="fecha" type="datetime-local" className="campo" /></Campo>
              <Campo etiqueta="Oportunidad">
                <select name="oportunidad_id" defaultValue="" className="campo">
                  <option value="">Ninguna</option>
                  {abiertas.map((o) => <option key={o.id} value={o.id}>{o.titulo}</option>)}
                </select>
              </Campo>
              <div className="sm:col-span-3"><Campo etiqueta="Resultado"><input name="resultado" className="campo" /></Campo></div>
              <div className="sm:col-span-2"><Campo etiqueta="Próxima acción"><input name="proxima_accion" className="campo" /></Campo></div>
              <Campo etiqueta="Para el"><input name="proxima_fecha" type="date" className="campo" /></Campo>
              <div className="sm:col-span-3 flex justify-end"><BotonEnviar variante="secundario">Registrar actividad</BotonEnviar></div>
            </Formulario>
          )}
          <Tabla columnas={['Fecha', 'Tipo', 'Resultado', 'Próxima acción', 'Por']} vacio="Sin actividades.">
            {actividades.map((a) => (
              <tr key={a.id}>
                <Celda className="text-texto-2 whitespace-nowrap">{a.fecha}</Celda>
                <Celda>{NOMBRE_ACTIVIDAD[a.tipo]}</Celda>
                <Celda>{a.resultado ?? '—'}{a.oportunidad && <span className="block text-xs text-texto-2">{a.oportunidad}</span>}</Celda>
                <Celda className="text-texto-2">{a.proxima_accion ? `${a.proxima_accion}${a.proxima_fecha ? ` (${a.proxima_fecha})` : ''}` : '—'}</Celda>
                <Celda className="text-texto-2">{a.usuario}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>

        {t.es_cliente && (
          <Panel titulo="Casos de postventa">
            <Tabla columnas={['Caso', 'Tipo', 'Abierto', 'Estado']} vacio="Sin casos.">
              {casos.map((k) => (
                <tr key={k.id}>
                  <Celda mono><Link href={`/crm/casos/${k.id}`} className="text-acento hover:underline">{k.numero}</Link></Celda>
                  <Celda>{NOMBRE_TIPO_CASO[k.tipo]}</Celda>
                  <Celda className="text-texto-2">{k.abierto}</Celda>
                  <Celda>{NOMBRE_ESTADO_CASO[k.estado]}</Celda>
                </tr>
              ))}
            </Tabla>
          </Panel>
        )}
      </div>
    </>
  );
}
