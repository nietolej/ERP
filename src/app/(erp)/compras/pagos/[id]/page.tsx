import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_ESTADO_PAGO, ROLES_PAGAN, ROLES_VEN_PAGOS, detallePago, partidasPorPagar } from '@/lib/compras/pagos';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, monto } from '@/lib/formato';
import { listarMotivos } from '@/lib/maestros/motivos';
import { aplicarAnticipoPagoAccion, anularPagoAccion, aprobarPagoAccion, rechazarPagoAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { solicitado: 'advertencia', pagado: 'exito', rechazado: 'peligro', anulado: 'info' } as const;

export default async function PagoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PAGOS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detallePago(db, id);
  if (!d) notFound();

  const solicitado = d.estado === 'solicitado';
  const pagado = d.estado === 'pagado';
  const puedeDecidir = solicitado && (await puedeDecidirObjeto(db, u.id, 'pago_proveedor', id));
  const puedeOperar = tieneRol(u, ROLES_PAGAN);
  const anticipo = pagado && Number(d.por_aplicar) > 0;
  const [motivos, abiertas] = await Promise.all([
    pagado && puedeOperar ? listarMotivos(db, { tipo: 'anulacion', soloActivos: true }) : Promise.resolve([]),
    anticipo && puedeOperar ? partidasPorPagar(db, d.proveedor_id) : Promise.resolve([]),
  ]);

  return (
    <>
      <Encabezado titulo={`Pago N° ${d.numero}`} descripcion={d.proveedor}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_PAGO[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/compras/pagos" className="text-sm text-texto-2 hover:text-texto">← Pagos</Link>
        </div>
      </Encabezado>

      {solicitado && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Mientras no se apruebe no se aplica a las facturas, no sale del banco y no hay asiento.</Aviso></div>}
      {solicitado && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe decidir otra persona de Gerencia: quien solicitó el pago ({d.creador}) no lo aprueba.</Aviso></div>
      )}
      {d.estado === 'rechazado' && <div className="mb-5"><Aviso tono="peligro">Rechazado: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'anulado' && <div className="mb-5"><Aviso tono="peligro">Anulado el {d.anulado}: {d.anulado_motivo}</Aviso></div>}
      {pagado && <div className="mb-5"><Aviso tono="exito">Aprobado por {d.aprobado_por} el {d.aprobado}. Asiento {d.asiento ?? '—'}.{anticipo ? ` Anticipo por aplicar: ${d.moneda} ${monto(d.por_aplicar)}.` : ''}</Aviso></div>}

      <Panel titulo="Datos del pago">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Fecha</dt><dd>{fecha(d.fecha)}</dd></div>
          <div><dt className="text-texto-2">Cuenta · instrumento</dt><dd>{d.cuenta} · {d.instrumento}</dd></div>
          <div><dt className="text-texto-2">Referencia</dt><dd className="font-mono">{d.referencia ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Monto</dt><dd className="font-mono">{d.moneda} {monto(d.monto)}</dd></div>
          <div><dt className="text-texto-2">Tasa BCV de la fecha</dt><dd className="font-mono">{d.moneda === 'VES' ? '—' : d.tasa}</dd></div>
          <div><dt className="text-texto-2">Equivale a</dt><dd className="font-mono">Bs. {monto(d.monto_ves)} · US$ {monto(d.monto_usd)}</dd></div>
          <div><dt className="text-texto-2">Solicitó</dt><dd>{d.creador} · {d.creado}</dd></div>
          {d.observaciones && <div className="md:col-span-2"><dt className="text-texto-2">Observaciones</dt><dd>{d.observaciones}</dd></div>}
        </dl>
      </Panel>

      <Panel titulo={solicitado ? 'Facturas que se pagarán' : 'Facturas solicitadas'} className="mt-5">
        <Tabla columnas={['Factura', { t: `Monto (${d.moneda})`, derecha: true }, { t: 'Saldo hoy', derecha: true }, 'Liquida']} vacio="Sin facturas: todo el monto es un anticipo al proveedor.">
          {d.lineas.map((l) => (
            <tr key={l.partida_id}>
              <Celda mono>{l.factura}</Celda>
              <Celda derecha mono>{monto(l.monto)}</Celda>
              <Celda derecha mono>{l.moneda} {monto(l.saldo)}</Celda>
              <Celda>{l.liquida ? 'Sí' : '—'}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {d.aplicaciones.length > 0 && (
        <Panel titulo="Aplicaciones y diferencial cambiario" className="mt-5">
          <Tabla columnas={['Origen', 'Fecha', 'Factura', { t: 'Pagado', derecha: true }, { t: 'Cancela de la factura', derecha: true }, { t: 'Valor histórico Bs', derecha: true },
            { t: 'Valor histórico US$', derecha: true }, { t: 'Diferencial Bs', derecha: true }, { t: 'Diferencial US$', derecha: true }]}>
            {d.aplicaciones.map((a) => (
              <tr key={a.id} className={a.revertida ? 'opacity-50' : ''}>
                <Celda>{a.origen === 'registro' ? 'Al pagar' : 'Anticipo'}{a.revertida ? ' (revertida)' : ''}</Celda>
                <Celda className="text-texto-2">{fecha(a.fecha)}</Celda>
                <Celda mono>{a.factura}</Celda>
                <Celda derecha mono>{d.moneda} {monto(a.monto_pago)}</Celda>
                <Celda derecha mono>{a.moneda_partida} {monto(a.monto_partida)}</Celda>
                <Celda derecha mono>{monto(a.ves_partida)}</Celda>
                <Celda derecha mono>{monto(a.usd_partida)}</Celda>
                <Celda derecha mono className={Number(a.dif_ves) > 0 ? 'text-exito' : Number(a.dif_ves) < 0 ? 'text-peligro' : ''}>{monto(a.dif_ves)}</Celda>
                <Celda derecha mono className={Number(a.dif_usd) > 0 ? 'text-exito' : Number(a.dif_usd) < 0 ? 'text-peligro' : ''}>{monto(a.dif_usd)}</Celda>
              </tr>
            ))}
          </Tabla>
          <p className="mt-3 text-xs text-texto-2">Diferencial positivo = se pagó menos de lo que valía la factura (ganancia, 4.2.01); negativo = se pagó más (pérdida, 6.3.02).</p>
        </Panel>
      )}

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarPagoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar se aplica a las facturas, sale del banco y se contabiliza, todo en el mismo acto.</p>
              <BotonEnviar>Aprobar pago</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarPagoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar pago</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}

      {anticipo && puedeOperar && (
        <Panel titulo="Aplicar el anticipo a facturas" className="mt-5">
          {abiertas.length === 0 ? <Aviso>El proveedor no tiene facturas por pagar a las que aplicar el anticipo.</Aviso> : (
            <Formulario accion={aplicarAnticipoPagoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Tabla columnas={['Aplicar', 'Factura', { t: 'Saldo', derecha: true }, { t: `Monto (${d.moneda})`, derecha: true }, 'Liquida']}>
                {abiertas.map((p) => (
                  <tr key={p.partida_id}>
                    <Celda><input type="checkbox" name="partida" value={p.partida_id} className="h-4 w-4" aria-label={`Aplicar a ${p.factura}`} /></Celda>
                    <Celda mono>{p.factura}</Celda>
                    <Celda derecha mono>{p.moneda} {monto(p.saldo)}</Celda>
                    <Celda derecha><input name={`monto_${p.partida_id}`} defaultValue={p.moneda === d.moneda ? p.saldo : ''} inputMode="decimal" className="campo w-36 text-right" aria-label={`Monto de ${p.factura}`} /></Celda>
                    <Celda><input type="checkbox" name={`liquida_${p.partida_id}`} value="1" className="h-4 w-4" aria-label={`Liquida ${p.factura}`} /></Celda>
                  </tr>
                ))}
              </Tabla>
              <BotonEnviar>Aplicar anticipo</BotonEnviar>
            </Formulario>
          )}
        </Panel>
      )}

      {pagado && puedeOperar && tieneRol(u, ['gerencia', 'tesoreria']) && (
        <Panel titulo="Anular el pago" className="mt-5">
          <Formulario accion={anularPagoAccion} className="grid gap-3 md:grid-cols-[16rem_1fr_auto] md:items-end">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Motivo">
              <select name="motivo_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Detalle" ayuda="Obligatorio si el motivo es «Otro»."><input name="detalle" maxLength={200} className="campo" /></Campo>
            <BotonEnviar variante="peligro">Anular pago</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Revierte el asiento y las facturas recuperan su saldo. Un pago con un anticipo ya aplicado a facturas no se anula.</p>
        </Panel>
      )}
    </>
  );
}
