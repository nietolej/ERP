import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { PanelAdjuntos } from '@/components/panel-adjuntos';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { listarMotivos } from '@/lib/maestros/motivos';
import { ROLES_COBRAN, ROLES_VEN_COBROS, detalleCobro, partidasAbiertas } from '@/lib/ventas/cobros';
import { anularCobroAccion, aplicarAnticipoAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { registrado: 'exito', conciliado: 'info', anulado: 'peligro' } as const;

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return <div><dt className="text-texto-2">{etiqueta}</dt><dd>{children === null || children === undefined || children === '' ? '—' : children}</dd></div>;
}

export default async function CobroPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COBROS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const c = await detalleCobro(db, id);
  if (!c) notFound();

  const puedeCobrar = tieneRol(u, [...ROLES_COBRAN]);
  const vigente = c.estado === 'registrado';
  const anticipo = Number(c.por_aplicar) > 0;
  const hayAnticipoAplicado = c.aplicaciones.some((a) => a.origen === 'anticipo' && !a.revertida);
  const [partidas, motivos] = await Promise.all([
    vigente && anticipo && puedeCobrar ? partidasAbiertas(db, c.cliente_id) : Promise.resolve([]),
    vigente && puedeCobrar ? listarMotivos(db, { tipo: 'anulacion', soloActivos: true }) : Promise.resolve([]),
  ]);

  return (
    <>
      <Encabezado titulo={`Cobro ${c.numero}`} descripcion={`${c.cliente_codigo} · ${c.cliente}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[c.estado as keyof typeof TONO] ?? 'info'}>{c.estado}</Etiqueta>
          <Link href="/cobranzas/cobros" className="text-sm text-texto-2 hover:text-texto">← Cobros</Link>
        </div>
      </Encabezado>

      {c.estado === 'anulado' && <div className="mb-5"><Aviso tono="peligro">Anulado el {c.anulado}: {c.anulado_motivo}</Aviso></div>}
      {vigente && anticipo && <div className="mb-5"><Aviso tono="info">Quedan {c.moneda} {monto(c.por_aplicar)} sin aplicar: es un anticipo del cliente (pasivo) hasta que se aplique a una factura.</Aviso></div>}

      <Panel titulo="Datos del cobro">
        <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-3">
          <Dato etiqueta="Fecha">{fecha(c.fecha)}</Dato>
          <Dato etiqueta="Monto">{c.moneda} {monto(c.monto)}</Dato>
          <Dato etiqueta="Tasa BCV">{c.moneda === 'VES' ? '—' : monto(c.tasa)}</Dato>
          <Dato etiqueta="Valor en los libros">Bs. {monto(c.monto_ves)} · US$ {monto(c.monto_usd)}</Dato>
          <Dato etiqueta="Instrumento">{c.instrumento}</Dato>
          <Dato etiqueta="Cuenta">{c.cuenta}</Dato>
          <Dato etiqueta="Referencia">{c.referencia}</Dato>
          <Dato etiqueta="Registrado por">{c.creador} · {c.creado}</Dato>
          <Dato etiqueta="Asiento">{c.asiento_id ? <Link href={`/contabilidad/asientos/${c.asiento_id}`} className="font-mono text-acento hover:underline">N° {c.asiento}</Link> : null}</Dato>
        </dl>
        {c.observaciones && <p className="mt-3 text-sm text-texto-2">{c.observaciones}</p>}
      </Panel>

      <Panel titulo={`Aplicación a facturas (${c.aplicaciones.length})`} className="mt-5">
        <Tabla columnas={['Factura', 'Fecha', 'Origen', { t: `Aplicado (${c.moneda})`, derecha: true }, { t: 'Cancela Bs', derecha: true }, { t: 'Cancela USD', derecha: true },
          { t: 'Cobrado USD', derecha: true }, { t: 'Diferencial USD', derecha: true }, '']} vacio="Este cobro no se ha aplicado a ninguna factura: es un anticipo.">
          {c.aplicaciones.map((a) => (
            <tr key={a.id} className={a.revertida ? 'opacity-50' : ''}>
              <Celda mono>{a.factura}</Celda>
              <Celda>{fecha(a.fecha)}</Celda>
              <Celda className="text-texto-2">{a.origen === 'registro' ? 'Al registrar' : 'Anticipo'}</Celda>
              <Celda derecha>{monto(a.monto_cobro)}</Celda>
              <Celda derecha>{monto(a.monto_partida)}</Celda>
              <Celda derecha>{monto(a.usd_partida)}</Celda>
              <Celda derecha>{monto(a.base_usd)}</Celda>
              <Celda derecha className={Number(a.dif_usd) > 0 ? 'text-amber-200' : 'text-texto-2'}>{Number(a.dif_usd) > 0 ? `pérdida ${monto(a.dif_usd)}` : Number(a.dif_usd) < 0 ? `ganancia ${monto(Math.abs(Number(a.dif_usd)).toFixed(2))}` : '—'}</Celda>
              <Celda>{a.revertida && <Etiqueta tono="info">revertida</Etiqueta>}</Celda>
            </tr>
          ))}
        </Tabla>
        <p className="mt-3 text-xs text-texto-2">El diferencial es la diferencia entre lo que valía la factura en USD a su tasa de emisión y lo que vale lo cobrado a la tasa de la aplicación.</p>
      </Panel>

      {vigente && anticipo && puedeCobrar && (
        <Panel titulo="Aplicar el anticipo a facturas" className="mt-5">
          <Formulario accion={aplicarAnticipoAccion} className="space-y-4">
            <input type="hidden" name="id" value={c.id} />
            <div className="max-w-xs"><Campo etiqueta="Fecha de la aplicación" ayuda="Hoy o desde la fecha del cobro. Su tasa BCV convierte lo aplicado."><input type="date" name="fecha" defaultValue={hoyCaracas()} min={c.fecha} max={hoyCaracas()} className="campo" /></Campo></div>
            <Tabla columnas={['Factura', 'Vence', { t: 'Saldo Bs', derecha: true }, { t: 'Saldo USD', derecha: true }, { t: `Aplicar (${c.moneda})`, derecha: true }, 'Liquida']}
              vacio="El cliente no tiene facturas con saldo por cobrar.">
              {partidas.map((p) => (
                <tr key={p.partida_id}>
                  <Celda mono>{p.factura}</Celda>
                  <Celda>{fecha(p.vencimiento)}</Celda>
                  <Celda derecha>{monto(p.saldo)}</Celda>
                  <Celda derecha>{monto(p.saldo_usd)}</Celda>
                  <Celda derecha><input name={`ap_${p.partida_id}`} inputMode="decimal" aria-label={`Aplicar a la factura ${p.factura}`} className="campo w-32 text-right tabular-nums" /></Celda>
                  <Celda><input type="checkbox" name={`liq_${p.partida_id}`} aria-label={`El anticipo liquida la factura ${p.factura}`} /></Celda>
                </tr>
              ))}
            </Tabla>
            {partidas.length > 0 && <BotonEnviar>Aplicar anticipo</BotonEnviar>}
          </Formulario>
        </Panel>
      )}

      {vigente && puedeCobrar && (
        <Panel titulo="Anular el cobro" className="mt-5">
          {hayAnticipoAplicado ? (
            <p className="text-sm text-texto-2">Este cobro tiene un anticipo ya aplicado a facturas: no se anula. Corrija esas aplicaciones con una nota de crédito.</p>
          ) : (
            <details>
              <summary className="cursor-pointer text-sm text-red-200 hover:underline">Anular cobro</summary>
              <Formulario accion={anularCobroAccion} className="mt-3 grid gap-3 md:grid-cols-3 md:items-end">
                <input type="hidden" name="id" value={c.id} />
                <Campo etiqueta="Motivo">
                  <select name="motivo_id" required defaultValue="" className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Detalle" ayuda="Obligatorio si el motivo es «Otro»."><input name="detalle" maxLength={200} className="campo" /></Campo>
                <div><BotonEnviar variante="peligro">Anular cobro</BotonEnviar></div>
              </Formulario>
              <p className="mt-2 text-xs text-texto-2">Se reversa el asiento y las facturas recuperan su saldo.</p>
            </details>
          )}
        </Panel>
      )}

      <PanelAdjuntos tipo="cobro" entidadId={c.id} usuario={u} titulo="Comprobante de pago" className="mt-5" />
    </>
  );
}
