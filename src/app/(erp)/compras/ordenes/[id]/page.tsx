import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_REGISTRAN_FACTURA } from '@/lib/compras/facturas';
import { NOMBRE_CRITERIO } from '@/lib/compras/costo-destino';
import { NOMBRE_ESTADO_ORDEN, ROLES_COMPRAN, ROLES_VEN_COMPRAS, detalleOrden } from '@/lib/compras/ordenes';
import { ROLES_RECIBEN } from '@/lib/compras/recepciones';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { monto } from '@/lib/formato';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import {
  actualizarOrdenAccion, anularOrdenAccion, aprobarOrdenAccion, eliminarOrdenAccion, enviarOrdenAccion, guardarLineaOrdenAccion,
  quitarLineaOrdenAccion, recibirMercanciaAccion, rechazarOrdenAccion,
} from '../../acciones';
import { CamposOrden, opcionesOrden } from '../datos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { borrador: 'info', pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro', anulada: 'peligro' } as const;

export default async function OrdenPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleOrden(db, id);
  if (!d) notFound();

  const borrador = d.estado === 'borrador';
  const compra = tieneRol(u, ROLES_COMPRAN);
  const puedeEditar = borrador && compra;
  const pendiente = d.estado === 'pendiente';
  const puedeDecidir = pendiente && (await puedeDecidirObjeto(db, u.id, 'orden_compra', id));
  const puedeRecibir = d.estado === 'aprobada' && tieneRol(u, ROLES_RECIBEN) && (await almacenesVisibles(db, u)).includes(d.almacen_id)
    && d.lineas.some((l) => Number(l.pendiente) > 0);
  const op = puedeEditar ? await opcionesOrden(db) : null;
  const usd = d.moneda === 'USD';

  return (
    <>
      <Encabezado titulo={d.numero ? `Orden de compra ${d.numero}` : 'Orden de compra en borrador'} descripcion={d.proveedor}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_ORDEN[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/compras/ordenes" className="text-sm text-texto-2 hover:text-texto">← Órdenes</Link>
        </div>
      </Encabezado>

      {pendiente && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe aprobar otra persona de Gerencia: quien creó la orden ({d.creado_por}) no la aprueba.</Aviso></div>
      )}
      {d.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'anulada' && <div className="mb-5"><Aviso tono="peligro">Anulada: {d.anulado_motivo}</Aviso></div>}
      {d.estado === 'aprobada' && <div className="mb-5"><Aviso tono="exito">Aprobada por {d.aprobado_por} el {d.aprobado_at}.</Aviso></div>}

      <Panel titulo="Datos de la orden">
        {puedeEditar && op ? (
          <Formulario accion={actualizarOrdenAccion} className="space-y-5">
            <input type="hidden" name="id" value={id} />
            <CamposOrden op={op} monedaFija={d.lineas.length > 0}
              v={{ proveedor_id: d.proveedor_id, almacen_id: d.almacen_id, moneda: d.moneda, criterio_reparto: d.criterio_reparto,
                   fecha_prometida: d.fecha_prometida ? d.fecha_prometida.split('-').reverse().join('-') : null, observaciones: d.observaciones }} />
            <div className="flex justify-end"><BotonEnviar>Guardar datos</BotonEnviar></div>
          </Formulario>
        ) : (
          <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
            <div><dt className="text-texto-2">Proveedor</dt><dd>{d.proveedor}</dd></div>
            <div><dt className="text-texto-2">Se recibe en</dt><dd>{d.almacen}</dd></div>
            <div><dt className="text-texto-2">Moneda</dt><dd>{d.moneda}{d.tasa && !usd ? ` · tasa ${d.tasa}` : ''}</dd></div>
            <div><dt className="text-texto-2">Gastos de importación por</dt><dd>{NOMBRE_CRITERIO[d.criterio_reparto]}</dd></div>
            <div><dt className="text-texto-2">Entrega prometida</dt><dd>{d.fecha_prometida ?? '—'}</dd></div>
            <div><dt className="text-texto-2">Creó</dt><dd>{d.creado_por} · {d.fecha}</dd></div>
            <div><dt className="text-texto-2">Total</dt><dd className="font-mono">{d.moneda} {monto(d.total)}{!usd && ` (US$ ${monto(d.total_usd)})`}</dd></div>
            {d.observaciones && <div className="md:col-span-2"><dt className="text-texto-2">Observaciones</dt><dd className="whitespace-pre-line">{d.observaciones}</dd></div>}
          </dl>
        )}
      </Panel>

      <Panel titulo={`Productos (${d.lineas.length})`} className="mt-5">
        <Tabla
          columnas={['Código', 'Descripción', 'Unidad', { t: 'Cantidad', derecha: true }, { t: `Precio ${d.moneda}`, derecha: true }, { t: `Total ${d.moneda}`, derecha: true },
            { t: 'Peso kg', derecha: true }, { t: 'Volumen m³', derecha: true }, ...(d.estado === 'aprobada' ? [{ t: 'Recibido', derecha: true }, { t: 'Pendiente', derecha: true }] : []),
            ...(puedeEditar ? [''] : [])]}
          vacio="Agregue los productos que va a comprar.">
          {d.lineas.map((l) => (
            <tr key={l.id}>
              <Celda mono>{l.codigo}</Celda>
              <Celda>{l.descripcion}</Celda>
              <Celda className="text-texto-2">{l.unidad}</Celda>
              <Celda derecha mono>{Number(l.cantidad)}</Celda>
              <Celda derecha mono>{monto(l.precio_unitario)}</Celda>
              <Celda derecha mono>{borrador ? '—' : monto(l.total)}</Celda>
              <Celda derecha mono className="text-texto-2">{l.peso_kg ? Number(l.peso_kg) : '—'}</Celda>
              <Celda derecha mono className="text-texto-2">{l.volumen_unitario_m3 ? Number(l.volumen_unitario_m3).toFixed(6) : '—'}</Celda>
              {d.estado === 'aprobada' && <Celda derecha mono>{Number(l.recibida)}</Celda>}
              {d.estado === 'aprobada' && <Celda derecha mono>{Number(l.pendiente)}</Celda>}
              {puedeEditar && (
                <Celda>
                  <Formulario accion={quitarLineaOrdenAccion}>
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="linea_id" value={l.id} />
                    <BotonEnviar variante="peligro">Quitar</BotonEnviar>
                  </Formulario>
                </Celda>
              )}
            </tr>
          ))}
        </Tabla>

        {puedeEditar && (
          <Formulario accion={guardarLineaOrdenAccion} className="mt-5 flex flex-wrap items-end gap-3 border-t border-borde pt-4">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Código del producto"><input name="codigo" required autoComplete="off" className="campo w-44 font-mono uppercase" placeholder="PF-001" /></Campo>
            <Campo etiqueta="Cantidad"><input name="cantidad" required inputMode="decimal" className="campo w-28" /></Campo>
            <Campo etiqueta={`Precio unitario (${d.moneda})`}><input name="precio" required inputMode="decimal" className="campo w-36" /></Campo>
            <BotonEnviar>Agregar o reemplazar</BotonEnviar>
          </Formulario>
        )}
      </Panel>

      {d.recepciones.length > 0 && (
        <Panel titulo="Recepciones de esta orden" className="mt-5">
          <Tabla columnas={['Recepción', 'Fecha', { t: 'Valor US$', derecha: true }]}>
            {d.recepciones.map((r) => (
              <tr key={r.id}>
                <Celda mono>{r.numero}</Celda>
                <Celda className="text-texto-2">{r.fecha}</Celda>
                <Celda derecha mono>{monto(r.total_usd)}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      )}

      {puedeRecibir && (
        <Panel titulo="Recibir mercancía" className="mt-5">
          <Formulario accion={recibirMercanciaAccion} className="space-y-4">
            <input type="hidden" name="id" value={id} />
            <p className="text-sm text-texto-2">
              Indique lo que realmente llegó de cada producto (no puede superar lo pendiente). Entra al inventario al precio de la orden convertido a
              dólares con la tasa BCV de hoy.
            </p>
            <div className="flex flex-wrap gap-4">
              {d.lineas.filter((l) => Number(l.pendiente) > 0).map((l) => (
                <Campo key={l.id} etiqueta={`${l.codigo} (pendiente ${Number(l.pendiente)})`}>
                  <input name={`cant_${l.id}`} inputMode="decimal" className="campo w-32" placeholder="0" />
                </Campo>
              ))}
            </div>
            <Campo etiqueta="Observaciones"><input name="observaciones" maxLength={300} className="campo" /></Campo>
            <BotonEnviar>Registrar recepción</BotonEnviar>
          </Formulario>
        </Panel>
      )}

      {d.estado === 'aprobada' && d.recepciones.length > 0 && tieneRol(u, ROLES_REGISTRAN_FACTURA) && (
        <div className="mt-5">
          <Link href={`/compras/facturas/nueva?orden=${id}`} className="text-sm text-acento hover:underline">Registrar la factura del proveedor de esta orden →</Link>
        </div>
      )}

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarOrdenAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar, Almacén puede recibir la mercancía contra esta orden.</p>
              <BotonEnviar>Aprobar orden</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarOrdenAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar orden</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}

      {puedeEditar && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {d.lineas.length > 0 && (
              <Formulario accion={enviarOrdenAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Al enviarla recibe su número y ya no se edita. Gerencia la aprueba o la rechaza.</p>
                <BotonEnviar>Enviar a aprobación</BotonEnviar>
              </Formulario>
            )}
            <Formulario accion={eliminarOrdenAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
          </div>
        </Panel>
      )}

      {compra && (d.estado === 'pendiente' || d.estado === 'aprobada') && d.recepciones.length === 0 && (
        <Panel titulo="Anular orden" className="mt-5">
          <Formulario accion={anularOrdenAccion} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Motivo"><input name="motivo" required minLength={3} maxLength={200} className="campo w-80" /></Campo>
            <BotonEnviar variante="peligro">Anular</BotonEnviar>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
