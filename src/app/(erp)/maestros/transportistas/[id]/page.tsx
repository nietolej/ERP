import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';
import {
  NOMBRE_MODALIDAD, NOMBRE_UNIDAD_COBRO, ROLES_GESTIONAN_TARIFAS, ROLES_GESTIONAN_TRANSPORTISTAS, ROLES_VEN_TRANSPORTISTAS,
  UNIDADES_COBRO, detalleTransportista,
} from '@/lib/maestros/transportistas';
import {
  actualizarTransportistaAccion, actualizarVehiculoAccion, agregarTarifaAccion, cerrarTarifaAccion, crearVehiculoAccion,
} from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function CamposVehiculo({ v }: { v?: { descripcion: string; capacidad_kg: string | null; capacidad_m3: string | null; costo_km_usd: string | null; costo_hora_usd: string | null } }) {
  return (
    <div className="grid gap-3 md:grid-cols-5">
      <Campo etiqueta="Descripción"><input name="descripcion" required maxLength={80} defaultValue={v?.descripcion} placeholder="Camión 350" className="campo" /></Campo>
      <Campo etiqueta="Capacidad (kg)"><input name="capacidad_kg" inputMode="decimal" defaultValue={v?.capacidad_kg ?? ''} className="campo text-right tabular-nums" /></Campo>
      <Campo etiqueta="Capacidad (m³)"><input name="capacidad_m3" inputMode="decimal" defaultValue={v?.capacidad_m3 ?? ''} className="campo text-right tabular-nums" /></Campo>
      <Campo etiqueta="Costo por km (USD)"><input name="costo_km_usd" inputMode="decimal" defaultValue={v?.costo_km_usd ?? ''} className="campo text-right tabular-nums" /></Campo>
      <Campo etiqueta="Costo por hora (USD)"><input name="costo_hora_usd" inputMode="decimal" defaultValue={v?.costo_hora_usd ?? ''} className="campo text-right tabular-nums" /></Campo>
    </div>
  );
}

export default async function TransportistaPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_TRANSPORTISTAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const t = await detalleTransportista(db, id);
  if (!t) notFound();

  const puedeEditar = tieneRol(u, [...ROLES_GESTIONAN_TRANSPORTISTAS]);
  const puedeTarifas = tieneRol(u, [...ROLES_GESTIONAN_TARIFAS]) && t.modalidad !== 'flota_propia';
  const monedas = puedeTarifas ? (await db.query<{ codigo: string }>('select codigo from moneda order by codigo')).rows : [];

  return (
    <>
      <Encabezado titulo={`${t.codigo} · ${t.nombre}`} descripcion={`${NOMBRE_MODALIDAD[t.modalidad]}${t.proveedor ? ` · Proveedor ${t.proveedor}` : ''}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={t.activo ? 'exito' : 'info'}>{t.activo ? 'activo' : 'inactivo'}</Etiqueta>
          <Link href="/maestros/transportistas" className="text-sm text-texto-2 hover:text-texto">← Transportistas</Link>
        </div>
      </Encabezado>

      {puedeEditar && (
        <Panel titulo="Datos del transportista">
          <Formulario accion={actualizarTransportistaAccion} className="grid gap-3 md:grid-cols-3 md:items-end">
            <input type="hidden" name="id" value={t.id} />
            <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} defaultValue={t.nombre} className="campo" /></Campo>
            <Campo etiqueta="Teléfono de contacto"><input name="contacto_telefono" maxLength={40} defaultValue={t.contacto_telefono ?? ''} className="campo" /></Campo>
            <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={250} defaultValue={t.observaciones ?? ''} className="campo" /></Campo>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="activo" defaultChecked={t.activo} /> Activo</label>
            <div className="md:col-span-2 md:text-right"><BotonEnviar variante="secundario">Guardar</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}

      {t.modalidad !== 'encomienda' && (
        <Panel titulo="Vehículos" className="mt-5">
          <Tabla columnas={['Placa', 'Descripción', { t: 'Capacidad kg', derecha: true }, { t: 'Capacidad m³', derecha: true }, { t: 'Costo/km', derecha: true }, { t: 'Costo/hora', derecha: true }, 'Estado', '']}
            vacio="Aún no hay vehículos.">
            {t.vehiculos.map((v) => (
              <tr key={v.id} className="align-top">
                <Celda mono>{v.placa}</Celda>
                <Celda>{v.descripcion}</Celda>
                <Celda derecha>{v.capacidad_kg ?? '—'}</Celda>
                <Celda derecha>{v.capacidad_m3 ?? '—'}</Celda>
                <Celda derecha>{v.costo_km_usd ? monto(v.costo_km_usd, 'US$ ') : '—'}</Celda>
                <Celda derecha>{v.costo_hora_usd ? monto(v.costo_hora_usd, 'US$ ') : '—'}</Celda>
                <Celda><Etiqueta tono={v.activo ? 'exito' : 'info'}>{v.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
                <Celda>
                  {puedeEditar && (
                    <details>
                      <summary className="cursor-pointer text-xs text-acento hover:underline">Editar</summary>
                      <Formulario accion={actualizarVehiculoAccion} className="mt-3 w-[min(52rem,80vw)] space-y-3">
                        <input type="hidden" name="id" value={v.id} />
                        <input type="hidden" name="transportista_id" value={t.id} />
                        <CamposVehiculo v={v} />
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="activo" defaultChecked={v.activo} /> Vehículo activo</label>
                        <BotonEnviar variante="secundario">Guardar vehículo</BotonEnviar>
                      </Formulario>
                    </details>
                  )}
                </Celda>
              </tr>
            ))}
          </Tabla>
          {puedeEditar && (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-semibold text-acento hover:underline">Nuevo vehículo</summary>
              <Formulario accion={crearVehiculoAccion} className="mt-4 space-y-3">
                <input type="hidden" name="transportista_id" value={t.id} />
                <div className="max-w-xs"><Campo etiqueta="Placa"><input name="placa" required maxLength={12} placeholder="AB123CD" className="campo font-mono uppercase" /></Campo></div>
                <CamposVehiculo />
                <p className="text-xs text-texto-2">El costo por km y por hora de la flota propia alimenta la comparación de costos del ruteo (Etapa C).</p>
                <BotonEnviar>Registrar vehículo</BotonEnviar>
              </Formulario>
            </details>
          )}
        </Panel>
      )}

      {t.modalidad !== 'flota_propia' && (
        <Panel titulo="Tarifas" className="mt-5">
          <p className="mb-4 text-sm text-texto-2">
            Una tarifa no se edita: se carga una nueva con su vigencia y la anterior del mismo destino y unidad se cierra el día previo. Sin destino, aplica a cualquiera.
          </p>
          <Tabla columnas={['Destino', 'Unidad', { t: 'Tarifa', derecha: true }, { t: 'Mínimo', derecha: true }, 'Vigencia', '']} vacio="Aún no hay tarifas cargadas.">
            {t.tarifas.map((f) => (
              <tr key={f.id} className="align-top">
                <Celda>{f.ciudad ? `${f.ciudad}, ${f.entidad_federal}` : (f.entidad_federal ?? 'Cualquier destino')}</Celda>
                <Celda className="text-texto-2">{NOMBRE_UNIDAD_COBRO[f.unidad_cobro]}</Celda>
                <Celda derecha>{f.moneda} {monto(f.monto)}</Celda>
                <Celda derecha>{Number(f.minimo) > 0 ? `${f.moneda} ${monto(f.minimo)}` : '—'}</Celda>
                <Celda>
                  {fecha(f.vigente_desde)} → {f.vigente_hasta ? fecha(f.vigente_hasta) : 'sin fin'}{' '}
                  {f.vigente && <Etiqueta tono="exito">vigente</Etiqueta>}
                </Celda>
                <Celda>
                  {puedeTarifas && (!f.vigente_hasta) && (
                    <details>
                      <summary className="cursor-pointer text-xs text-acento hover:underline">Cerrar vigencia</summary>
                      <Formulario accion={cerrarTarifaAccion} className="mt-2 flex items-end gap-2">
                        <input type="hidden" name="id" value={f.id} />
                        <input type="hidden" name="transportista_id" value={t.id} />
                        <Campo etiqueta="Rige hasta"><input type="date" name="hasta" required className="campo" /></Campo>
                        <BotonEnviar variante="secundario">Cerrar</BotonEnviar>
                      </Formulario>
                    </details>
                  )}
                </Celda>
              </tr>
            ))}
          </Tabla>
          {puedeTarifas && (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-semibold text-acento hover:underline">Nueva tarifa</summary>
              <Formulario accion={agregarTarifaAccion} className="mt-4 grid gap-3 md:grid-cols-4 md:items-end">
                <input type="hidden" name="transportista_id" value={t.id} />
                <Campo etiqueta="Estado de destino" ayuda="Vacío = cualquier destino"><input name="entidad_federal" maxLength={80} placeholder="Falcón" className="campo" /></Campo>
                <Campo etiqueta="Ciudad de destino" ayuda="Opcional; exige el estado"><input name="ciudad" maxLength={80} placeholder="Coro" className="campo" /></Campo>
                <Campo etiqueta="Unidad de cobro">
                  <select name="unidad_cobro" required defaultValue="" className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {UNIDADES_COBRO.map((x) => <option key={x} value={x}>{NOMBRE_UNIDAD_COBRO[x]}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Moneda">
                  <select name="moneda" required defaultValue="USD" className="campo">{monedas.map((m) => <option key={m.codigo} value={m.codigo}>{m.codigo}</option>)}</select>
                </Campo>
                <Campo etiqueta="Tarifa"><input name="monto" required inputMode="decimal" className="campo text-right tabular-nums" /></Campo>
                <Campo etiqueta="Mínimo por envío"><input name="minimo" inputMode="decimal" placeholder="0.00" className="campo text-right tabular-nums" /></Campo>
                <Campo etiqueta="Rige desde" ayuda="No puede ser anterior a hoy"><input type="date" name="vigente_desde" required className="campo" /></Campo>
                <div className="md:text-right"><BotonEnviar>Registrar tarifa</BotonEnviar></div>
              </Formulario>
            </details>
          )}
        </Panel>
      )}
    </>
  );
}
