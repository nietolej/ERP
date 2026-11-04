import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TablaRetenciones } from '@/components/compras/tabla-retenciones';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { PanelAdjuntos } from '@/components/panel-adjuntos';
import { Aviso, Campo, Encabezado, Etiqueta, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { retencionesDe } from '@/lib/compras/retenciones';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, monto } from '@/lib/formato';
import { NOMBRE_ESTADO_GASTO, ROLES_VEN_GASTOS, detalleGastoProveedor } from '@/lib/gastos/gastos';
import { aprobarGastoAccion, rechazarGastoAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { pendiente: 'advertencia', contabilizado: 'exito', rechazado: 'peligro' } as const;

export default async function GastoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_GASTOS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleGastoProveedor(db, id);
  if (!d) notFound();

  const pendiente = d.estado === 'pendiente';
  const puedeDecidir = pendiente && (await puedeDecidirObjeto(db, u.id, 'gasto_proveedor', id));
  const retenciones = d.estado === 'contabilizado' ? await retencionesDe(db, { gastoProveedorId: id }) : [];

  return (
    <>
      <Encabezado titulo={`Gasto N° ${d.numero}`} descripcion={`${d.proveedor} · ${d.categoria}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_GASTO[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/gastos" className="text-sm text-texto-2 hover:text-texto">← Gastos</Link>
        </div>
      </Encabezado>

      {pendiente && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Mientras no se apruebe no hay cuenta por pagar, retenciones ni asiento.</Aviso></div>}
      {pendiente && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe decidir otra persona de Gerencia: quien registró el gasto ({d.creador}) no lo aprueba.</Aviso></div>
      )}
      {d.estado === 'rechazado' && <div className="mb-5"><Aviso tono="peligro">Rechazado: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'contabilizado' && (
        <div className="mb-5"><Aviso tono="exito">Aprobado por {d.aprobado_por} el {d.aprobado}. Asiento {d.asiento ?? '—'}. Saldo por pagar: {d.moneda} {monto(d.saldo ?? '0')}.</Aviso></div>
      )}

      <Panel titulo="Factura del proveedor">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Factura</dt><dd className="font-mono">{d.numero_factura}</dd></div>
          <div><dt className="text-texto-2">Número de control</dt><dd className="font-mono">{d.numero_control}</dd></div>
          <div><dt className="text-texto-2">Fecha / vence</dt><dd>{fecha(d.fecha_factura)} / {fecha(d.fecha_vencimiento)}</dd></div>
          <div><dt className="text-texto-2">Cuenta de gasto</dt><dd>{d.cuenta}</dd></div>
          <div><dt className="text-texto-2">Moneda y tasa</dt><dd className="font-mono">{d.moneda}{d.moneda !== 'VES' ? ` · tasa ${d.tasa}` : ''}</dd></div>
          <div><dt className="text-texto-2">Registró</dt><dd>{d.creador} · {d.creado}</dd></div>
          <div className="md:col-span-3"><dt className="text-texto-2">Descripción</dt><dd>{d.descripcion}</dd></div>
        </dl>
        <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          <dt className="text-texto-2">Monto sin IVA</dt><dd className="text-right font-mono">{monto(d.base)}</dd>
          <dt className="text-texto-2">IVA ({Number(d.alicuota_pct)} %)</dt><dd className="text-right font-mono">{monto(d.iva)}</dd>
          <dt className="font-semibold">Total {d.moneda}</dt><dd className="text-right font-mono font-semibold">{monto(d.total)}</dd>
          {d.moneda !== 'USD' && <><dt className="text-texto-2">Equivale a US$</dt><dd className="text-right font-mono">{monto(d.total_usd)}</dd></>}
        </dl>
        <p className="mt-3 text-xs text-texto-2">
          {d.iva_deducible ? 'El IVA va a crédito fiscal.' : 'La categoría no admite crédito fiscal: el IVA se suma al gasto.'} Al aprobar se practican las retenciones que correspondan
          (si la empresa es agente de retención) y la cuenta por pagar nace por el neto.
        </p>
      </Panel>

      <TablaRetenciones filas={retenciones} moneda={d.moneda} />

      <PanelAdjuntos tipo="gasto_proveedor" entidadId={d.id} usuario={u} titulo="Soporte de la factura" className="mt-5" />

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarGastoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar se practican las retenciones, nace la cuenta por pagar y se contabiliza, todo en el mismo acto.</p>
              <BotonEnviar>Aprobar gasto</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarGastoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar gasto</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
