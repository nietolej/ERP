import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_ESTADO_FACTURA, ROLES_REGISTRAN_FACTURA, detalleFactura } from '@/lib/compras/facturas';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { monto } from '@/lib/formato';
import {
  aprobarFacturaAccion, eliminarFacturaAccion, guardarLineaFacturaAccion, quitarLineaFacturaAccion, rechazarFacturaAccion,
  registrarFacturaAccion,
} from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { borrador: 'info', retenida: 'advertencia', contabilizada: 'exito', rechazada: 'peligro' } as const;

export default async function FacturaCompraPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleFactura(db, id);
  if (!d) notFound();

  const borrador = d.estado === 'borrador';
  const puedeEditar = borrador && tieneRol(u, ROLES_REGISTRAN_FACTURA);
  const retenida = d.estado === 'retenida';
  const puedeDecidir = retenida && (await puedeDecidirObjeto(db, u.id, 'factura_compra', id));

  return (
    <>
      <Encabezado titulo={`Factura ${d.numero_factura}`} descripcion={`${d.proveedor} · orden de compra ${d.orden}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_FACTURA[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/compras/facturas" className="text-sm text-texto-2 hover:text-texto">← Facturas</Link>
        </div>
      </Encabezado>

      {retenida && <div className="mb-5"><Aviso tono="advertencia">{d.motivo_retencion}. No abre cuenta por pagar, así que no se puede pagar, hasta que Gerencia la apruebe.</Aviso></div>}
      {retenida && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe decidir otra persona de Gerencia: quien registró la factura ({d.creado_por}) no la aprueba.</Aviso></div>
      )}
      {d.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'contabilizada' && (
        <div className="mb-5">
          <Aviso tono="exito">
            Contabilizada{d.aprobado_por ? `, aprobada por ${d.aprobado_por} el ${d.aprobado_at}` : ' dentro de tolerancia'}. Saldo por pagar: {d.moneda} {monto(d.saldo ?? '0')}.
          </Aviso>
        </div>
      )}

      <Panel titulo="Datos de la factura">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Número de control</dt><dd className="font-mono">{d.numero_control}</dd></div>
          <div><dt className="text-texto-2">Fecha</dt><dd>{d.fecha_factura}</dd></div>
          <div><dt className="text-texto-2">Vence</dt><dd>{d.fecha_vencimiento}</dd></div>
          <div><dt className="text-texto-2">Moneda</dt><dd>{d.moneda}{d.tasa && d.moneda !== 'VES' ? ` · tasa ${d.tasa}` : ''}</dd></div>
          <div><dt className="text-texto-2">Registro interno</dt><dd className="font-mono">{d.numero ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Registró</dt><dd>{d.creado_por}</dd></div>
        </dl>
      </Panel>

      <Panel titulo={`Productos facturados (${d.lineas.length})`} className="mt-5">
        <Tabla
          columnas={['Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: `Precio ${d.moneda}`, derecha: true }, { t: 'Precio de la orden', derecha: true },
            { t: 'Diferencia', derecha: true }, { t: 'IVA %', derecha: true }, { t: `Base ${d.moneda}`, derecha: true }, ...(borrador ? [] : ['Conciliación']),
            ...(puedeEditar ? [''] : [])]}
          vacio="Agregue lo que facturó el proveedor.">
          {d.lineas.map((l) => (
            <tr key={l.id}>
              <Celda mono>{l.codigo}</Celda>
              <Celda>{l.descripcion}</Celda>
              <Celda derecha mono>{Number(l.cantidad)}</Celda>
              <Celda derecha mono>{monto(l.precio_unitario)}</Celda>
              <Celda derecha mono className="text-texto-2">{l.precio_orden ? monto(l.precio_orden) : '—'}</Celda>
              <Celda derecha mono className={Number(l.dif_precio ?? 0) > 0 ? 'text-red-300' : Number(l.dif_precio ?? 0) < 0 ? 'text-emerald-300' : 'text-texto-2'}>
                {l.dif_precio ? monto(l.dif_precio) : '—'}
              </Celda>
              <Celda derecha mono className="text-texto-2">{Number(l.alicuota_pct)}</Celda>
              <Celda derecha mono>{monto(l.base)}</Celda>
              {!borrador && (
                <Celda>
                  {l.dentro_tolerancia === null ? '—' : <Etiqueta tono={l.dentro_tolerancia ? 'exito' : 'advertencia'}>{l.dentro_tolerancia ? 'dentro de tolerancia' : 'fuera de tolerancia'}</Etiqueta>}
                </Celda>
              )}
              {puedeEditar && (
                <Celda>
                  <Formulario accion={quitarLineaFacturaAccion}>
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="linea_id" value={l.id} />
                    <BotonEnviar variante="peligro">Quitar</BotonEnviar>
                  </Formulario>
                </Celda>
              )}
            </tr>
          ))}
        </Tabla>
        {!borrador && (
          <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
            <dt className="text-texto-2">Base imponible</dt><dd className="text-right font-mono">{monto(d.base_imponible)}</dd>
            <dt className="text-texto-2">Exento</dt><dd className="text-right font-mono">{monto(d.exento)}</dd>
            <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">{monto(d.iva)}</dd>
            <dt className="font-semibold">Total {d.moneda}</dt><dd className="text-right font-mono font-semibold">{monto(d.total)}</dd>
            {d.moneda !== 'USD' && <><dt className="text-texto-2">Equivale a US$</dt><dd className="text-right font-mono">{monto(d.total_usd)}</dd></>}
          </dl>
        )}

        {puedeEditar && (
          <div className="mt-5 border-t border-borde pt-4">
            <p className="mb-3 text-sm text-texto-2">Solo se factura lo recibido y aún no facturado de cada producto.</p>
            <Tabla columnas={['Producto', { t: 'Recibido', derecha: true }, { t: 'Ya facturado', derecha: true }, { t: 'Por facturar', derecha: true }, { t: 'Precio de la orden', derecha: true }, 'Facturado por el proveedor']}
              vacio="La orden no tiene productos.">
              {d.por_facturar.map((l) => (
                <tr key={l.orden_linea_id}>
                  <Celda><span className="font-mono">{l.codigo}</span> <span className="text-texto-2">{l.descripcion}</span></Celda>
                  <Celda derecha mono>{Number(l.recibido)}</Celda>
                  <Celda derecha mono>{Number(l.facturado)}</Celda>
                  <Celda derecha mono>{Number(l.por_facturar)}</Celda>
                  <Celda derecha mono>{monto(l.precio_orden)}</Celda>
                  <Celda>
                    {Number(l.por_facturar) > 0 ? (
                      <Formulario accion={guardarLineaFacturaAccion} className="flex items-end gap-2">
                        <input type="hidden" name="id" value={id} />
                        <input type="hidden" name="orden_linea_id" value={l.orden_linea_id} />
                        <input name="cantidad" required inputMode="decimal" placeholder="Cantidad" defaultValue={Number(l.por_facturar)} className="campo w-24" />
                        <input name="precio" required inputMode="decimal" placeholder="Precio" defaultValue={Number(l.precio_orden)} className="campo w-28" />
                        <BotonEnviar>Agregar</BotonEnviar>
                      </Formulario>
                    ) : <span className="text-texto-2">—</span>}
                  </Celda>
                </tr>
              ))}
            </Tabla>
          </div>
        )}
      </Panel>

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarFacturaAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar se contabiliza con la diferencia de precio incluida en el costo y se abre la cuenta por pagar.</p>
              <BotonEnviar>Aprobar factura</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarFacturaAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar factura</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}

      {puedeEditar && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {d.lineas.length > 0 && (
              <Formulario accion={registrarFacturaAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-sm text-sm text-texto-2">
                  Al registrarla se concilia con la orden y la recepción. Dentro de tolerancia se contabiliza sola; si no, queda retenida para Gerencia. Ya no se edita.
                </p>
                <BotonEnviar>Registrar y conciliar</BotonEnviar>
              </Formulario>
            )}
            <Formulario accion={eliminarFacturaAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
