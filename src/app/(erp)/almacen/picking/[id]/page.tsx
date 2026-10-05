import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ROLES_DECIDEN_FALTANTE, ROLES_PICKING, ROLES_VEN_PICKING, detalleOrden } from '@/lib/ventas/picking';
import { duracion, etiquetaOrden } from '@/lib/ventas/presentacion';
import {
  cambiarPrioridadAccion, despacharParcialAccion, empacarOrdenAccion, esperarFaltanteAccion, finalizarOrdenAccion, iniciarOrdenAccion,
  registrarRecogidaAccion, tomarOrdenAccion,
} from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrdenPickingPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PICKING);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleOrden(db, id);
  if (!d) notFound();
  if (!(await almacenesVisibles(db, u)).includes(d.almacen_id)) notFound();

  const e = etiquetaOrden(d.estado);
  const opera = tieneRol(u, ROLES_PICKING);
  const decide = tieneRol(u, ROLES_DECIDEN_FALTANTE);
  const propia = !d.asignada_a_id || d.asignada_a_id === u.id || tieneRol(u, ['gerencia']);
  const enProceso = d.estado === 'en_proceso';
  const antesDeIniciar = d.estado === 'pendiente' || d.estado === 'asignada';
  const hayMedicion = d.espera_seg !== null;

  return (
    <>
      <Encabezado titulo={`Orden de picking ${d.numero}`} descripcion={`Nota de entrega ${d.nota_numero} · ${d.cliente}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={e.tono}>{e.texto}</Etiqueta>
          <Link href="/almacen/picking" className="text-sm text-texto-2 hover:text-texto">← Picking</Link>
        </div>
      </Encabezado>

      {d.estado === 'con_faltante' && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Se recogió menos de lo pedido. Gerencia o el supervisor de ventas deciden: esperar la mercancía o despachar parcial.
            Mientras tanto no se puede confirmar la salida.
          </Aviso>
        </div>
      )}
      {d.estado === 'completa' && !d.empacada && opera && <div className="mb-5"><Aviso>Picking completo. Registre el empaque para poder confirmar la salida.</Aviso></div>}
      {d.estado === 'completa' && d.empacada && (
        <div className="mb-5">
          <Aviso tono="exito">
            Empacada el {d.empacada}. {d.nota_despachada ? 'La mercancía ya salió.' : (
              <>Falta confirmar la salida en la <Link href={`/ventas/notas-entrega/${d.nota_id}`} className="underline">nota de entrega {d.nota_numero}</Link>.</>
            )}
          </Aviso>
        </div>
      )}

      <Panel titulo="Datos de la orden">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Almacén</dt><dd>{d.almacen}</dd></div>
          <div><dt className="text-texto-2">Prioridad</dt><dd>{d.prioridad} <span className="text-texto-2">(1 = más urgente)</span></dd></div>
          <div><dt className="text-texto-2">Asignada a</dt><dd>{d.asignada_a ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Creada</dt><dd>{d.creada}</dd></div>
          <div>
            <dt className="text-texto-2">Nota de entrega</dt>
            <dd><Link href={`/ventas/notas-entrega/${d.nota_id}`} className="font-mono text-acento hover:underline">{d.nota_numero}</Link></dd>
          </div>
          <div><dt className="text-texto-2">Cliente</dt><dd>{d.cliente}</dd></div>
        </dl>
      </Panel>

      {hayMedicion && (
        <Panel titulo="Tiempos" className="mt-5">
          <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-5">
            <div><dt className="text-texto-2">Espera</dt><dd>{duracion(d.espera_seg)}</dd></div>
            <div><dt className="text-texto-2">Picking</dt><dd>{duracion(d.picking_seg)}</dd></div>
            <div><dt className="text-texto-2">Ciclo total</dt><dd>{duracion(d.ciclo_seg)}</dd></div>
            <div><dt className="text-texto-2">Líneas por hora</dt><dd className="font-mono">{d.lineas_por_hora ?? '—'}</dd></div>
            <div>
              <dt className="text-texto-2">Objetivo{d.objetivo_horas ? ` (${Number(d.objetivo_horas)} h)` : ''}</dt>
              <dd>
                {d.cumple_objetivo === null ? '—' : <Etiqueta tono={d.cumple_objetivo ? 'exito' : 'peligro'}>{d.cumple_objetivo ? 'Cumplido' : 'Excedido'}</Etiqueta>}
              </dd>
            </div>
          </dl>
        </Panel>
      )}

      <Panel titulo={`Productos (${d.lineas.length})`} className="mt-5">
        <Tabla columnas={['Código', 'Descripción', { t: 'Pedida', derecha: true }, { t: 'Recogida', derecha: true }, ...(enProceso && opera && propia ? ['Registrar'] : ['Faltante'])]}>
          {d.lineas.map((l) => {
            const falta = Number(l.pedida) - Number(l.recogida);
            return (
              <tr key={l.id}>
                <Celda mono>{l.codigo}</Celda>
                <Celda>{l.descripcion}</Celda>
                <Celda derecha mono>{Number(l.pedida)}</Celda>
                <Celda derecha mono>{Number(l.recogida)}</Celda>
                {enProceso && opera && propia ? (
                  <Celda>
                    <Formulario accion={registrarRecogidaAccion} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="linea_id" value={l.id} />
                      <input name="cantidad" defaultValue={Number(l.recogida)} aria-label="Cantidad recogida" inputMode="decimal" className="campo w-24" />
                      <input name="motivo" defaultValue={l.motivo ?? ''} aria-label="Motivo del faltante" placeholder="Motivo si falta" maxLength={120} className="campo w-48" />
                      <BotonEnviar variante="secundario">Guardar</BotonEnviar>
                    </Formulario>
                  </Celda>
                ) : (
                  <Celda className="text-texto-2">{falta > 0 ? `Faltan ${falta}${l.motivo ? ` · ${l.motivo}` : ''}` : '—'}</Celda>
                )}
              </tr>
            );
          })}
        </Tabla>
      </Panel>

      {(opera || decide) && d.estado !== 'cancelada' && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {opera && d.estado === 'pendiente' && (
              <Formulario accion={tomarOrdenAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="secundario">Tomar la orden</BotonEnviar></Formulario>
            )}
            {opera && antesDeIniciar && (
              <Formulario accion={iniciarOrdenAccion}><input type="hidden" name="id" value={id} /><BotonEnviar>Iniciar picking</BotonEnviar></Formulario>
            )}
            {opera && antesDeIniciar && (
              <Formulario accion={cambiarPrioridadAccion} className="flex items-end gap-2">
                <input type="hidden" name="id" value={id} />
                <Campo etiqueta="Prioridad">
                  <select name="prioridad" defaultValue={d.prioridad} className="campo w-24">
                    {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Campo>
                <BotonEnviar variante="secundario">Cambiar</BotonEnviar>
              </Formulario>
            )}
            {opera && enProceso && propia && (
              <Formulario accion={finalizarOrdenAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Guarde primero lo recogido de cada línea. Si algo no se recogió completo, indique el motivo.</p>
                <BotonEnviar>Finalizar picking</BotonEnviar>
              </Formulario>
            )}
            {opera && d.estado === 'completa' && !d.empacada && (
              <Formulario accion={empacarOrdenAccion}><input type="hidden" name="id" value={id} /><BotonEnviar>Registrar empaque</BotonEnviar></Formulario>
            )}
            {decide && d.estado === 'con_faltante' && (
              <>
                <Formulario accion={esperarFaltanteAccion} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <p className="max-w-xs text-sm text-texto-2">La orden vuelve a estar en proceso para completar el picking cuando llegue la mercancía.</p>
                  <BotonEnviar variante="secundario">Esperar la mercancía</BotonEnviar>
                </Formulario>
                <Formulario accion={despacharParcialAccion} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <p className="max-w-xs text-sm text-texto-2">Se registra la demanda no atendida, se anula la nota y se emite otra con lo recogido.</p>
                  <BotonEnviar variante="peligro">Despachar parcial</BotonEnviar>
                </Formulario>
              </>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
