import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirSesion, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';
import {
  NOMBRE_ESTADO_REPOSICION, NOMBRE_ESTADO_VALE, NOMBRE_TIPO_REPOSICION, cuentasOrigen, detalleFondo, reposicionesDeFondo, valesDeFondo, veFondo,
} from '@/lib/gastos/caja-chica';
import { listarCategorias, opcionesGasto } from '@/lib/gastos/gastos';
import { ROLES_SOLICITAN_REPOSICION } from '@/lib/gastos/roles';
import { anularValeAccion, estadoFondoAccion, registrarValeAccion, solicitarConstitucionAccion, solicitarReposicionAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO_VALE = { registrado: 'info', repuesto: 'exito', anulado: 'peligro' } as const;
const TONO_REPOSICION = { pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro' } as const;

export default async function FondoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirSesion();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const f = await detalleFondo(db, id);
  if (!f || !veFondo(u, f)) notFound();

  const [vales, reposiciones, categorias, { alicuotas }, origenes] = await Promise.all([
    valesDeFondo(db, id), reposicionesDeFondo(db, id), listarCategorias(db, true), opcionesGasto(db), cuentasOrigen(db, f.moneda),
  ]);
  const esCustodio = f.custodio_id === u.id;
  const esGerencia = tieneRol(u, ['gerencia']);
  const puedeVale = f.activo && f.constituido && (esCustodio || esGerencia);
  const puedeSolicitar = f.activo && (esCustodio || tieneRol(u, ROLES_SOLICITAN_REPOSICION));
  const pendiente = reposiciones.find((r) => r.estado === 'pendiente');
  const constitucionPendiente = reposiciones.some((r) => r.tipo === 'constitucion' && r.estado === 'pendiente');
  const hoy = hoyCaracas();
  const porReponer = Number(f.por_reponer);

  return (
    <>
      <Encabezado titulo={`${f.codigo} · ${f.nombre}`} descripcion={`Custodio: ${f.custodio} · ${f.moneda} · tope por vale ${f.moneda} ${monto(f.tope_vale)}`}>
        <Link href="/caja-chica" className="text-sm text-texto-2 hover:text-texto">← Caja chica</Link>
      </Encabezado>

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <KpiCard titulo="Monto fijo" valor={`${f.moneda} ${monto(f.monto_fijo)}`} />
        <KpiCard titulo="Efectivo en el fondo" valor={`${f.moneda} ${monto(f.saldo)}`} tono={Number(f.saldo) > 0 ? 'exito' : 'advertencia'} />
        <KpiCard titulo="Gastado por reponer" valor={`${f.moneda} ${monto(f.por_reponer)}`} />
        <KpiCard titulo="En reposición pendiente" valor={`${f.moneda} ${monto(f.en_reposicion)}`} />
      </div>

      {!f.activo && <div className="mb-5"><Aviso tono="advertencia">Este fondo está cerrado.</Aviso></div>}
      {f.activo && !f.constituido && !constitucionPendiente && (
        <div className="mb-5"><Aviso tono="advertencia">El fondo todavía no se ha constituido: pida el dinero al banco para que Gerencia lo apruebe.</Aviso></div>
      )}
      {pendiente && (
        <div className="mb-5"><Aviso tono="advertencia">
          Hay una {pendiente.tipo === 'constitucion' ? 'constitución' : 'reposición'} pendiente de Gerencia por {pendiente.moneda} {monto(pendiente.monto)}.{' '}
          <Link href={`/caja-chica/reposiciones/${pendiente.id}`} className="underline">Verla</Link>
        </Aviso></div>
      )}

      {puedeSolicitar && !pendiente && (!f.constituido || porReponer > 0) && (
        <Panel titulo={f.constituido ? 'Reponer el fondo' : 'Constituir el fondo'} className="mb-5">
          <Formulario accion={f.constituido ? solicitarReposicionAccion : solicitarConstitucionAccion} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="fondo_id" value={id} />
            <Campo etiqueta={`Cuenta de donde sale el dinero (${f.moneda})`}>
              <select name="cuenta_origen_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {origenes.map((o) => <option key={o.id} value={o.id}>{o.texto}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Referencia (opcional)"><input name="referencia" maxLength={60} className="campo" /></Campo>
            <div className="flex items-end">
              <BotonEnviar>{f.constituido ? `Pedir reposición de ${f.moneda} ${monto(f.por_reponer)}` : `Pedir ${f.moneda} ${monto(f.monto_fijo)} para constituirlo`}</BotonEnviar>
            </div>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Gerencia, distinta de quien lo pide, lo aprueba. Hasta entonces no se mueve nada.</p>
        </Panel>
      )}

      {puedeVale && (
        <Panel titulo="Registrar vale" className="mb-5">
          <Formulario accion={registrarValeAccion} className="grid gap-4 sm:grid-cols-4">
            <input type="hidden" name="fondo_id" value={id} />
            <Campo etiqueta="Fecha"><input type="date" name="fecha" required max={hoy} defaultValue={hoy} className="campo" /></Campo>
            <Campo etiqueta="Categoría">
              <select name="categoria_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Pagado a"><input name="beneficiario" required minLength={3} maxLength={120} className="campo" /></Campo>
            <Campo etiqueta="Descripción"><input name="descripcion" required minLength={3} maxLength={200} className="campo" /></Campo>
            <Campo etiqueta="Comprobante (opcional)"><input name="comprobante" maxLength={40} className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta="N° de control" ayuda="Con control (factura fiscal) el IVA es crédito fiscal."><input name="control" maxLength={40} className="campo font-mono uppercase" /></Campo>
            <Campo etiqueta={`Monto sin IVA (${f.moneda})`}><input name="base" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
            <Campo etiqueta="Alícuota de IVA">
              <select name="alicuota_iva_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {alicuotas.map((a) => <option key={a.id} value={a.id}>{a.texto}</option>)}
              </select>
            </Campo>
            <div className="sm:col-span-2">
              <Campo etiqueta="Soporte (PDF, PNG, JPG o WebP, hasta 5 MB)"><input type="file" name="archivo" accept=".pdf,.png,.jpg,.jpeg,.webp" required className="campo" /></Campo>
            </div>
            <div className="flex items-end sm:col-span-2"><BotonEnviar>Registrar vale</BotonEnviar></div>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">
            Un vale no necesita aprobación si no pasa del tope ({f.moneda} {monto(f.tope_vale)}, IVA incluido) ni del efectivo del fondo. Se contabiliza al registrarlo.
          </p>
        </Panel>
      )}

      <Panel titulo="Vales">
        <Tabla columnas={['N°', 'Fecha', 'Categoría', 'Pagado a', { t: 'Total', derecha: true }, 'Estado', 'Reposición', '']} vacio="Todavía no hay vales.">
          {vales.map((v) => (
            <tr key={v.id}>
              <Celda mono>{v.numero}</Celda>
              <Celda className="text-texto-2">{v.fecha}</Celda>
              <Celda>{v.categoria}<span className="block text-xs text-texto-2">{v.descripcion}{v.comprobante ? ` · ${v.comprobante}` : ''}</span></Celda>
              <Celda>{v.beneficiario}</Celda>
              <Celda derecha mono>{v.moneda} {monto(v.total)}{v.iva_credito ? <span className="block text-xs text-texto-2">IVA {monto(v.iva)} a crédito fiscal</span> : null}</Celda>
              <Celda><span title={v.anulado_motivo ?? undefined}><Etiqueta tono={TONO_VALE[v.estado as keyof typeof TONO_VALE] ?? 'info'}>{NOMBRE_ESTADO_VALE[v.estado] ?? v.estado}</Etiqueta></span></Celda>
              <Celda mono className="text-texto-2">{v.reposicion ?? '—'}</Celda>
              <Celda>
                {v.estado === 'registrado' && !v.reposicion && (esCustodio || esGerencia) && (
                  <details>
                    <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">Anular</summary>
                    <Formulario accion={anularValeAccion} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="fondo_id" value={id} />
                      <input name="motivo" required minLength={3} maxLength={200} placeholder="Motivo" aria-label="Motivo de la anulación" className="campo" />
                      <BotonEnviar variante="peligro">Anular vale</BotonEnviar>
                    </Formulario>
                  </details>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Panel titulo="Constituciones y reposiciones" className="mt-5">
        <Tabla columnas={['N°', 'Tipo', { t: 'Monto', derecha: true }, 'Desde', 'Solicitó', 'Estado']} vacio="Sin movimientos de fondeo.">
          {reposiciones.map((r) => (
            <tr key={r.id}>
              <Celda mono><Link href={`/caja-chica/reposiciones/${r.id}`} className="text-acento hover:underline">{r.numero}</Link></Celda>
              <Celda>{NOMBRE_TIPO_REPOSICION[r.tipo]}{r.tipo === 'reposicion' ? <span className="block text-xs text-texto-2">{r.vales} vales</span> : null}</Celda>
              <Celda derecha mono>{r.moneda} {monto(r.monto)}</Celda>
              <Celda className="text-texto-2">{r.cuenta_origen}</Celda>
              <Celda className="text-texto-2">{r.creador} · {r.creado}</Celda>
              <Celda><Etiqueta tono={TONO_REPOSICION[r.estado as keyof typeof TONO_REPOSICION] ?? 'info'}>{NOMBRE_ESTADO_REPOSICION[r.estado] ?? r.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {esGerencia && f.activo && (
        <Panel titulo="Cerrar el fondo" className="mt-5">
          <Formulario accion={estadoFondoAccion} className="flex items-center gap-4">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="activo" value="0" />
            <p className="text-sm text-texto-2">Solo se cierra cuando no tiene efectivo ni vales por reponer: primero devuelva el dinero al banco con un asiento de Contabilidad.</p>
            <BotonEnviar variante="peligro">Cerrar fondo</BotonEnviar>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
