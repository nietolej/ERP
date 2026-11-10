import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Etiqueta, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM, soloLoSuyo } from '@/lib/crm/comun';
import { listarCotizaciones } from '@/lib/crm/cotizaciones';
import { detalleOportunidad, ETAPAS, NOMBRE_ETAPA, SIGUIENTE } from '@/lib/crm/oportunidades';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { listarMotivos } from '@/lib/maestros/motivos';
import { oportunidadAccion } from '../../acciones';

export default async function OportunidadPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const { id } = await params;
  const db = await getDb();
  const o = await detalleOportunidad(db, id);
  if (!o || (soloLoSuyo(u) && o.vendedor_usuario !== u.id)) notFound();
  const abierta = o.etapa !== 'ganada' && o.etapa !== 'perdida';
  const trabaja = tieneRol(u, [...ROLES_CRM]) && abierta;
  const siguiente = SIGUIENTE[o.etapa];
  const [cotizaciones, motivos, vendedores] = await Promise.all([
    trabaja ? listarCotizaciones(db, u, { terceroId: o.tercero_id, estado: 'emitida' }) : Promise.resolve([]),
    trabaja ? listarMotivos(db, { tipo: 'venta_perdida', soloActivos: true }) : Promise.resolve([]),
    trabaja && !soloLoSuyo(u)
      ? db.query<{ id: string; nombre: string }>(`select id, codigo || ' · ' || nombre as nombre from vendedor where estado = 'activo' order by codigo`).then((r) => r.rows)
      : Promise.resolve([]),
  ]);
  const vigentes = cotizaciones.filter((q) => !q.vencida);
  const oculto = (accion: string) => (<><input type="hidden" name="id" value={id} /><input type="hidden" name="accion" value={accion} /></>);
  const pasos = ETAPAS.filter((e) => e !== 'perdida');

  return (
    <>
      <Encabezado titulo={o.titulo} descripcion={`${o.tercero}${o.prospecto ? ' (prospecto)' : ''} · Vendedor: ${o.vendedor}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={o.etapa === 'ganada' ? 'exito' : o.etapa === 'perdida' ? 'peligro' : 'info'}>{NOMBRE_ETAPA[o.etapa]}</Etiqueta>
          <Link href={`/crm/terceros/${o.tercero_id}`} className="text-sm text-texto-2 hover:text-texto">Ficha →</Link>
        </div>
      </Encabezado>

      <ol className="mb-5 flex flex-wrap gap-2 text-sm">
        {pasos.map((e, i) => {
          const actual = ETAPAS.indexOf(o.etapa);
          const hecho = o.etapa !== 'perdida' && i <= actual;
          return <li key={e} className={`rounded-full border px-3 py-1 ${hecho ? 'border-acento bg-acento/15' : 'border-borde text-texto-2'}`}>{i + 1}. {NOMBRE_ETAPA[e]}</li>;
        })}
      </ol>

      {o.etapa === 'perdida' && <div className="mb-5"><Aviso tono="peligro">Perdida el {o.cerrada}: {o.motivo_perdida}</Aviso></div>}
      {o.etapa === 'ganada' && (
        <div className="mb-5">
          <Aviso tono="exito">
            Ganada el {o.cerrada}.{' '}
            {o.pedido_id
              ? <>Generó el <Link href={`/ventas/pedidos/${o.pedido_id}`} className="underline">pedido {o.pedido_numero ?? 'en borrador'}</Link>.</>
              : o.cliente_estado === 'activo' ? 'Falta generar el pedido.' : 'El cliente espera la aprobación de Gerencia; luego se genera el pedido.'}
          </Aviso>
          {!o.pedido_id && o.cliente_estado === 'activo' && tieneRol(u, [...ROLES_CRM]) && (
            <Formulario accion={oportunidadAccion} className="mt-3">{oculto('pedido')}<BotonEnviar>Generar el pedido desde la cotización</BotonEnviar></Formulario>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Datos">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-texto-2">Monto estimado</dt><dd className="font-mono">US$ {monto(o.monto_estimado_usd)}</dd></div>
            <div><dt className="text-texto-2">Cierre estimado</dt><dd>{o.cierre_estimado ?? '—'}</dd></div>
            <div><dt className="text-texto-2">Cotización</dt><dd>{o.cotizacion_id ? <Link href={`/crm/cotizaciones/${o.cotizacion_id}`} className="text-acento hover:underline">{o.cotizacion_numero} · vigente hasta {o.cotizacion_vigente}</Link> : '—'}</dd></div>
            <div><dt className="text-texto-2">Creada</dt><dd>{o.creada} por {o.creado_por}</dd></div>
          </dl>
          {trabaja && (
            <Formulario accion={oportunidadAccion} className="mt-4 grid gap-3 sm:grid-cols-2">
              {oculto('guardar')}
              <div className="sm:col-span-2"><Campo etiqueta="Descripción"><input name="titulo" defaultValue={o.titulo} required className="campo" /></Campo></div>
              <Campo etiqueta="Monto estimado US$"><input name="monto" defaultValue={o.monto_estimado_usd} inputMode="decimal" className="campo" /></Campo>
              <Campo etiqueta="Cierre estimado"><input name="cierre" type="date" defaultValue={o.cierre_iso ?? ''} className="campo" /></Campo>
              {vendedores.length > 0 && (
                <Campo etiqueta="Vendedor">
                  <select name="vendedor_id" defaultValue={o.vendedor_id} className="campo">
                    {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
                  </select>
                </Campo>
              )}
              <div className="sm:col-span-2 flex justify-end"><BotonEnviar variante="secundario">Guardar</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>

        {trabaja && (
          <Panel titulo="Avanzar o cerrar">
            {siguiente && siguiente !== 'ganada' && siguiente !== 'cotizada' && (
              <Formulario accion={oportunidadAccion} className="mb-4">{oculto('avanzar')}<BotonEnviar>Pasar a {NOMBRE_ETAPA[siguiente]}</BotonEnviar></Formulario>
            )}
            {siguiente === 'cotizada' && (
              vigentes.length ? (
                <Formulario accion={oportunidadAccion} className="mb-4 flex flex-wrap items-end gap-3">
                  {oculto('avanzar')}
                  <Campo etiqueta="Cotización enviada">
                    <select name="cotizacion_id" required className="campo">
                      {vigentes.map((q) => <option key={q.id} value={q.id}>{q.numero} · US$ {monto(q.total)} · hasta {q.vigente_hasta}</option>)}
                    </select>
                  </Campo>
                  <BotonEnviar>Pasar a Cotizada</BotonEnviar>
                </Formulario>
              ) : (
                <div className="mb-4"><Aviso>Para pasar a Cotizada, <Link href={`/crm/cotizaciones?tercero=${o.tercero_id}`} className="underline">emita una cotización</Link> para este {o.prospecto ? 'prospecto' : 'cliente'}.</Aviso></div>
              )
            )}
            {(o.etapa === 'cotizada' || o.etapa === 'negociacion') && vigentes.some((q) => q.id !== o.cotizacion_id) && (
              <Formulario accion={oportunidadAccion} className="mb-4 flex flex-wrap items-end gap-3">
                {oculto('cotizacion')}
                <Campo etiqueta="Cambiar la cotización por">
                  <select name="cotizacion_id" className="campo">
                    {vigentes.filter((q) => q.id !== o.cotizacion_id).map((q) => <option key={q.id} value={q.id}>{q.numero} · US$ {monto(q.total)}</option>)}
                  </select>
                </Campo>
                <BotonEnviar variante="secundario">Enlazar</BotonEnviar>
              </Formulario>
            )}
            {siguiente === 'ganada' && (
              <Formulario accion={oportunidadAccion} className="mb-4">
                {oculto('ganar')}
                <p className="mb-2 text-sm text-texto-2">
                  {o.prospecto
                    ? 'Al ganarla, el prospecto se registra como cliente pendiente de aprobación de Gerencia; el pedido se genera cuando lo apruebe.'
                    : 'Al ganarla se genera un pedido en borrador con los productos de la cotización.'}
                </p>
                <BotonEnviar>Ganar</BotonEnviar>
              </Formulario>
            )}
            <Formulario accion={oportunidadAccion} className="grid gap-3 border-t border-borde pt-4 sm:grid-cols-2">
              {oculto('perder')}
              <Campo etiqueta="Motivo de la pérdida">
                <select name="motivo_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {motivos.filter((m) => !m.sistema).map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Detalle"><input name="detalle" className="campo" /></Campo>
              <div className="sm:col-span-2 flex justify-end"><BotonEnviar variante="peligro">Cerrar como perdida</BotonEnviar></div>
            </Formulario>
          </Panel>
        )}
      </div>
    </>
  );
}
