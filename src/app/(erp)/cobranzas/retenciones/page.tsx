import Decimal from 'decimal.js';
import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';
import { buscarClientes } from '@/lib/maestros/clientes';
import {
  documentosRetenibles, listarRetenciones, porcentajesIva, ROLES_REGISTRAN_RETENCIONES, ROLES_VEN_RETENCIONES,
} from '@/lib/ventas/retenciones';
import { anularRetencionAccion, registrarRetencionAccion } from './acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Retenciones de IVA e ISLR que nos practican los clientes (migración 0059). */
export default async function RetencionesRecibidasPage({ searchParams }: { searchParams: Promise<{ cliente?: string; periodo?: string; impuesto?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_RETENCIONES);
  const sp = await searchParams;
  const db = await getDb();
  const registra = tieneRol(u, [...ROLES_REGISTRAN_RETENCIONES]);
  const clienteId = sp.cliente && UUID.test(sp.cliente) ? sp.cliente : '';
  const periodo = sp.periodo && /^\d{4}-\d{2}$/.test(sp.periodo) ? sp.periodo : hoyCaracas().slice(0, 7);
  const impuesto = sp.impuesto === 'iva' || sp.impuesto === 'islr' ? sp.impuesto : '';
  const [filas, clientes, documentos, porcentajes] = await Promise.all([
    listarRetenciones(db, { periodo, impuesto }),
    registra ? buscarClientes(db, u, { estado: '' }, 3000) : Promise.resolve([]),
    registra && clienteId ? documentosRetenibles(db, clienteId) : Promise.resolve([]),
    porcentajesIva(db),
  ]);
  const vigentes = filas.filter((f) => f.estado === 'registrada');
  const totalIva = vigentes.filter((f) => f.impuesto === 'iva').reduce((s, f) => s.plus(f.monto), new Decimal(0));
  const totalIslr = vigentes.filter((f) => f.impuesto === 'islr').reduce((s, f) => s.plus(f.monto), new Decimal(0));

  return (
    <>
      <Encabezado titulo="Retenciones de clientes"
        descripcion="Comprobantes de retención de IVA e ISLR que entregan los clientes agentes de retención. Cada uno reduce la cuenta por cobrar del documento retenido; el IVA retenido se descuenta en la declaración de IVA del mes del comprobante." />

      {registra && (
        <Panel titulo="Registrar un comprobante recibido" className="mb-5">
          <form className="mb-4 flex flex-wrap items-end gap-3">
            <Campo etiqueta="Cliente">
              <select name="cliente" defaultValue={clienteId} className="campo" required>
                <option value="" disabled>Seleccione…</option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.razon_social}</option>)}
              </select>
            </Campo>
            <button className="rounded-lg border border-borde bg-white/5 px-3 py-2 text-sm hover:bg-white/10">Ver sus documentos</button>
          </form>
          {clienteId && (documentos.length ? (
            <Formulario accion={registrarRetencionAccion} className="grid gap-4 sm:grid-cols-4">
              <Campo etiqueta="Factura o nota de débito">
                <select name="documento_id" required defaultValue="" className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {documentos.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.etiqueta} · IVA Bs. {monto(d.iva)} · saldo Bs. {monto(d.saldo)}{d.retenido_iva ? ' · IVA ya retenido' : ''}{d.retenido_islr ? ' · ISLR ya retenido' : ''}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo etiqueta="Impuesto">
                <select name="impuesto" defaultValue="iva" className="campo">
                  <option value="iva">IVA</option>
                  <option value="islr">ISLR</option>
                </select>
              </Campo>
              <Campo etiqueta="N° del comprobante" ayuda="IVA: 14 dígitos (año, mes y correlativo)."><input name="comprobante" required className="campo font-mono" autoComplete="off" /></Campo>
              <Campo etiqueta="Fecha del comprobante"><input name="fecha" type="date" required max={hoyCaracas()} className="campo" /></Campo>
              <Campo etiqueta="Porcentaje" ayuda={`IVA: ${porcentajes.map((p) => `${Number(p)} %`).join(' o ')} (parámetros fiscales). ISLR: el del comprobante.`}>
                <input name="porcentaje" required inputMode="decimal" defaultValue={Number(porcentajes[0])} className="campo" />
              </Campo>
              <Campo etiqueta="Base (Bs.)" ayuda="IVA: el IVA sujeto (vacío = todo el IVA del documento). ISLR: la base retenida.">
                <input name="base" inputMode="decimal" className="campo" />
              </Campo>
              <Campo etiqueta="ISLR retenido (Bs.)" ayuda="Solo ISLR. En IVA el monto lo calcula el sistema.">
                <input name="monto" inputMode="decimal" className="campo" />
              </Campo>
              <Campo etiqueta="Observaciones"><input name="observaciones" className="campo" /></Campo>
              <div className="sm:col-span-4 flex justify-end"><BotonEnviar>Registrar retención</BotonEnviar></div>
            </Formulario>
          ) : (
            <p className="text-sm text-texto-2">Ese cliente no tiene facturas ni notas de débito en bolívares con saldo por cobrar.</p>
          ))}
          <p className="mt-3 text-xs text-texto-2">
            Si el cliente paga el documento neto de la retención, aplique el cobro sin marcar «liquida»: el saldo que queda es lo que cubre el comprobante.
          </p>
        </Panel>
      )}

      <Panel titulo={`Retenciones que se declaran en ${periodo.slice(5)}-${periodo.slice(0, 4)}`}>
        <form className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <Campo etiqueta="Mes de la declaración"><input type="month" name="periodo" defaultValue={periodo} className="campo" /></Campo>
          <Campo etiqueta="Impuesto">
            <select name="impuesto" defaultValue={impuesto} className="campo">
              <option value="">IVA e ISLR</option><option value="iva">IVA</option><option value="islr">ISLR</option>
            </select>
          </Campo>
          <button className="rounded-lg border border-borde bg-white/5 px-3 py-2 hover:bg-white/10">Ver</button>
          <span className="ml-auto text-texto-2">IVA retenido: <b className="font-mono text-texto">Bs. {monto(totalIva.toFixed(2))}</b> · ISLR retenido: <b className="font-mono text-texto">Bs. {monto(totalIslr.toFixed(2))}</b></span>
        </form>
        <Tabla columnas={['N°', 'Impuesto', 'Cliente', 'Documento', 'Comprobante', 'Fecha', { t: 'Base Bs.', derecha: true }, { t: '%', derecha: true }, { t: 'Retenido Bs.', derecha: true }, 'Estado', '']}
          vacio="No hay retenciones que se declaren en ese mes.">
          {filas.map((f) => (
            <tr key={f.id}>
              <Celda mono>{f.numero}</Celda>
              <Celda>{f.impuesto.toUpperCase()}</Celda>
              <Celda>{f.cliente_codigo} · {f.cliente}</Celda>
              <Celda><Link href={`/ventas/${f.documento_tipo === 'factura' ? 'facturas' : 'notas'}/${f.documento_id}`} className="text-acento hover:underline">{f.documento_tipo === 'factura' ? 'Factura' : 'ND'} {f.documento_numero}</Link></Celda>
              <Celda mono>{f.numero_comprobante}</Celda>
              <Celda className="text-texto-2">{f.fecha_comprobante}</Celda>
              <Celda derecha mono>{monto(f.base)}</Celda>
              <Celda derecha mono>{Number(f.porcentaje)}</Celda>
              <Celda derecha mono>{monto(f.monto)}</Celda>
              <Celda>{f.estado === 'registrada' ? <Etiqueta tono="exito">Registrada</Etiqueta> : <Etiqueta tono="peligro">Anulada</Etiqueta>}{f.anulado_motivo && <span className="block text-xs text-texto-2">{f.anulado_motivo}</span>}</Celda>
              <Celda>
                {registra && f.estado === 'registrada' && (
                  <details>
                    <summary className="cursor-pointer text-xs text-acento">Anular</summary>
                    <Formulario accion={anularRetencionAccion} className="mt-2 grid gap-2">
                      <input type="hidden" name="id" value={f.id} />
                      <input name="motivo" required placeholder="Motivo" className="campo" />
                      <BotonEnviar variante="peligro">Anular</BotonEnviar>
                    </Formulario>
                  </details>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
