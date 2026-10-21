import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { PanelAdjuntos } from '@/components/panel-adjuntos';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { resumenVentanas } from '@/lib/maestros/direcciones';
import { NOMBRE_MODALIDAD, type Modalidad } from '@/lib/maestros/transportistas';
import { duracion, etiquetaTransporte } from '@/lib/ventas/presentacion';
import { ROLES_CONSTANCIA, ROLES_TRANSPORTE, ROLES_VEN_TRANSPORTE, detalleTransporte, notasDespachables } from '@/lib/ventas/transportes';
import {
  anularTransporteAccion, agregarParadaAccion, cambiarDireccionParadaAccion, cargarTransporteAccion, cerrarTransporteAccion,
  editarTransporteAccion, moverParadaAccion, quitarParadaAccion, registrarEntregaAccion, registrarLlegadaAccion, registrarNoEntregaAccion,
  salirARutaAccion,
} from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: string, dec = 1) => Number(v).toLocaleString('es-VE', { maximumFractionDigits: dec });

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return <div><dt className="text-texto-2">{etiqueta}</dt><dd>{children || '—'}</dd></div>;
}

function BotonParada({ accion, transporteId, paradaId, texto, variante = 'secundario', extra }: {
  accion: Parameters<typeof Formulario>[0]['accion']; transporteId: string; paradaId: string; texto: string;
  variante?: 'primario' | 'secundario' | 'peligro'; extra?: Record<string, string>;
}) {
  return (
    <Formulario accion={accion}>
      <input type="hidden" name="transporte_id" value={transporteId} />
      <input type="hidden" name="parada_id" value={paradaId} />
      {Object.entries(extra ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <BotonEnviar variante={variante}>{texto}</BotonEnviar>
    </Formulario>
  );
}

export default async function TransportePage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_TRANSPORTE);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const t = await detalleTransporte(db, id);
  if (!t) notFound();
  if (!(await almacenesVisibles(db, u)).includes(t.almacen_id)) notFound();

  const e = etiquetaTransporte(t.estado);
  const opera = tieneRol(u, [...ROLES_TRANSPORTE]);
  const planificado = t.estado === 'planificado';
  const enRuta = t.estado === 'en_ruta';
  const sinUbicar = t.paradas.filter((p) => !p.ubicada).length;

  const [disponibles, transportistas, vehiculos] = opera && planificado ? await Promise.all([
    notasDespachables(db, u, t.almacen_id),
    db.query<{ id: string; nombre: string }>('select id, nombre from transportista where activo order by nombre'),
    db.query<{ id: string; etiqueta: string }>(
      `select v.id, tr.nombre || ' · ' || v.placa || ' · ' || v.descripcion as etiqueta
         from vehiculo v join transportista tr on tr.id = v.transportista_id where v.activo and tr.activo order by tr.nombre, v.placa`),
  ]) : [[], null, null];

  return (
    <>
      <Encabezado titulo={`Transporte ${t.numero}`} descripcion={`${t.transportista} · ${NOMBRE_MODALIDAD[t.modalidad as Modalidad]} · sale de ${t.almacen}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={e.tono}>{e.texto}</Etiqueta>
          <Link href="/ventas/transportes" className="text-sm text-texto-2 hover:text-texto">← Transportes</Link>
        </div>
      </Encabezado>

      {planificado && t.paradas.length === 0 && opera && <div className="mb-5"><Aviso>Agregue las notas de entrega que irán en este transporte.</Aviso></div>}
      {planificado && sinUbicar > 0 && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            {sinUbicar === 1 ? '1 parada tiene una dirección' : `${sinUbicar} paradas tienen direcciones`} sin ubicar (sin coordenadas). Se despacha igual,
            pero no entrará en la optimización de rutas. Complete la ubicación en la ficha del cliente.
          </Aviso>
        </div>
      )}
      {t.estado === 'cargado' && opera && <div className="mb-5"><Aviso>La mercancía ya salió del inventario. Cuando el vehículo parta, registre la salida a ruta.</Aviso></div>}
      {t.estado === 'entregado' && opera && <div className="mb-5"><Aviso tono="exito">Todas las paradas tienen resultado. Cierre el transporte registrando el flete real.</Aviso></div>}
      {t.estado === 'anulado' && <div className="mb-5"><Aviso tono="peligro">Transporte anulado: {t.anulado_motivo}</Aviso></div>}

      <Panel titulo="Datos del transporte">
        <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-3">
          <Dato etiqueta="Fecha programada">{fecha(t.fecha_programada)}</Dato>
          <Dato etiqueta="Vehículo">{t.vehiculo}</Dato>
          <Dato etiqueta="Chofer">{t.chofer}</Dato>
          <Dato etiqueta="Creado por">{t.creador}</Dato>
          <Dato etiqueta="Cargado">{t.cargado}</Dato>
          <Dato etiqueta="Salida a ruta">{t.salida}</Dato>
          <Dato etiqueta="Cierre">{t.cierre}</Dato>
          <Dato etiqueta="Flete real">{t.estado === 'cerrado' ? monto(t.flete_usd, 'US$ ') : null}</Dato>
          {t.estado === 'cerrado' && (
            <>
              <Dato etiqueta="Salió en la fecha programada">
                {t.salio_en_fecha === null ? null : <Etiqueta tono={t.salio_en_fecha ? 'exito' : 'advertencia'}>{t.salio_en_fecha ? 'Sí' : 'No'}</Etiqueta>}
              </Dato>
              <Dato etiqueta="Tiempo de tránsito">{t.transito_seg ? duracion(t.transito_seg) : null}</Dato>
            </>
          )}
        </dl>
        {t.observaciones && <p className="mt-3 text-sm text-texto-2">{t.observaciones}</p>}
        {opera && planificado && transportistas && vehiculos && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold text-acento hover:underline">Cambiar datos</summary>
            <Formulario accion={editarTransporteAccion} className="mt-3 grid gap-3 md:grid-cols-3 md:items-end">
              <input type="hidden" name="transporte_id" value={t.id} />
              <Campo etiqueta="Transportista">
                <select name="transportista_id" required defaultValue={t.transportista_id} className="campo">
                  {transportistas.rows.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Vehículo">
                <select name="vehiculo_id" defaultValue={t.vehiculo_id ?? ''} className="campo">
                  <option value="">— Sin vehículo —</option>
                  {vehiculos.rows.map((v) => <option key={v.id} value={v.id}>{v.etiqueta}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Chofer"><input name="chofer" maxLength={80} defaultValue={t.chofer ?? ''} className="campo" /></Campo>
              <Campo etiqueta="Fecha programada"><input type="date" name="fecha_programada" required defaultValue={t.fecha_programada} className="campo" /></Campo>
              <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={250} defaultValue={t.observaciones ?? ''} className="campo" /></Campo>
              <div className="md:text-right"><BotonEnviar variante="secundario">Guardar</BotonEnviar></div>
            </Formulario>
          </details>
        )}
      </Panel>

      {t.paradas.length > 0 && (
        <Panel titulo="Carga" className="mt-5">
          <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <Dato etiqueta="Peso">
              {num(t.peso_kg)} kg{t.capacidad_kg ? <span className="text-texto-2"> de {num(t.capacidad_kg)} kg</span> : null}{' '}
              {t.excede_peso && <Etiqueta tono="peligro">excede la capacidad</Etiqueta>}
            </Dato>
            <Dato etiqueta="Volumen">
              {num(t.volumen_m3, 3)} m³{t.capacidad_m3 ? <span className="text-texto-2"> de {num(t.capacidad_m3, 3)} m³</span> : null}{' '}
              {t.excede_volumen && <Etiqueta tono="peligro">excede la capacidad</Etiqueta>}
            </Dato>
            <Dato etiqueta="Paradas">{t.paradas.length}</Dato>
          </dl>
          {t.lineas_sin_medidas > 0 && (
            <p className="mt-3 text-sm text-amber-200">
              {t.lineas_sin_medidas} línea{t.lineas_sin_medidas === 1 ? '' : 's'} de producto no tiene{t.lineas_sin_medidas === 1 ? '' : 'n'} peso o medidas en el maestro:
              el peso y el volumen mostrados quedan por debajo de lo real.
            </p>
          )}
        </Panel>
      )}

      <Panel titulo={`Paradas (${t.paradas.length})`} className="mt-5">
        <Tabla columnas={['#', 'Nota de entrega', 'Cliente y dirección', 'Horario de recepción', 'Estado', ...(opera ? ['Acciones'] : [])]} vacio="Este transporte aún no tiene paradas.">
          {t.paradas.map((p, i) => (
            <tr key={p.id} className="align-top">
              <Celda mono>{p.orden}</Celda>
              <Celda mono><Link href={`/ventas/notas-entrega/${p.nota_id}`} className="text-acento hover:underline">{p.nota_numero}</Link></Celda>
              <Celda>
                {p.cliente}
                <p className="text-xs text-texto-2">{p.direccion_nombre} · {p.direccion}, {p.ciudad}, {p.entidad_federal}</p>
                {!p.ubicada && <Etiqueta tono="advertencia">sin ubicar</Etiqueta>}
              </Celda>
              <Celda className="text-texto-2">
                {resumenVentanas(p.ventanas)}
                {p.ventanas.length > 0 && <span className="block text-xs">Ventana {p.ventana_tipo}</span>}
              </Celda>
              <Celda>
                {p.resultado === 'entregada' && <Etiqueta tono="exito">entregada</Etiqueta>}
                {p.resultado === 'no_entregada' && <Etiqueta tono="peligro">no entregada</Etiqueta>}
                {!p.resultado && p.llegada && <Etiqueta tono="advertencia">en el sitio</Etiqueta>}
                {!p.resultado && !p.llegada && <span className="text-texto-2">pendiente</span>}
                {p.llegada && <p className="text-xs text-texto-2">Llegó {p.llegada}</p>}
                {p.en_ventana !== null && (
                  <p className="text-xs"><Etiqueta tono={p.en_ventana ? 'exito' : 'advertencia'}>{p.en_ventana ? 'dentro de la ventana' : 'fuera de la ventana'}</Etiqueta></p>
                )}
                {p.resultado && p.recibido_por && <p className="text-xs text-texto-2">Recibió {p.recibido_por} · {p.resultado_hora}</p>}
                {p.incidencia && <p className="text-xs text-amber-200">Incidencia: {p.incidencia}</p>}
              </Celda>
              {opera && (
                <Celda>
                  {planificado && (
                    <div className="flex flex-wrap items-start gap-2">
                      {i > 0 && <BotonParada accion={moverParadaAccion} transporteId={t.id} paradaId={p.id} texto="↑" extra={{ sentido: 'subir' }} />}
                      {i < t.paradas.length - 1 && <BotonParada accion={moverParadaAccion} transporteId={t.id} paradaId={p.id} texto="↓" extra={{ sentido: 'bajar' }} />}
                      <BotonParada accion={quitarParadaAccion} transporteId={t.id} paradaId={p.id} texto="Quitar" variante="peligro" />
                      {p.direcciones_cliente.length > 1 && (
                        <Formulario accion={cambiarDireccionParadaAccion} className="flex items-center gap-2">
                          <input type="hidden" name="transporte_id" value={t.id} />
                          <input type="hidden" name="parada_id" value={p.id} />
                          <select name="direccion_id" defaultValue={p.direccion_id} aria-label="Dirección de entrega" className="campo !w-auto">
                            {p.direcciones_cliente.map((d) => <option key={d.id} value={d.id}>{d.nombre} · {d.ciudad}</option>)}
                          </select>
                          <BotonEnviar variante="secundario">Cambiar</BotonEnviar>
                        </Formulario>
                      )}
                    </div>
                  )}
                  {enRuta && !p.resultado && (
                    <div className="space-y-3">
                      {!p.llegada && <BotonParada accion={registrarLlegadaAccion} transporteId={t.id} paradaId={p.id} texto="Registrar llegada" />}
                      <Formulario accion={registrarEntregaAccion} className="grid gap-2">
                        <input type="hidden" name="transporte_id" value={t.id} />
                        <input type="hidden" name="parada_id" value={p.id} />
                        <input name="recibido_por" required minLength={2} maxLength={80} placeholder="Quién recibió" aria-label="Quién recibió" className="campo" />
                        <input name="incidencia" maxLength={200} placeholder="Incidencia (opcional)" aria-label="Incidencia" className="campo" />
                        <BotonEnviar>Registrar entrega</BotonEnviar>
                      </Formulario>
                      <Formulario accion={registrarNoEntregaAccion} className="grid gap-2">
                        <input type="hidden" name="transporte_id" value={t.id} />
                        <input type="hidden" name="parada_id" value={p.id} />
                        <input name="incidencia" required minLength={3} maxLength={200} placeholder="Por qué no se entregó" aria-label="Motivo de la no entrega" className="campo" />
                        <BotonEnviar variante="peligro">No se pudo entregar</BotonEnviar>
                      </Formulario>
                    </div>
                  )}
                </Celda>
              )}
            </tr>
          ))}
        </Tabla>

        {planificado && opera && (
          <div className="mt-5 border-t border-borde pt-5">
            <h3 className="mb-3 text-sm font-semibold">Agregar nota de entrega</h3>
            {disponibles.length === 0 ? (
              <p className="text-sm text-texto-2">No hay notas de entrega listas en este almacén (emitidas, con picking completo y sin transporte).</p>
            ) : (
              <Formulario accion={agregarParadaAccion} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="transporte_id" value={t.id} />
                <Campo etiqueta="Nota de entrega" ayuda="Se usa la dirección predeterminada del cliente; puede cambiarla en la parada.">
                  <select name="nota_id" required defaultValue="" className="campo min-w-[22rem]">
                    <option value="" disabled>Seleccione…</option>
                    {disponibles.map((n) => (
                      <option key={n.id} value={n.id} disabled={n.direcciones === 0}>
                        {n.numero} · {n.cliente} · {n.emitida}{n.direcciones === 0 ? ' (sin dirección de entrega)' : n.ubicadas === 0 ? ' (sin ubicar)' : ''}
                      </option>
                    ))}
                  </select>
                </Campo>
                <BotonEnviar>Agregar parada</BotonEnviar>
              </Formulario>
            )}
          </div>
        )}
      </Panel>

      {opera && ['planificado', 'cargado', 'entregado'].includes(t.estado) && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {planificado && t.paradas.length > 0 && (
              <Formulario accion={cargarTransporteAccion} className="space-y-2">
                <input type="hidden" name="transporte_id" value={t.id} />
                <p className="max-w-sm text-sm text-texto-2">Al cargar sale del inventario la mercancía de las notas que aún no han salido, con su asiento de costo de ventas.</p>
                <BotonEnviar>Cargar transporte</BotonEnviar>
              </Formulario>
            )}
            {t.estado === 'cargado' && (
              <Formulario accion={salirARutaAccion}><input type="hidden" name="transporte_id" value={t.id} /><BotonEnviar>Salir a ruta</BotonEnviar></Formulario>
            )}
            {t.estado === 'entregado' && (
              <Formulario accion={cerrarTransporteAccion} className="flex items-end gap-2">
                <input type="hidden" name="transporte_id" value={t.id} />
                <Campo etiqueta="Flete real (USD)" ayuda="Lo que costó este transporte. Puede ser 0.">
                  <input name="flete_usd" required inputMode="decimal" defaultValue="0.00" className="campo w-36 text-right tabular-nums" />
                </Campo>
                <BotonEnviar>Cerrar transporte</BotonEnviar>
              </Formulario>
            )}
            {planificado && (
              <details>
                <summary className="cursor-pointer text-sm text-red-200 hover:underline">Anular transporte</summary>
                <Formulario accion={anularTransporteAccion} className="mt-2 flex items-end gap-2">
                  <input type="hidden" name="transporte_id" value={t.id} />
                  <Campo etiqueta="Motivo"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
                  <BotonEnviar variante="peligro">Anular</BotonEnviar>
                </Formulario>
              </details>
            )}
          </div>
        </Panel>
      )}

      {t.paradas.length > 0 && t.estado !== 'anulado' && (
        <Panel titulo="Constancias de entrega" className="mt-5">
          <p className="mb-3 text-sm text-texto-2">
            Adjunte la nota de entrega firmada de cada parada{tieneRol(u, [...ROLES_CONSTANCIA]) ? '' : ' (solo Almacén y Gerencia pueden adjuntar)'}.
          </p>
          <div className="space-y-3">
            {t.paradas.map((p) => (
              <details key={p.id} className="rounded-lg border border-borde px-4 py-3">
                <summary className="cursor-pointer text-sm">Parada {p.orden} · {p.nota_numero} · {p.cliente}</summary>
                <PanelAdjuntos tipo="transporte_parada" entidadId={p.id} usuario={u} titulo="Constancia de entrega" className="mt-3" />
              </details>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
