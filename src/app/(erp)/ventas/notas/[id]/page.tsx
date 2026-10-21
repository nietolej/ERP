import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { PROVEEDOR_SIMULADO } from '@/lib/fiscal/imprenta';
import { monto } from '@/lib/formato';
import { NOMBRE_CLASE_NC, NOMBRE_CLASE_ND, ROLES_CREAN_NOTAS, ROLES_EMITEN_NOTAS, ROLES_VEN_NOTAS, detalleNota, type ClaseNC, type ClaseND } from '@/lib/ventas/notas';
import { verTodosLosDocumentos } from '@/lib/ventas/pedidos';
import {
  aprobarNotaAccion, asignarControlNotaAccion, eliminarNotaAccion, emitirNotaAccion, enviarNotaAccion, rechazarNotaAccion,
} from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return <div><dt className="text-texto-2">{etiqueta}</dt><dd>{children === null || children === undefined || children === '' ? '—' : children}</dd></div>;
}

export default async function NotaPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_NOTAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const n = await detalleNota(db, id);
  if (!n) notFound();
  if (!verTodosLosDocumentos(u) && n.vendedor_usuario !== u.id) notFound();

  const esNC = n.tipo === 'nota_credito';
  const emitida = n.estado === 'emitido';
  const puedeCrear = tieneRol(u, [...ROLES_CREAN_NOTAS]);
  const puedeEmitir = tieneRol(u, [...ROLES_EMITEN_NOTAS]);
  const puedeDecidir = n.situacion === 'pendiente_aprobacion' && (await puedeDecidirObjeto(db, u.id, n.tipo, id));
  const clase = esNC ? NOMBRE_CLASE_NC[n.motivo_nc as ClaseNC] : NOMBRE_CLASE_ND[n.motivo_nc as ClaseND];
  const etiqueta = esNC ? 'Nota de crédito' : 'Nota de débito';
  const oculto = (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="tipo" value={n.tipo} />
      <input type="hidden" name="factura_id" value={n.factura_id} />
    </>
  );

  return (
    <>
      <Encabezado titulo={`${etiqueta} ${n.numero ?? '(borrador)'}`} descripcion={`${clase} · sobre la factura ${n.factura} · ${n.cliente_codigo} ${n.cliente}`}>
        <div className="flex items-center gap-3">
          {emitida ? (n.contingencia ? <Etiqueta tono="advertencia">Emitida · contingencia</Etiqueta> : <Etiqueta tono="exito">Emitida</Etiqueta>)
            : n.situacion === 'pendiente_aprobacion' ? <Etiqueta tono="advertencia">Por aprobar</Etiqueta>
            : n.situacion === 'aprobada' ? <Etiqueta tono="info">Aprobada: falta emitirla</Etiqueta>
            : n.situacion === 'rechazada' ? <Etiqueta tono="peligro">Rechazada</Etiqueta>
            : <Etiqueta tono="info">Borrador</Etiqueta>}
          <Link href={`/ventas/facturas/${n.factura_id}`} className="text-sm text-acento hover:underline">Ver la factura</Link>
          <Link href="/ventas/notas" className="text-sm text-texto-2 hover:text-texto">← Notas</Link>
        </div>
      </Encabezado>

      {n.imprenta === PROVEEDOR_SIMULADO && <div className="mb-5"><Aviso tono="advertencia">Número de control de PRUEBA (simulador): no tiene validez fiscal.</Aviso></div>}
      {n.situacion === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {n.rechazo_motivo}</Aviso></div>}
      {emitida && n.contingencia && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Emitida en contingencia: no tiene número de control. {n.contingencia_motivo}
            {puedeEmitir && <Formulario accion={asignarControlNotaAccion} className="mt-3">{oculto}<BotonEnviar variante="secundario">Pedir el número de control</BotonEnviar></Formulario>}
          </Aviso>
        </div>
      )}

      <Panel titulo="Datos de la nota">
        <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-3">
          <Dato etiqueta="Número">{n.numero ? <span className="font-mono">{n.numero}</span> : null}</Dato>
          <Dato etiqueta="Número de control"><span className="font-mono">{emitida ? (n.numero_control ?? 'Pendiente') : null}</span></Dato>
          <Dato etiqueta="Emitida">{n.fecha}</Dato>
          <Dato etiqueta="Motivo del catálogo">{n.motivo}</Dato>
          <Dato etiqueta="Creada por">{n.creador}</Dato>
          <Dato etiqueta="Aprobada por">{n.aprobador}</Dato>
          {!esNC && <Dato etiqueta="Vencimiento de la deuda">{n.vencimiento}</Dato>}
          {esNC && emitida && <Dato etiqueta="Valor en USD que reduce de la factura">{n.usd_aplicado ? monto(n.usd_aplicado, 'US$ ') : null}</Dato>}
          {!esNC && emitida && <Dato etiqueta="Saldo de esta deuda">{n.saldo_nd ? monto(n.saldo_nd, 'Bs. ') : null}</Dato>}
        </dl>
        {n.observaciones && <p className="mt-3 text-sm text-texto-2">{n.observaciones}</p>}
      </Panel>

      <Panel titulo={`Líneas (${n.lineas.length})`} className="mt-5">
        <Tabla columnas={['Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: 'Precio Bs.', derecha: true }, { t: 'IVA %', derecha: true }, { t: 'Base Bs.', derecha: true }, { t: 'IVA Bs.', derecha: true }, { t: 'Total Bs.', derecha: true }]}>
          {n.lineas.map((l) => (
            <tr key={l.id}>
              <Celda mono>{l.codigo}</Celda>
              <Celda>{l.descripcion}</Celda>
              <Celda derecha mono>{Number(l.cantidad)}</Celda>
              <Celda derecha mono>{monto(l.precio_unitario)}</Celda>
              <Celda derecha mono>{Number(l.alicuota_pct)}</Celda>
              <Celda derecha mono>{monto(l.base)}</Celda>
              <Celda derecha mono>{monto(l.iva)}</Celda>
              <Celda derecha mono>{monto(l.total)}</Celda>
            </tr>
          ))}
        </Tabla>
        <dl className="mt-5 ml-auto grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-texto-2">Base imponible</dt><dd className="text-right font-mono">{monto(n.base_imponible, 'Bs. ')}</dd>
          <dt className="text-texto-2">Exento</dt><dd className="text-right font-mono">{monto(n.exento, 'Bs. ')}</dd>
          <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">{monto(n.iva, 'Bs. ')}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-mono font-semibold">{monto(n.total, 'Bs. ')}</dd>
        </dl>
      </Panel>

      {n.asientos.length > 0 && (
        <Panel titulo="Asientos contables" className="mt-5">
          <ul className="space-y-1 text-sm">
            {n.asientos.map((a) => (
              <li key={a.id}><Link href={`/contabilidad/asientos/${a.id}`} className="font-mono text-acento hover:underline">N° {a.numero}</Link>{' '}
                <span className="text-texto-2">{a.evento === 'reingreso_devolucion' ? 'Reingreso de la mercancía al inventario' : esNC ? 'Reducción de la cuenta por cobrar' : 'Nueva cuenta por cobrar'}</span></li>
            ))}
          </ul>
        </Panel>
      )}

      {!emitida && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {n.situacion === null && puedeCrear && (
              <Formulario accion={enviarNotaAccion} className="space-y-2">
                {oculto}
                <p className="max-w-sm text-sm text-texto-2">Al enviarla al Supervisor de ventas, sus líneas ya no se editan.</p>
                <BotonEnviar>Enviar a aprobación</BotonEnviar>
              </Formulario>
            )}
            {n.situacion === 'pendiente_aprobacion' && !puedeDecidir && <p className="text-sm text-texto-2">Espera la aprobación del Supervisor de ventas (una persona distinta de quien la creó).</p>}
            {puedeDecidir && (
              <>
                <Formulario accion={aprobarNotaAccion}>{oculto}<BotonEnviar>Aprobar</BotonEnviar></Formulario>
                <Formulario accion={rechazarNotaAccion} className="flex items-end gap-2">
                  {oculto}
                  <Campo etiqueta="Motivo del rechazo"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
                  <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
                </Formulario>
              </>
            )}
            {n.situacion === 'aprobada' && puedeEmitir && (
              <Formulario accion={emitirNotaAccion} className="space-y-2">
                {oculto}
                <p className="max-w-md text-sm text-texto-2">
                  {esNC
                    ? `Al emitirla reduce el saldo de la factura${n.motivo_nc === 'devolucion' ? ' y reingresa la mercancía al inventario' : ''}. No se anula: se corrige con otra nota.`
                    : 'Al emitirla abre una cuenta por cobrar al cliente. No se anula: se corrige con una nota de crédito.'}
                </p>
                <BotonEnviar>Emitir nota</BotonEnviar>
              </Formulario>
            )}
            {(n.situacion === null || n.situacion === 'rechazada') && puedeCrear && (
              <Formulario accion={eliminarNotaAccion}>{oculto}<BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
