import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import {
  NOMBRE_ESTADO_APERTURA, NOMBRE_TIPO_APERTURA, ROLES_APERTURA_BANCO, ROLES_APERTURA_CXC, ROLES_APERTURA_CXP, ROLES_VEN_APERTURA, buscarAperturas, controlApertura, estadoArranque,
} from '@/lib/apertura/apertura';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { cerrarAperturaAccion, decidirAperturaAccion, fijarFechaAccion, registrarBancoAccion, registrarCxcAccion, registrarCxpAccion } from './acciones';

const TONO = { pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;
const OBJETO = { banco: 'apertura_banco', cxc: 'apertura_cxc', cxp: 'apertura_cxp', inventario: 'apertura_inventario' } as const;

export default async function AperturaPage() {
  const u = await exigirRol(...ROLES_VEN_APERTURA);
  const db = await getDb();
  const e = await estadoArranque(db);
  const [c, docs] = await Promise.all([controlApertura(db), buscarAperturas(db)]);
  const esGerencia = tieneRol(u, ['gerencia']);
  const abierta = Boolean(e.fecha) && !e.cerrada;
  const puedeBanco = abierta && tieneRol(u, [...ROLES_APERTURA_BANCO]);
  const puedeCxc = abierta && tieneRol(u, [...ROLES_APERTURA_CXC]);
  const puedeCxp = abierta && tieneRol(u, [...ROLES_APERTURA_CXP]);
  const opciones = abierta && (puedeBanco || puedeCxc || puedeCxp)
    ? await Promise.all([
      db.query<{ id: string; texto: string; moneda: string }>(`select id, codigo || ' · ' || nombre || ' · ' || moneda as texto, moneda from cuenta_bancaria where activa order by codigo`),
      db.query<{ id: string; texto: string }>(`select c.tercero_id as id, c.codigo || ' · ' || t.razon_social as texto from cliente c join tercero t on t.id = c.tercero_id where c.estado = 'activo' order by t.razon_social limit 800`),
      db.query<{ id: string; texto: string }>(`select p.tercero_id as id, p.codigo || ' · ' || t.razon_social as texto from proveedor p join tercero t on t.id = p.tercero_id where p.estado = 'activo' order by t.razon_social limit 800`),
      db.query<{ id: string; texto: string }>(`select id, codigo || ' · ' || nombre as texto from sucursal where activa order by codigo`),
    ])
    : null;
  const hoy = hoyCaracas();

  return (
    <>
      <Encabezado titulo="Apertura: saldos iniciales"
        descripcion="La empresa empieza con saldos, y cada uno se registra como una operación del día de arranque contra «Saldos de apertura». Los registra su responsable y Gerencia, distinta de quien los registró, los aprueba; nada se importa de otros sistemas." />

      <Panel titulo="Fecha de arranque" className="mb-5">
        {e.fecha ? (
          <p className="text-sm">Arranque el <strong>{fecha(e.fecha)}</strong>, fijado por {e.fijadaPor}. {e.cerrada ? <>Apertura <Etiqueta tono="exito">cerrada</Etiqueta> por {e.cerradaPor} el {e.cerradaEl}.</> : <Etiqueta tono="advertencia">apertura abierta</Etiqueta>}</p>
        ) : esGerencia ? (
          <Formulario accion={fijarFechaAccion} className="flex flex-wrap items-end gap-3">
            <Campo etiqueta="Fecha de arranque" ayuda="Se fija una sola vez. Su periodo contable debe estar abierto y debe haber tasa BCV."><input type="date" name="fecha" required defaultValue={hoy} className="campo" /></Campo>
            <BotonEnviar>Fijar fecha de arranque</BotonEnviar>
          </Formulario>
        ) : (
          <Aviso tono="advertencia">Gerencia debe fijar la fecha de arranque antes de registrar saldos iniciales.</Aviso>
        )}
      </Panel>

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        {c.totales.map((t) => <KpiCard key={t.tipo} titulo={NOMBRE_TIPO_APERTURA[t.tipo]} valor={`Bs ${monto(t.ves)}`} subtitulo={`${t.documentos} aprobados · US$ ${monto(t.usd)}`} />)}
        <KpiCard titulo="Saldos de apertura (Bs)" valor={monto(c.saldoPuenteVes)} tono={Number(c.saldoPuenteVes) === 0 ? 'exito' : 'advertencia'}
          subtitulo={`US$ ${monto(c.saldoPuenteUsd)} de residuo por tasas históricas (informativo)`} />
      </div>

      <p className="mb-5 text-sm"><Link href="/inventario/apertura" className="font-semibold text-acento hover:underline">Conteo físico inicial de inventario por almacén →</Link></p>

      <Panel titulo="Control de cierre" className="mb-5">
        {c.impedimentos.map((i) => <div key={i} className="mb-3"><Aviso tono="advertencia">{i}</Aviso></div>)}
        {c.puedeCerrar && <div className="mb-3"><Aviso tono="exito">Todo aprobado, «Saldos de apertura» en cero y el mayor cuadra: ya se puede cerrar la apertura.</Aviso></div>}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {tieneRol(u, ['contabilidad']) && abierta && <Link href="/contabilidad/asientos/nuevo?tipo=apertura" className="font-semibold text-acento hover:underline">Registrar el asiento de apertura del contador →</Link>}
          {esGerencia && abierta && (
            <Formulario accion={cerrarAperturaAccion}><BotonEnviar variante="peligro">Cerrar la apertura</BotonEnviar></Formulario>
          )}
        </div>
        <p className="mt-3 text-xs text-texto-2">Al cerrar, la base rechaza nuevos documentos y asientos de apertura. Los documentos de apertura quedan fuera de los indicadores de venta, compra y comisiones, y de los libros de IVA.</p>
      </Panel>

      {opciones && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          {puedeBanco && (
            <Panel titulo="Saldo de banco o caja">
              <Formulario accion={registrarBancoAccion} className="space-y-3">
                <Campo etiqueta="Cuenta (según el estado de cuenta del día anterior al arranque)">
                  <select name="cuenta_bancaria_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{opciones[0].rows.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}</select>
                </Campo>
                <Campo etiqueta="Saldo (en la moneda de la cuenta)"><input name="saldo" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
                <Campo etiqueta="Referencia (opcional)"><input name="referencia" maxLength={60} className="campo" /></Campo>
                <BotonEnviar>Registrar saldo</BotonEnviar>
              </Formulario>
            </Panel>
          )}
          {puedeCxc && (
            <Panel titulo="Factura de venta pendiente de cobro">
              <Formulario accion={registrarCxcAccion} className="grid gap-3 sm:grid-cols-2">
                <Campo etiqueta="Cliente"><select name="cliente_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{opciones[1].rows.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}</select></Campo>
                <Campo etiqueta="Sucursal"><select name="sucursal_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{opciones[3].rows.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}</select></Campo>
                <Campo etiqueta="N° original (solo números)"><input name="numero_original" inputMode="numeric" required className="campo font-mono" /></Campo>
                <Campo etiqueta="N° de control original"><input name="numero_control" maxLength={20} className="campo font-mono" /></Campo>
                <Campo etiqueta="Fecha de la factura"><input type="date" name="fecha_original" required max={e.fecha ?? undefined} className="campo" /></Campo>
                <Campo etiqueta="Vencimiento"><input type="date" name="vencimiento" required className="campo" /></Campo>
                <Campo etiqueta="Saldo pendiente (Bs)"><input name="saldo" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
                <Campo etiqueta="Tasa Bs/US$ de la fecha original"><input name="tasa" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
                <div className="sm:col-span-2"><BotonEnviar>Registrar factura pendiente</BotonEnviar></div>
              </Formulario>
            </Panel>
          )}
          {puedeCxp && (
            <Panel titulo="Factura de compra pendiente de pago">
              <Formulario accion={registrarCxpAccion} className="grid gap-3 sm:grid-cols-2">
                <Campo etiqueta="Proveedor"><select name="proveedor_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{opciones[2].rows.map((x) => <option key={x.id} value={x.id}>{x.texto}</option>)}</select></Campo>
                <Campo etiqueta="Moneda"><select name="moneda" defaultValue="USD" className="campo"><option value="USD">USD</option><option value="VES">VES</option></select></Campo>
                <Campo etiqueta="N° de la factura"><input name="numero_documento" required maxLength={40} className="campo font-mono uppercase" /></Campo>
                <Campo etiqueta="N° de control"><input name="numero_control" maxLength={40} className="campo font-mono uppercase" /></Campo>
                <Campo etiqueta="Fecha de la factura"><input type="date" name="fecha_original" required max={e.fecha ?? undefined} className="campo" /></Campo>
                <Campo etiqueta="Vencimiento"><input type="date" name="vencimiento" required className="campo" /></Campo>
                <Campo etiqueta="Saldo pendiente (en su moneda)"><input name="saldo" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
                <Campo etiqueta="Tasa Bs/US$ de la fecha original"><input name="tasa_usd" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
                <div className="sm:col-span-2"><BotonEnviar>Registrar factura pendiente</BotonEnviar></div>
              </Formulario>
            </Panel>
          )}
        </div>
      )}

      <Panel titulo="Documentos de apertura">
        <Tabla columnas={['N°', 'Tipo', 'Detalle', 'Tercero', { t: 'Saldo', derecha: true }, { t: 'US$', derecha: true }, 'Registró', 'Estado', '']} vacio="Todavía no hay documentos de apertura.">
          {docs.map((d) => (
            <tr key={d.id}>
              <Celda mono>{d.numero}</Celda>
              <Celda>{NOMBRE_TIPO_APERTURA[d.tipo]}</Celda>
              <Celda>{d.descripcion}{d.asiento ? <span className="block text-xs text-texto-2">Asiento {d.asiento}</span> : null}</Celda>
              <Celda>{d.tercero ?? '—'}</Celda>
              <Celda derecha mono>{d.moneda} {monto(d.saldo)}</Celda>
              <Celda derecha mono>{monto(d.saldo_usd)}</Celda>
              <Celda className="text-texto-2">{d.creador} · {d.creado}</Celda>
              <Celda><span title={d.rechazo_motivo ?? undefined}><Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_APERTURA[d.estado] ?? d.estado}</Etiqueta></span></Celda>
              <Celda>
                {esGerencia && d.estado === 'pendiente' && (
                  <div className="flex items-start gap-2">
                    <Formulario accion={decidirAperturaAccion}><input type="hidden" name="tipo" value={OBJETO[d.tipo]} /><input type="hidden" name="id" value={d.id} /><input type="hidden" name="decision" value="aprobar" /><BotonEnviar>Aprobar</BotonEnviar></Formulario>
                    <details>
                      <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">Rechazar</summary>
                      <Formulario accion={decidirAperturaAccion} className="mt-2 space-y-2">
                        <input type="hidden" name="tipo" value={OBJETO[d.tipo]} /><input type="hidden" name="id" value={d.id} /><input type="hidden" name="decision" value="rechazar" />
                        <input name="motivo" required minLength={3} maxLength={200} placeholder="Motivo" aria-label="Motivo del rechazo" className="campo" />
                        <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
                      </Formulario>
                    </details>
                  </div>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
        <p className="mt-3 text-xs text-texto-2">Si quien aprueba es quien registró el documento, la base lo rechaza: otra persona de Gerencia debe aprobarlo.</p>
      </Panel>
    </>
  );
}
