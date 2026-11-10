import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM, soloLoSuyo } from '@/lib/crm/comun';
import { detalleCotizacion } from '@/lib/crm/cotizaciones';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto, tasa } from '@/lib/formato';
import { listarMotivos } from '@/lib/maestros/motivos';
import { estadoCotizacionAccion, lineaCotizacionAccion } from '../../acciones';

export default async function CotizacionPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const { id } = await params;
  const db = await getDb();
  const q = await detalleCotizacion(db, id);
  if (!q || (soloLoSuyo(u) && q.vendedor_usuario !== u.id)) notFound();
  const trabaja = tieneRol(u, [...ROLES_CRM]);
  const borrador = q.estado === 'borrador';
  const motivos = borrador && trabaja ? (await listarMotivos(db, { tipo: 'descuento', soloActivos: true })).filter((m) => !m.sistema) : [];
  const oculto = (accion: string) => (<><input type="hidden" name="id" value={id} /><input type="hidden" name="accion" value={accion} /></>);

  return (
    <>
      <Encabezado titulo={q.numero ? `Cotización ${q.numero}` : 'Cotización en borrador'} descripcion={`${q.tercero}${q.prospecto ? ' (prospecto)' : ''} · ${q.rif}`}>
        <div className="flex items-center gap-3">
          {q.vencida ? <Etiqueta tono="advertencia">Vencida</Etiqueta> : <Etiqueta tono={q.estado === 'anulada' ? 'peligro' : q.estado === 'convertida' ? 'exito' : 'info'}>{q.estado}</Etiqueta>}
          <Link href="/crm/cotizaciones" className="text-sm text-texto-2 hover:text-texto">← Cotizaciones</Link>
        </div>
      </Encabezado>
      {q.estado === 'anulada' && <div className="mb-5"><Aviso tono="peligro">Anulada: {q.anulado_motivo}</Aviso></div>}
      {q.pedido_id && <div className="mb-5"><Aviso tono="exito">Convertida en el <Link href={`/ventas/pedidos/${q.pedido_id}`} className="underline">pedido {q.pedido_numero ?? 'en borrador'}</Link>.</Aviso></div>}

      <Panel titulo="Datos">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div><dt className="text-texto-2">Cliente o prospecto</dt><dd><Link href={`/crm/terceros/${q.tercero_id}`} className="text-acento hover:underline">{q.tercero}</Link></dd></div>
          <div><dt className="text-texto-2">Vendedor</dt><dd>{q.vendedor}</dd></div>
          <div><dt className="text-texto-2">Almacén</dt><dd>{q.almacen}</dd></div>
          <div><dt className="text-texto-2">Lista de precio</dt><dd>{q.lista_precio}</dd></div>
          <div><dt className="text-texto-2">Emitida</dt><dd>{q.fecha ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Vigente hasta</dt><dd>{q.vigente_hasta ?? '—'}</dd></div>
          {q.tasa && <div><dt className="text-texto-2">Tasa BCV (Bs. por US$)</dt><dd className="font-mono">{tasa(q.tasa)}</dd></div>}
          <div><dt className="text-texto-2">Registró</dt><dd>{q.creado_por}</dd></div>
          {q.observaciones && <div className="md:col-span-4"><dt className="text-texto-2">Observaciones</dt><dd>{q.observaciones}</dd></div>}
        </dl>
      </Panel>

      <Panel titulo={`Productos (${q.lineas.length})`} className="mt-5">
        <Tabla columnas={['Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: 'Precio US$', derecha: true }, { t: 'Desc. %', derecha: true }, { t: 'IVA %', derecha: true }, { t: 'Base US$', derecha: true }, { t: 'Total US$', derecha: true }, '']}
          vacio="Agregue los productos de la cotización.">
          {q.lineas.map((l) => (
            <tr key={l.id}>
              <Celda mono>{l.codigo}</Celda>
              <Celda>{l.descripcion}{l.motivo && <span className="block text-xs text-texto-2">{l.motivo}</span>}</Celda>
              <Celda derecha mono>{Number(l.cantidad)}</Celda>
              <Celda derecha mono>{monto(l.precio_unitario)}</Celda>
              <Celda derecha mono>{Number(l.descuento_pct)}</Celda>
              <Celda derecha mono>{Number(l.alicuota_pct)}</Celda>
              <Celda derecha mono>{monto(l.base)}</Celda>
              <Celda derecha mono>{monto(l.total)}</Celda>
              <Celda>
                {borrador && trabaja && (
                  <Formulario accion={lineaCotizacionAccion}>
                    <input type="hidden" name="id" value={id} /><input type="hidden" name="linea_id" value={l.id} />
                    <BotonEnviar variante="secundario">Quitar</BotonEnviar>
                  </Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
        <dl className="mt-4 ml-auto grid max-w-sm grid-cols-2 gap-y-1 text-sm">
          <dt className="text-texto-2">Subtotal</dt><dd className="text-right font-mono">US$ {monto(q.subtotal)}</dd>
          <dt className="text-texto-2">Descuento</dt><dd className="text-right font-mono">US$ {monto(q.descuento)}</dd>
          <dt className="text-texto-2">Base imponible</dt><dd className="text-right font-mono">US$ {monto(q.base_imponible)}</dd>
          <dt className="text-texto-2">Exento</dt><dd className="text-right font-mono">US$ {monto(q.exento)}</dd>
          <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">US$ {monto(q.iva)}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-mono font-semibold">US$ {monto(q.total)}</dd>
          <dt className="text-texto-2">Equivalente</dt><dd className="text-right font-mono text-texto-2">Bs. {monto(q.total_ves)}</dd>
        </dl>

        {borrador && trabaja && (
          <Formulario accion={lineaCotizacionAccion} className="mt-5 grid gap-3 border-t border-borde pt-4 sm:grid-cols-5">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Código del producto"><input name="codigo" required autoComplete="off" className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="Cantidad"><input name="cantidad" required inputMode="decimal" defaultValue="1" className="campo" /></Campo>
            <Campo etiqueta="Descuento %" ayuda="Vacío: el pactado con el cliente."><input name="descuento" inputMode="decimal" className="campo" /></Campo>
            <Campo etiqueta="Motivo del descuento">
              <select name="motivo_id" defaultValue="" className="campo">
                <option value="">—</option>
                {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </Campo>
            <div className="flex items-end justify-end"><BotonEnviar variante="secundario">Agregar</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>

      {trabaja && (borrador || q.estado === 'emitida') && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-end gap-6">
            {borrador && (
              <>
                <Formulario accion={estadoCotizacionAccion} className="flex flex-wrap items-end gap-3">
                  {oculto('emitir')}
                  <Campo etiqueta="Vigente hasta"><input name="vigente_hasta" type="date" required min={hoyCaracas()} className="campo" /></Campo>
                  <BotonEnviar>Emitir</BotonEnviar>
                </Formulario>
                <Formulario accion={estadoCotizacionAccion}>{oculto('eliminar')}<BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
              </>
            )}
            {q.estado === 'emitida' && (
              <Formulario accion={estadoCotizacionAccion} className="flex flex-wrap items-end gap-3">
                {oculto('anular')}
                <Campo etiqueta="Motivo de la anulación"><input name="motivo" required className="campo" /></Campo>
                <BotonEnviar variante="peligro">Anular</BotonEnviar>
              </Formulario>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
