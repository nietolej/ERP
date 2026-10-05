import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { listarMotivos } from '@/lib/maestros/motivos';
import { monto, tasa } from '@/lib/formato';
import { ROLES_SALIDA } from '@/lib/ventas/despacho';
import {
  ROLES_VENDEN, ROLES_VEN_VENTAS, detalleDocumento, puedeTrabajarDocumento, verTodosLosDocumentos,
} from '@/lib/ventas/pedidos';
import { etiquetaDocumento, etiquetaOrden } from '@/lib/ventas/presentacion';
import { confirmarSalidaAccion } from '../../../almacen/acciones';
import { anularNotaAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NotaEntregaPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_VENTAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleDocumento(db, id);
  if (!d || d.tipo !== 'nota_entrega') notFound();
  if (!verTodosLosDocumentos(u) && d.vendedor_usuario !== u.id) notFound();

  const puedeActuar = tieneRol(u, ROLES_VENDEN) && puedeTrabajarDocumento(u, d);
  const e = etiquetaDocumento(d.estado, d.situacion, 'nota_entrega');
  const yaSalio = d.salida !== null;
  const { rows: fac } = await db.query<{ id: string; numero: string }>(
    `select f.id, f.numero::text from documento_venta f join documento_venta n on n.factura_id = f.id where n.id = $1`, [id]);
  const motivosAnulacion = (await listarMotivos(db, { tipo: 'anulacion', soloActivos: true })).filter((m) => !m.sistema);
  const listaParaSalir = d.estado === 'emitido' && !yaSalio && (!d.usa_picking || d.picking_id === null || (d.picking_estado === 'completa' && d.picking_empacado === true));
  const puedeSalida = listaParaSalir && tieneRol(u, ROLES_SALIDA) && (await almacenesVisibles(db, u)).includes(d.almacen_id);

  return (
    <>
      <Encabezado titulo={`Nota de entrega ${d.numero}`} descripcion={`${d.cliente_codigo} · ${d.cliente}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={e.tono}>{e.texto}</Etiqueta>
          <Link href="/ventas/notas-entrega" className="text-sm text-texto-2 hover:text-texto">← Notas de entrega</Link>
        </div>
      </Encabezado>
      {d.estado === 'anulado' && <div className="mb-5"><Aviso tono="peligro">Anulada: {d.anulado_motivo}</Aviso></div>}
      {fac[0] && (
        <div className="mb-5"><Aviso tono="exito">Facturada en la factura <Link href={`/ventas/facturas/${fac[0].id}`} className="font-mono underline">{fac[0].numero}</Link>.</Aviso></div>
      )}
      {yaSalio && !fac[0] && <div className="mb-5"><Aviso tono="exito">La mercancía salió del almacén el {d.salida}. El costo de la venta ya está contabilizado.</Aviso></div>}
      {d.estado === 'emitido' && !yaSalio && (
        <div className="mb-5">
          <Aviso>
            La mercancía de esta nota está reservada y todavía no ha salido del almacén.{' '}
            {d.picking_id ? (
              <>Picking: <Link href={`/almacen/picking/${d.picking_id}`} className="underline">{etiquetaOrden(d.picking_estado ?? '').texto.toLowerCase()}{d.picking_estado === 'completa' && !d.picking_empacado ? ', falta el empaque' : ''}</Link>.</>
            ) : null}
          </Aviso>
        </div>
      )}

      <Panel titulo="Datos de la nota">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Cliente</dt><dd>{d.cliente_codigo} · {d.cliente}</dd></div>
          <div><dt className="text-texto-2">RIF</dt><dd className="font-mono">{d.rif}</dd></div>
          <div>
            <dt className="text-texto-2">Pedido</dt>
            <dd>{d.origen_id ? <Link href={`/ventas/pedidos/${d.origen_id}`} className="font-mono text-acento hover:underline">{d.origen_numero}</Link> : '—'}</dd>
          </div>
          <div><dt className="text-texto-2">Vendedor</dt><dd>{d.vendedor ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Almacén</dt><dd>{d.almacen}</dd></div>
          <div><dt className="text-texto-2">Emitida</dt><dd>{d.fecha ?? '—'}</dd></div>
          {d.tasa && <div><dt className="text-texto-2">Tasa BCV (Bs. por US$)</dt><dd className="font-mono">{tasa(d.tasa)}</dd></div>}
          <div><dt className="text-texto-2">Registró</dt><dd>{d.creado_por}</dd></div>
        </dl>
      </Panel>

      <Panel titulo={`Productos (${d.lineas.length})`} className="mt-5">
        <Tabla columnas={['Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: 'Precio US$', derecha: true }, { t: 'Desc. %', derecha: true }, { t: 'IVA %', derecha: true }, { t: 'Total US$', derecha: true }]}>
          {d.lineas.map((l) => (
            <tr key={l.id}>
              <Celda mono>{l.codigo}</Celda>
              <Celda>{l.descripcion}</Celda>
              <Celda derecha mono>{Number(l.cantidad)}</Celda>
              <Celda derecha mono>{monto(l.precio_unitario)}</Celda>
              <Celda derecha mono>{Number(l.descuento_pct)}</Celda>
              <Celda derecha mono>{Number(l.alicuota_pct)}</Celda>
              <Celda derecha mono>{monto(l.total)}</Celda>
            </tr>
          ))}
        </Tabla>
        <dl className="mt-5 ml-auto grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-texto-2">Base imponible</dt><dd className="text-right font-mono">{monto(d.base_imponible, 'US$ ')}</dd>
          <dt className="text-texto-2">Exento</dt><dd className="text-right font-mono">{monto(d.exento, 'US$ ')}</dd>
          <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">{monto(d.iva, 'US$ ')}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-mono font-semibold">{monto(d.total, 'US$ ')}</dd>
          <dt className="text-texto-2">Equivalente en Bs.</dt><dd className="text-right font-mono text-texto-2">{monto(d.total_ves, 'Bs. ')}</dd>
        </dl>
      </Panel>

      {((puedeActuar && d.estado === 'emitido' && !yaSalio) || puedeSalida) && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {puedeSalida && (
              <Formulario accion={confirmarSalidaAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Descuenta la existencia al costo promedio y registra el costo de la venta en la contabilidad.</p>
                <BotonEnviar>Confirmar salida de mercancía</BotonEnviar>
              </Formulario>
            )}
            {puedeActuar && d.estado === 'emitido' && !yaSalio && (
              <Formulario accion={anularNotaAccion} className="space-y-2">
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
                <BotonEnviar variante="peligro">Anular nota de entrega</BotonEnviar>
              </Formulario>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
