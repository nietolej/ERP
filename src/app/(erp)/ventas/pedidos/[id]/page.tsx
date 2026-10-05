import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { listarMotivos } from '@/lib/maestros/motivos';
import { monto, tasa } from '@/lib/formato';
import {
  ROLES_VENDEN, ROLES_VEN_VENTAS, detalleDocumento, puedeTrabajarDocumento, verTodosLosDocumentos,
} from '@/lib/ventas/pedidos';
import { etiquetaDocumento } from '@/lib/ventas/presentacion';
import {
  agregarLineaAccion, anularPedidoAccion, aprobarCreditoAccion, cambiarLineaAccion, eliminarBorradorAccion, emitirPedidoAccion,
  generarNotaAccion, quitarLineaAccion, rechazarCreditoAccion, reservarAccion,
} from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_VENTAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleDocumento(db, id);
  if (!d || d.tipo !== 'pedido') notFound();
  if (!verTodosLosDocumentos(u) && d.vendedor_usuario !== u.id) notFound();

  const puedeActuar = tieneRol(u, ROLES_VENDEN) && puedeTrabajarDocumento(u, d);
  const e = etiquetaDocumento(d.estado, d.situacion);
  const borrador = d.estado === 'borrador';
  const aprobado = d.estado === 'emitido' && d.situacion === 'aprobado';
  const retenido = d.estado === 'emitido' && d.situacion === 'retenido_credito';
  const puedeDecidir = retenido && (await puedeDecidirObjeto(db, u.id, 'pedido_credito', id));
  const { rows: sobre } = await db.query<{ activa: string }>(
    `select coalesce(sum(cantidad), 0)::text as activa from reserva_inventario where pedido_id = $1 and estado = 'activa'`, [id]);
  const porEntregar = Number(sobre[0].activa) > 0;
  const hayPendiente = d.lineas.some((l) => Number(l.cantidad) > Number(l.reservado) + Number(l.entregado));
  const vigentes = d.notas.filter((n) => n.estado === 'emitido');
  const motivosDescuento = (await listarMotivos(db, { tipo: 'descuento', soloActivos: true })).filter((m) => !m.sistema);
  const motivosAnulacion = (await listarMotivos(db, { tipo: 'anulacion', soloActivos: true })).filter((m) => !m.sistema);

  return (
    <>
      <Encabezado titulo={d.numero ? `Pedido ${d.numero}` : 'Pedido en borrador'} descripcion={`${d.cliente_codigo} · ${d.cliente}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={e.tono}>{e.texto}</Etiqueta>
          <Link href="/ventas/pedidos" className="text-sm text-texto-2 hover:text-texto">← Pedidos</Link>
        </div>
      </Encabezado>

      {retenido && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Este pedido excede el crédito del cliente (límite US$ {monto(d.limite_credito)}; ya tiene comprometidos US$ {monto(d.exposicion)} y este pedido suma US$ {monto(d.total)}).
            No reserva existencia hasta que Gerencia lo apruebe.
          </Aviso>
        </div>
      )}
      {d.estado === 'anulado' && <div className="mb-5"><Aviso tono="peligro">Anulado: {d.anulado_motivo}</Aviso></div>}

      <Panel titulo="Datos del pedido">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Cliente</dt><dd>{d.cliente_codigo} · {d.cliente}</dd></div>
          <div><dt className="text-texto-2">RIF</dt><dd className="font-mono">{d.rif}</dd></div>
          <div><dt className="text-texto-2">Vendedor</dt><dd>{d.vendedor ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Almacén</dt><dd>{d.almacen}</dd></div>
          <div><dt className="text-texto-2">Lista de precio</dt><dd>{d.nivel_precio}</dd></div>
          <div><dt className="text-texto-2">Emitido</dt><dd>{d.fecha ?? '—'}</dd></div>
          {d.tasa && <div><dt className="text-texto-2">Tasa BCV (Bs. por US$)</dt><dd className="font-mono">{tasa(d.tasa)}</dd></div>}
          <div><dt className="text-texto-2">Registró</dt><dd>{d.creado_por}</dd></div>
          {d.observaciones && <div className="md:col-span-3"><dt className="text-texto-2">Observaciones</dt><dd className="whitespace-pre-line">{d.observaciones}</dd></div>}
        </dl>
      </Panel>

      <Panel titulo={`Productos (${d.lineas.length})`} className="mt-5">
        <Tabla
          columnas={[
            'Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: 'Precio US$', derecha: true }, { t: 'Desc. %', derecha: true },
            { t: 'IVA %', derecha: true }, { t: 'Total US$', derecha: true },
            ...(borrador ? [{ t: 'Disponible', derecha: true }, 'Cambiar'] : [{ t: 'Reservado', derecha: true }, { t: 'Entregado', derecha: true }]),
          ]}
          vacio="Agregue productos al pedido.">
          {d.lineas.map((l) => (
            <tr key={l.id}>
              <Celda mono>{l.codigo}</Celda>
              <Celda>{l.descripcion}</Celda>
              <Celda derecha mono>{Number(l.cantidad)}</Celda>
              <Celda derecha mono>{monto(l.precio_unitario)}</Celda>
              <Celda derecha mono>{Number(l.descuento_pct)}</Celda>
              <Celda derecha mono>{Number(l.alicuota_pct)}</Celda>
              <Celda derecha mono>{monto(l.total)}</Celda>
              {borrador ? (
                <>
                  <Celda derecha mono className="text-texto-2">{l.disponible === null ? '0' : Number(l.disponible)}</Celda>
                  <Celda>
                    {puedeActuar && (
                      <div className="flex items-start gap-2">
                        <Formulario accion={cambiarLineaAccion} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={id} />
                          <input type="hidden" name="linea_id" value={l.id} />
                          <input name="cantidad" defaultValue={Number(l.cantidad)} aria-label="Cantidad" className="campo w-20" inputMode="decimal" />
                          <input name="descuento" defaultValue={Number(l.descuento_pct)} aria-label="Descuento %" className="campo w-16" inputMode="decimal" />
                          <select name="motivo_descuento_id" defaultValue="" aria-label="Motivo del descuento" className="campo w-40">
                            <option value="">Motivo si cambia el descuento</option>
                            {motivosDescuento.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                          </select>
                          <BotonEnviar variante="secundario">Guardar</BotonEnviar>
                        </Formulario>
                        <Formulario accion={quitarLineaAccion}>
                          <input type="hidden" name="id" value={id} />
                          <input type="hidden" name="linea_id" value={l.id} />
                          <BotonEnviar variante="peligro">Quitar</BotonEnviar>
                        </Formulario>
                      </div>
                    )}
                  </Celda>
                </>
              ) : (
                <>
                  <Celda derecha mono>{Number(l.reservado)}</Celda>
                  <Celda derecha mono>{Number(l.entregado)}</Celda>
                </>
              )}
            </tr>
          ))}
        </Tabla>

        {borrador && puedeActuar && (
          <Formulario accion={agregarLineaAccion} className="mt-5 flex flex-wrap items-end gap-3 border-t border-borde pt-4">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Código del producto"><input name="codigo" required autoComplete="off" className="campo w-48 font-mono uppercase" placeholder="PF-001" /></Campo>
            <Campo etiqueta="Cantidad"><input name="cantidad" required inputMode="decimal" className="campo w-28" defaultValue="1" /></Campo>
            <Campo etiqueta="Descuento %" ayuda="Vacío = el del cliente">
              <input name="descuento" inputMode="decimal" className="campo w-28" />
            </Campo>
            <Campo etiqueta="Motivo del descuento" ayuda="Solo si no es el del cliente">
              <select name="motivo_descuento_id" defaultValue="" className="campo w-56">
                <option value="">—</option>
                {motivosDescuento.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </Campo>
            <BotonEnviar>Agregar</BotonEnviar>
          </Formulario>
        )}

        <dl className="mt-5 ml-auto grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-texto-2">Subtotal</dt><dd className="text-right font-mono">{monto(d.subtotal, 'US$ ')}</dd>
          <dt className="text-texto-2">Descuento</dt><dd className="text-right font-mono">{monto(d.descuento, 'US$ ')}</dd>
          <dt className="text-texto-2">Base imponible</dt><dd className="text-right font-mono">{monto(d.base_imponible, 'US$ ')}</dd>
          <dt className="text-texto-2">Exento</dt><dd className="text-right font-mono">{monto(d.exento, 'US$ ')}</dd>
          <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">{monto(d.iva, 'US$ ')}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-mono font-semibold">{monto(d.total, 'US$ ')}</dd>
          <dt className="text-texto-2">Equivalente en Bs.</dt><dd className="text-right font-mono text-texto-2">{monto(d.total_ves, 'Bs. ')}</dd>
        </dl>
      </Panel>

      {puedeDecidir && (
        <Panel titulo="Crédito: decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarCreditoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar, el pedido reserva la existencia disponible.</p>
              <BotonEnviar>Aprobar pedido</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarCreditoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar y anular</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}

      {d.notas.length > 0 && (
        <Panel titulo="Notas de entrega" className="mt-5">
          <Tabla columnas={['Nota', 'Estado', { t: 'Total US$', derecha: true }]}>
            {d.notas.map((n) => {
              const en = etiquetaDocumento(n.estado, null, 'nota_entrega');
              return (
                <tr key={n.id}>
                  <Celda mono><Link href={`/ventas/notas-entrega/${n.id}`} className="text-acento hover:underline">{n.numero}</Link></Celda>
                  <Celda><Etiqueta tono={en.tono}>{en.texto}</Etiqueta></Celda>
                  <Celda derecha mono>{monto(n.total_usd)}</Celda>
                </tr>
              );
            })}
          </Tabla>
        </Panel>
      )}

      {puedeActuar && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {borrador && d.lineas.length > 0 && (
              <Formulario accion={emitirPedidoAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Al emitir se asigna el número, se congela la tasa y se valida el crédito del cliente.</p>
                <BotonEnviar>Emitir pedido</BotonEnviar>
              </Formulario>
            )}
            {borrador && (
              <Formulario accion={eliminarBorradorAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar>
              </Formulario>
            )}
            {aprobado && porEntregar && (
              <Formulario accion={generarNotaAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Genera la nota de entrega con lo que hay reservado.</p>
                <BotonEnviar>Generar nota de entrega</BotonEnviar>
              </Formulario>
            )}
            {aprobado && hayPendiente && (
              <Formulario accion={reservarAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Reserva la existencia que haya llegado para lo que falta.</p>
                <BotonEnviar variante="secundario">Reservar existencia disponible</BotonEnviar>
              </Formulario>
            )}
            {d.estado === 'emitido' && (
              vigentes.length > 0 ? (
                <p className="max-w-xs text-sm text-texto-2">Para anular el pedido, anule primero sus notas de entrega vigentes.</p>
              ) : (
                <Formulario accion={anularPedidoAccion} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <div className="flex flex-wrap items-end gap-2">
                    <Campo etiqueta="Motivo de la anulación">
                      <select name="motivo_id" required defaultValue="" className="campo w-64">
                        <option value="" disabled>Seleccione…</option>
                        {motivosAnulacion.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                      </select>
                    </Campo>
                    <Campo etiqueta="Detalle"><input name="detalle" maxLength={200} className="campo w-64" placeholder="Obligatorio si elige Otro" /></Campo>
                  </div>
                  <BotonEnviar variante="peligro">Anular pedido</BotonEnviar>
                </Formulario>
              )
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
