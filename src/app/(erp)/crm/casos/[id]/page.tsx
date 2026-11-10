import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Etiqueta, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { detalleCaso, NOMBRE_ESTADO_CASO, NOMBRE_TIPO_CASO, notasDevolucionDeFactura } from '@/lib/crm/casos';
import { ROLES_CASOS, ROLES_VEN_CASOS, soloLoSuyo } from '@/lib/crm/comun';
import { getDb } from '@/lib/db';
import { casoAccion } from '../../acciones';

export default async function CasoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CASOS);
  const { id } = await params;
  const db = await getDb();
  const k = await detalleCaso(db, id);
  if (!k || (soloLoSuyo(u) && k.vendedor_usuario !== u.id)) notFound();
  const trabaja = tieneRol(u, [...ROLES_CASOS]) && k.estado !== 'cerrado';
  const [usuarios, notas] = await Promise.all([
    trabaja ? db.query<{ id: string; nombre: string }>(`select id, nombre from usuario where activo order by nombre`).then((r) => r.rows) : Promise.resolve([]),
    trabaja && k.tipo === 'devolucion' && k.documento_venta_id ? notasDevolucionDeFactura(db, k.documento_venta_id) : Promise.resolve([]),
  ]);
  const oculto = (accion: string) => (<><input type="hidden" name="id" value={id} /><input type="hidden" name="accion" value={accion} /></>);
  const notaPendiente = k.tipo === 'devolucion' && k.nota_estado !== 'emitido';

  return (
    <>
      <Encabezado titulo={`Caso ${k.numero} · ${NOMBRE_TIPO_CASO[k.tipo]}`} descripcion={`${k.cliente} · ${k.rif}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={k.estado === 'cerrado' ? 'exito' : k.estado === 'resuelto' ? 'info' : 'advertencia'}>{NOMBRE_ESTADO_CASO[k.estado]}</Etiqueta>
          <Link href="/crm/casos" className="text-sm text-texto-2 hover:text-texto">← Casos</Link>
        </div>
      </Encabezado>

      {k.tipo === 'devolucion' && (
        <div className="mb-5">
          <Aviso tono={notaPendiente ? 'advertencia' : 'exito'}>
            {k.nota_credito_id
              ? <>Nota de crédito por devolución: <Link href={`/ventas/notas/${k.nota_credito_id}`} className="underline">{k.nota_numero ? `NC ${k.nota_numero}` : 'en borrador'}</Link> ({k.nota_estado}). {notaPendiente && 'El caso se resuelve cuando la nota esté emitida.'}</>
              : <>Este caso no mueve inventario. Cree la <Link href="/ventas/notas" className="underline">nota de crédito por devolución</Link> de la factura {k.factura} y enlácela aquí.</>}
          </Aviso>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Datos">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-texto-2">Cliente</dt><dd><Link href={`/crm/terceros/${k.cliente_id}`} className="text-acento hover:underline">{k.cliente}</Link></dd></div>
            <div><dt className="text-texto-2">Factura</dt><dd className="font-mono">{k.factura ?? '—'}</dd></div>
            <div><dt className="text-texto-2">Abierto</dt><dd>{k.abierto} por {k.creado_por}</dd></div>
            <div><dt className="text-texto-2">Responsable</dt><dd>{k.responsable ?? '—'}</dd></div>
            <div><dt className="text-texto-2">Resuelto</dt><dd>{k.resuelto ?? '—'}</dd></div>
            <div><dt className="text-texto-2">Días</dt><dd className="font-mono">{k.dias}</dd></div>
            <div className="sm:col-span-2"><dt className="text-texto-2">Descripción</dt><dd className="whitespace-pre-line">{k.descripcion}</dd></div>
            {k.causa && <div className="sm:col-span-2"><dt className="text-texto-2">Causa</dt><dd className="whitespace-pre-line">{k.causa}</dd></div>}
            {k.solucion && <div className="sm:col-span-2"><dt className="text-texto-2">Solución</dt><dd className="whitespace-pre-line">{k.solucion}</dd></div>}
          </dl>
        </Panel>

        {trabaja && (
          <Panel titulo="Atender el caso">
            <Formulario accion={casoAccion} className="grid gap-3">
              {oculto('guardar')}
              <Campo etiqueta="Responsable">
                <select name="responsable_id" defaultValue={k.responsable_id ?? ''} className="campo">
                  {usuarios.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Causa"><textarea name="causa" rows={2} defaultValue={k.causa ?? ''} className="campo" /></Campo>
              <Campo etiqueta="Solución"><textarea name="solucion" rows={2} defaultValue={k.solucion ?? ''} className="campo" /></Campo>
              <div className="flex justify-end"><BotonEnviar variante="secundario">Guardar</BotonEnviar></div>
            </Formulario>

            {k.tipo === 'devolucion' && notas.length > 0 && notas.some((n) => n.id !== k.nota_credito_id) && (
              <Formulario accion={casoAccion} className="mt-4 flex flex-wrap items-end gap-3 border-t border-borde pt-4">
                {oculto('nota')}
                <Campo etiqueta="Enlazar la nota de crédito por devolución">
                  <select name="nota_id" className="campo">
                    {notas.filter((n) => n.id !== k.nota_credito_id).map((n) => <option key={n.id} value={n.id}>{n.etiqueta}</option>)}
                  </select>
                </Campo>
                <BotonEnviar variante="secundario">Enlazar</BotonEnviar>
              </Formulario>
            )}

            <div className="mt-4 flex flex-wrap gap-3 border-t border-borde pt-4">
              {k.estado === 'abierto' && <Formulario accion={casoAccion}>{oculto('en_analisis')}<BotonEnviar variante="secundario">Pasar a análisis</BotonEnviar></Formulario>}
              {(k.estado === 'abierto' || k.estado === 'en_analisis') && <Formulario accion={casoAccion}>{oculto('resuelto')}<BotonEnviar>Marcar resuelto</BotonEnviar></Formulario>}
              {k.estado === 'resuelto' && (
                <>
                  <Formulario accion={casoAccion}>{oculto('cerrado')}<BotonEnviar>Cerrar</BotonEnviar></Formulario>
                  <Formulario accion={casoAccion}>{oculto('en_analisis')}<BotonEnviar variante="secundario">Reabrir el análisis</BotonEnviar></Formulario>
                </>
              )}
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
