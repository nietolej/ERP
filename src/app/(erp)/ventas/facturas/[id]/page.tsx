import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { PROVEEDOR_SIMULADO } from '@/lib/fiscal/imprenta';
import { monto, tasa } from '@/lib/formato';
import { listarMotivos } from '@/lib/maestros/motivos';
import { verTodosLosDocumentos } from '@/lib/ventas/pedidos';
import { ROLES_FACTURAN, ROLES_VEN_FACTURAS, detalleFactura } from '@/lib/ventas/facturas';
import { ROLES_CREAN_NOTAS, notasDeFactura } from '@/lib/ventas/notas';
import { anularFacturaAccion, asignarControlAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FacturaPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_FACTURAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const f = await detalleFactura(db, id);
  if (!f) notFound();
  if (!verTodosLosDocumentos(u) && f.vendedor_usuario !== u.id) notFound();

  const emitida = f.estado === 'emitido';
  const factura = tieneRol(u, ROLES_FACTURAN);
  const sinCobros = f.saldo !== null && Number(f.saldo) === Number(f.total);
  const motivos = emitida && factura ? (await listarMotivos(db, { tipo: 'anulacion', soloActivos: true })).filter((m) => !m.sistema) : [];
  const simulada = f.imprenta === PROVEEDOR_SIMULADO;
  const notas = await notasDeFactura(db, id);
  const puedeNotas = tieneRol(u, [...ROLES_CREAN_NOTAS]);

  return (
    <>
      <Encabezado titulo={`Factura ${f.numero}`} descripcion={`${f.cliente_codigo} · ${f.cliente}`}>
        <div className="flex items-center gap-3">
          {f.estado === 'anulado' ? <Etiqueta tono="peligro">Anulada</Etiqueta>
            : f.contingencia ? <Etiqueta tono="advertencia">Contingencia</Etiqueta>
            : <Etiqueta tono="exito">Emitida</Etiqueta>}
          <Link href={`/ventas/facturas/${id}/imprimir`} className="text-sm text-acento hover:underline">Vista para imprimir</Link>
          <Link href="/ventas/facturas" className="text-sm text-texto-2 hover:text-texto">← Facturas</Link>
        </div>
      </Encabezado>

      {simulada && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Número de control de PRUEBA (simulador): no tiene validez fiscal. Todavía no hay proveedor de imprenta digital contratado.
          </Aviso>
        </div>
      )}
      {emitida && f.contingencia && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Factura en contingencia: no tiene número de control. {f.contingencia_motivo}
            {factura && (
              <Formulario accion={asignarControlAccion} className="mt-3">
                <input type="hidden" name="id" value={id} />
                <BotonEnviar variante="secundario">Pedir el número de control</BotonEnviar>
              </Formulario>
            )}
          </Aviso>
        </div>
      )}
      {f.estado === 'anulado' && <div className="mb-5"><Aviso tono="peligro">Anulada: {f.anulado_motivo}</Aviso></div>}

      <Panel titulo="Datos de la factura">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Número de factura</dt><dd className="font-mono">{f.serie}-{f.numero}</dd></div>
          <div><dt className="text-texto-2">Número de control</dt><dd className="font-mono">{f.numero_control ?? 'Pendiente'}</dd></div>
          <div><dt className="text-texto-2">Imprenta</dt><dd>{f.imprenta ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Emitida</dt><dd>{f.fecha}</dd></div>
          <div><dt className="text-texto-2">Vence</dt><dd>{f.vencimiento ?? '—'} <span className="text-texto-2">({f.condicion_pago ?? 'sin condición'})</span></dd></div>
          <div><dt className="text-texto-2">Tasa BCV (Bs. por US$)</dt><dd className="font-mono">{tasa(f.tasa)}</dd></div>
          <div><dt className="text-texto-2">Cliente</dt><dd>{f.cliente} <span className="font-mono text-texto-2">{f.cliente_rif}</span></dd></div>
          <div><dt className="text-texto-2">Vendedor</dt><dd>{f.vendedor ?? '—'}</dd></div>
          <div>
            <dt className="text-texto-2">Notas de entrega</dt>
            <dd className="flex flex-wrap gap-2">
              {f.notas.map((n) => <Link key={n.id} href={`/ventas/notas-entrega/${n.id}`} className="font-mono text-acento hover:underline">{n.numero}</Link>)}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel titulo={`Productos (${f.lineas.length})`} className="mt-5">
        <Tabla columnas={['Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: 'Precio Bs.', derecha: true }, { t: 'Desc. %', derecha: true },
          { t: 'IVA %', derecha: true }, { t: 'Total Bs.', derecha: true }]}>
          {f.lineas.map((l) => (
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
          <dt className="text-texto-2">Subtotal</dt><dd className="text-right font-mono">{monto(f.subtotal, 'Bs. ')}</dd>
          <dt className="text-texto-2">Descuento</dt><dd className="text-right font-mono">{monto(f.descuento, 'Bs. ')}</dd>
          {f.desglose.map((d) => (
            <div key={d.alicuota_pct} className="col-span-2 grid grid-cols-2">
              <dt className="text-texto-2">{Number(d.alicuota_pct) > 0 ? `Base imponible ${Number(d.alicuota_pct)} %` : 'Exento'}</dt>
              <dd className="text-right font-mono">{monto(d.base, 'Bs. ')}</dd>
            </div>
          ))}
          <dt className="text-texto-2">IVA</dt><dd className="text-right font-mono">{monto(f.iva, 'Bs. ')}</dd>
          <dt className="font-semibold">Total</dt><dd className="text-right font-mono font-semibold">{monto(f.total, 'Bs. ')}</dd>
          <dt className="text-texto-2">Equivalente en US$</dt><dd className="text-right font-mono text-texto-2">{monto(f.total_usd, 'US$ ')}</dd>
        </dl>
      </Panel>

      <Panel titulo="Cuenta por cobrar" className="mt-5">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Saldo pendiente</dt><dd className="font-mono">{f.saldo === null ? '—' : monto(f.saldo, 'Bs. ')}</dd></div>
          <div><dt className="text-texto-2">Estado de la partida</dt><dd>{f.partida_estado ?? '—'}</dd></div>
        </dl>
      </Panel>

      {emitida && (
        <Panel titulo="Notas de crédito y débito" className="mt-5">
          {notas.length > 0 ? (
            <ul className="mb-3 divide-y divide-borde text-sm">
              {notas.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/ventas/notas/${n.id}`} className="text-acento hover:underline">
                    {n.tipo === 'nota_credito' ? 'Nota de crédito' : 'Nota de débito'} <span className="font-mono">{n.numero ?? '(borrador)'}</span>
                  </Link>
                  <span className="text-texto-2">
                    {n.estado === 'emitido' ? 'Emitida' : n.situacion === 'pendiente_aprobacion' ? 'Por aprobar' : n.situacion === 'aprobada' ? 'Por emitir' : n.situacion === 'rechazada' ? 'Rechazada' : 'Borrador'}
                    {' · '}Bs. {monto(n.total)}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="mb-3 text-sm text-texto-2">Esta factura no tiene notas.</p>}
          {puedeNotas && (
            <div className="flex gap-4 text-sm">
              <Link href={`/ventas/notas/nueva?factura=${id}&tipo=credito`} className="text-acento hover:underline">Nueva nota de crédito</Link>
              <Link href={`/ventas/notas/nueva?factura=${id}&tipo=debito`} className="text-acento hover:underline">Nueva nota de débito</Link>
            </div>
          )}
        </Panel>
      )}

      {emitida && factura && (
        <Panel titulo="Anular la factura" className="mt-5">
          {sinCobros && !notas.some((n) => n.estado !== 'anulado') ? (
            <Formulario accion={anularFacturaAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="max-w-xl text-sm text-texto-2">
                Se genera el asiento inverso, la cuenta por cobrar se anula y sus notas de entrega quedan libres para facturarse de nuevo.
                El número de esta factura no se reutiliza y sigue en el libro como anulada.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Campo etiqueta="Motivo de la anulación">
                  <select name="motivo_id" required defaultValue="" className="campo w-64">
                    <option value="" disabled>Seleccione…</option>
                    {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Detalle"><input name="detalle" maxLength={200} className="campo w-72" placeholder="Obligatorio si elige Otro" /></Campo>
              </div>
              <BotonEnviar variante="peligro">Anular factura</BotonEnviar>
            </Formulario>
          ) : (
            <Aviso>Esta factura tiene cobros o notas aplicados: no se anula, se corrige con una nota de crédito.</Aviso>
          )}
        </Panel>
      )}
    </>
  );
}
