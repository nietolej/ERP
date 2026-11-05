import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_PAGAN_COMISIONES, ROLES_VEN_COMISIONES, detalleLiquidacion } from '@/lib/comisiones/comisiones';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { decidirLiquidacionAccion, pagarLiquidacionAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { pendiente: 'advertencia', aprobada: 'info', pagada: 'exito', rechazada: 'peligro' } as const;

export default async function LiquidacionPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMISIONES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleLiquidacion(db, u, id);
  if (!d) notFound();
  const l = d.liquidacion;
  const puedeDecidir = l.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'liquidacion_comision', id)) && l.vendedor_usuario !== u.id;
  const puedePagar = l.estado === 'aprobada' && tieneRol(u, ROLES_PAGAN_COMISIONES);
  const cuentas = puedePagar
    ? (await db.query<{ id: string; texto: string }>(`select id, codigo || ' · ' || nombre || ' · ' || moneda as texto from cuenta_bancaria where activa and moneda in ('VES', 'USD') order by codigo`)).rows
    : [];

  return (
    <>
      <Encabezado titulo={`Liquidación N° ${l.numero}`} descripcion={`${l.vendedor} · ${l.periodo} · armada por ${l.creador}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[l.estado as keyof typeof TONO] ?? 'info'}>{l.estado}</Etiqueta>
          <Link href="/comisiones/liquidaciones" className="text-sm text-texto-2 hover:text-texto">← Liquidaciones</Link>
        </div>
      </Encabezado>
      {l.estado === 'pendiente' && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia.{l.vendedor_usuario === u.id ? ' Usted es el vendedor beneficiario: no la puede aprobar.' : ''}</Aviso></div>}
      {l.estado === 'aprobada' && <div className="mb-5"><Aviso tono="info">Aprobada por {l.aprobador}. Falta el pago de Tesorería.</Aviso></div>}
      {l.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {l.rechazo_motivo}. Sus movimientos quedaron libres para armarse de nuevo.</Aviso></div>}
      {l.estado === 'pagada' && <div className="mb-5"><Aviso tono="exito">Pagada el {fecha(l.fecha_pago)} desde {l.cuenta}{l.referencia ? ` (ref. ${l.referencia})` : ''} a la tasa {l.tasa_pago}.</Aviso></div>}
      {l.estado === 'aprobada' && l.vendedor_tipo === 'externo' && (
        <div className="mb-5"><Aviso tono="advertencia">Vendedor externo: su pago exige retención de ISLR sobre la comisión y ese cálculo todavía no está construido, por lo que el sistema no la paga sin retener.</Aviso></div>
      )}

      <Panel titulo="Importes" className="mb-5">
        <dl className="grid gap-3 text-sm md:grid-cols-4">
          <div><dt className="text-texto-2">Devengado</dt><dd className="font-semibold">US$ {monto(l.total_devengado_usd)}</dd></div>
          <div><dt className="text-texto-2">Reversiones</dt><dd className="font-semibold text-red-300">US$ {monto(l.total_reversiones_usd)}</dd></div>
          <div><dt className="text-texto-2">Neto a pagar</dt><dd className="font-semibold">US$ {monto(l.neto_usd)}</dd></div>
          <div><dt className="text-texto-2">Valor en libros</dt><dd className="font-semibold">Bs {monto(l.neto_ves)}</dd></div>
        </dl>
      </Panel>

      <Panel titulo="Movimientos incluidos" className="mb-5">
        <Tabla columnas={['Fecha', 'Tipo', 'Origen', 'Factura', { t: 'Base (US$)', derecha: true }, { t: '%', derecha: true }, { t: 'Comisión (US$)', derecha: true }]}>
          {d.movimientos.map((m) => (
            <tr key={m.id}>
              <Celda>{fecha(m.fecha)}</Celda>
              <Celda><Etiqueta tono={m.tipo === 'devengo' ? 'exito' : 'peligro'}>{m.tipo === 'devengo' ? 'devengo' : 'reversión'}</Etiqueta></Celda>
              <Celda>{m.origen}</Celda><Celda mono>{m.factura}</Celda>
              <Celda derecha>{monto(m.baseUsd)}</Celda><Celda derecha>{Number(m.porcentaje).toFixed(2)}</Celda>
              <Celda derecha className={m.tipo === 'reversion' ? 'text-red-300' : ''}>{monto(m.montoUsd)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mb-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={decidirLiquidacionAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="aprobada" />
              <BotonEnviar>Aprobar liquidación</BotonEnviar>
            </Formulario>
            <Formulario accion={decidirLiquidacionAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="rechazada" />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar liquidación</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
      {puedePagar && l.vendedor_tipo !== 'externo' && (
        <Panel titulo="Pago de Tesorería">
          <Formulario accion={pagarLiquidacionAccion} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Cuenta de donde sale"><select name="cuenta_bancaria_id" required className="campo w-80">{cuentas.map((c) => <option key={c.id} value={c.id}>{c.texto}</option>)}</select></Campo>
            <Campo etiqueta="Fecha del pago"><input type="date" name="fecha" defaultValue={hoyCaracas()} required className="campo" /></Campo>
            <Campo etiqueta="Referencia"><input name="referencia" maxLength={60} className="campo" /></Campo>
            <BotonEnviar>Pagar US$ {monto(l.neto_usd)}</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Sale del banco al dólar BCV de la fecha; la diferencia contra el valor en libros de la comisión va a diferencial cambiario.</p>
        </Panel>
      )}
    </>
  );
}
