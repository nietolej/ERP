import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';
import {
  NOMBRE_MES, ROLES_CIERRAN, ROLES_CONCILIAN, ROLES_VEN_CONCILIACION, candidatosDe, detalleExtracto, enTransito, lineasDeExtracto, proponer, resumen,
} from '@/lib/tesoreria/conciliacion';
import {
  agregarLineaAccion, cerrarExtractoAccion, confirmarParesAccion, desconciliarAccion, eliminarLineaAccion, emparejarAccion, importarCsvAccion, saldosExtractoAccion,
} from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ExtractoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ linea?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CONCILIACION);
  const { id } = await params;
  const { linea: lineaElegida = '' } = await searchParams;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const e = await detalleExtracto(db, id);
  if (!e) notFound();

  const abierto = e.estado === 'abierto';
  const concilia = abierto && tieneRol(u, ROLES_CONCILIAN);
  const [r, lineas, transito] = await Promise.all([resumen(db, id), lineasDeExtracto(db, id), enTransito(db, id)]);
  const propuestas = concilia ? (await proponer(db, id)).filter((p) => p.candidatos.length > 0) : [];
  const porId = new Map(lineas.map((l) => [l.id, l]));
  const candidatos = concilia && UUID.test(lineaElegida) && porId.get(lineaElegida) && !porId.get(lineaElegida)!.asiento ? await candidatosDe(db, lineaElegida) : [];
  const mon = e.moneda;
  const cierra = abierto && tieneRol(u, ROLES_CIERRAN);

  return (
    <>
      <Encabezado titulo={`Conciliación de ${NOMBRE_MES[e.mes - 1]} ${e.anio}`} descripcion={e.cuenta}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={abierto ? 'advertencia' : 'exito'}>{abierto ? 'abierto' : `cerrado por ${e.cerrado_por}`}</Etiqueta>
          <Link href="/tesoreria/conciliacion" className="text-sm text-texto-2 hover:text-texto">← Conciliaciones</Link>
        </div>
      </Encabezado>

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <KpiCard titulo="Saldo final del banco" valor={`${mon} ${monto(r.saldo_final)}`} />
        <KpiCard titulo="Saldo en el mayor" valor={`${mon} ${monto(r.mayor)}`} />
        <KpiCard titulo="En tránsito (mayor sin pareja)" valor={`${mon} ${monto(r.transito)}`} />
        <KpiCard titulo="Diferencia" valor={`${mon} ${monto(r.diferencia)}`} tono={r.cuadra ? 'exito' : 'peligro'}
          subtitulo={r.cuadra ? 'mayor = banco + en tránsito' : 'mayor − (banco + en tránsito)'} />
      </div>
      {!r.banco_cuadra && <div className="mb-5"><Aviso tono="peligro">El saldo inicial ({monto(r.saldo_inicial)}) más los movimientos cargados ({monto(r.movimientos)}) no da el saldo final del banco: falta o sobra alguna línea del extracto.</Aviso></div>}
      {abierto && r.pendientes > 0 && <div className="mb-5"><Aviso tono="advertencia">Hay {r.pendientes} movimientos del banco sin conciliar. Si no tienen asiento (comisiones, intereses), Contabilidad debe registrarlo primero.</Aviso></div>}
      {abierto && r.puede_cerrar && <div className="mb-5"><Aviso tono="exito">Todo conciliado y el saldo cuadra con el mayor: ya se puede cerrar el mes.</Aviso></div>}

      {concilia && propuestas.length > 0 && (
        <Panel titulo="Pares propuestos" className="mb-5">
          <Formulario accion={confirmarParesAccion} className="space-y-3">
            <input type="hidden" name="id" value={id} />
            <Tabla columnas={['Confirmar', 'Movimiento del banco', { t: 'Monto', derecha: true }, 'Asiento propuesto', 'Diferencia de días', 'Referencia']}>
              {propuestas.map((p) => {
                const l = porId.get(p.linea_id)!;
                const c = p.candidatos[0];
                return (
                  <tr key={p.linea_id}>
                    <Celda><input type="checkbox" name="par" value={`${p.linea_id}:${c.asiento_linea_id}`} defaultChecked={p.unica} className="h-4 w-4" aria-label={`Confirmar ${l.descripcion}`} /></Celda>
                    <Celda>{l.fecha} · {l.descripcion}{l.referencia ? <span className="block text-xs text-texto-2">Ref. {l.referencia}</span> : null}</Celda>
                    <Celda derecha mono>{mon} {monto(l.monto)}</Celda>
                    <Celda>Asiento {c.asiento} · {fecha(c.fecha)}<span className="block text-xs text-texto-2">{c.descripcion}</span></Celda>
                    <Celda className="text-texto-2">{c.dias}{p.candidatos.length > 1 ? ` · ${p.candidatos.length} opciones` : ''}{!p.unica ? ' · revisar' : ''}</Celda>
                    <Celda>{c.referencia_coincide ? <Etiqueta tono="exito">coincide</Etiqueta> : <span className="text-texto-2">{c.referencia ?? '—'}</span>}</Celda>
                  </tr>
                );
              })}
            </Tabla>
            <p className="text-xs text-texto-2">Revise cada par: solo se guardan los marcados. Los no únicos (otro movimiento compite por el mismo asiento) vienen sin marcar.</p>
            <BotonEnviar>Confirmar los pares marcados</BotonEnviar>
          </Formulario>
        </Panel>
      )}

      <Panel titulo={`Movimientos del banco (${lineas.length})`}>
        <Tabla columnas={['Fecha', 'Descripción', 'Referencia', { t: 'Monto', derecha: true }, 'Asiento', '']} vacio="Todavía no se han cargado movimientos.">
          {lineas.map((l) => (
            <tr key={l.id}>
              <Celda className="text-texto-2">{l.fecha}</Celda>
              <Celda>{l.descripcion}</Celda>
              <Celda mono className="text-texto-2">{l.referencia ?? '—'}</Celda>
              <Celda derecha mono>{mon} {monto(l.monto)}</Celda>
              <Celda>{l.asiento ? <span title={l.conciliador ?? undefined}><Etiqueta tono="exito">asiento {l.asiento}</Etiqueta></span> : <Etiqueta tono="advertencia">pendiente</Etiqueta>}</Celda>
              <Celda>
                {concilia && !l.asiento && (
                  <div className="flex items-center gap-3 text-xs">
                    <Link href={`/tesoreria/conciliacion/${id}?linea=${l.id}`} className="text-acento hover:underline">Emparejar</Link>
                    <Formulario accion={eliminarLineaAccion}><input type="hidden" name="id" value={id} /><input type="hidden" name="linea_id" value={l.id} /><BotonEnviar variante="peligro">Quitar</BotonEnviar></Formulario>
                  </div>
                )}
                {concilia && l.asiento && (
                  <Formulario accion={desconciliarAccion}><input type="hidden" name="id" value={id} /><input type="hidden" name="linea_id" value={l.id} /><BotonEnviar variante="peligro">Deshacer</BotonEnviar></Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {candidatos.length > 0 && (
        <Panel titulo={`Emparejar: ${porId.get(lineaElegida)!.descripcion} (${mon} ${monto(porId.get(lineaElegida)!.monto)})`} className="mt-5">
          <Tabla columnas={['Asiento', 'Fecha', 'Descripción', { t: 'Monto en el mayor', derecha: true }, '']}>
            {candidatos.map((c) => (
              <tr key={c.asiento_linea_id}>
                <Celda mono>{c.asiento}</Celda>
                <Celda className="text-texto-2">{fecha(c.fecha)} · {c.dias} d</Celda>
                <Celda>{c.descripcion}</Celda>
                <Celda derecha mono>{mon} {monto(c.neto)}{!c.mismo_monto ? <span className="block text-xs text-peligro">monto distinto</span> : null}</Celda>
                <Celda>
                  {c.mismo_monto ? (
                    <Formulario accion={emparejarAccion}>
                      <input type="hidden" name="id" value={id} /><input type="hidden" name="linea_id" value={lineaElegida} /><input type="hidden" name="asiento_linea_id" value={c.asiento_linea_id} />
                      <BotonEnviar>Emparejar</BotonEnviar>
                    </Formulario>
                  ) : null}
                </Celda>
              </tr>
            ))}
          </Tabla>
          <p className="mt-3 text-xs text-texto-2">Solo se empareja un asiento del mismo monto. Si el banco cobró algo que no está en libros, Contabilidad registra el asiento y luego se empareja.</p>
        </Panel>
      )}

      <Panel titulo={`En tránsito: asientos del banco sin pareja hasta fin de mes (${transito.length})`} className="mt-5">
        <Tabla columnas={['Asiento', 'Fecha', 'Descripción', { t: 'Monto', derecha: true }]} vacio="Nada en tránsito.">
          {transito.map((t) => (
            <tr key={t.asiento_linea_id}>
              <Celda mono>{t.asiento}</Celda>
              <Celda className="text-texto-2">{fecha(t.fecha)}</Celda>
              <Celda>{t.descripcion}</Celda>
              <Celda derecha mono>{mon} {monto(t.neto)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {concilia && (
        <Panel titulo="Cargar movimientos" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={importarCsvAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="CSV del banco" ayuda="Columnas: fecha (dd-mm-aaaa), descripción, referencia (opcional) y monto con signo, o ingreso y egreso. Todo o nada.">
                <input type="file" name="archivo" accept=".csv,.txt" required className="campo" />
              </Campo>
              <BotonEnviar>Importar CSV</BotonEnviar>
            </Formulario>
            <Formulario accion={agregarLineaAccion} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Fecha"><input type="date" name="fecha" required className="campo" /></Campo>
              <Campo etiqueta="Monto (egreso con signo −)"><input name="monto" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
              <Campo etiqueta="Descripción"><input name="descripcion" required maxLength={200} className="campo" /></Campo>
              <Campo etiqueta="Referencia"><input name="referencia" maxLength={60} className="campo font-mono" /></Campo>
              <div className="sm:col-span-2"><BotonEnviar>Agregar movimiento</BotonEnviar></div>
            </Formulario>
          </div>
          <Formulario accion={saldosExtractoAccion} className="mt-6 grid gap-3 sm:grid-cols-3 sm:items-end">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Saldo inicial del banco"><input name="saldo_inicial" inputMode="decimal" required defaultValue={r.saldo_inicial} className="campo text-right font-mono" /></Campo>
            <Campo etiqueta="Saldo final del banco"><input name="saldo_final" inputMode="decimal" required defaultValue={r.saldo_final} className="campo text-right font-mono" /></Campo>
            <BotonEnviar>Corregir saldos</BotonEnviar>
          </Formulario>
        </Panel>
      )}

      {cierra && (
        <Panel titulo="Cerrar el mes" className="mt-5">
          <Formulario accion={cerrarExtractoAccion} className="flex flex-wrap items-center gap-4">
            <input type="hidden" name="id" value={id} />
            <p className="text-sm text-texto-2">Requiere todo conciliado y el saldo cuadrado con el mayor. Quien concilió líneas de este extracto no lo cierra. Un mes cerrado no se modifica.</p>
            <BotonEnviar>Cerrar conciliación</BotonEnviar>
          </Formulario>
        </Panel>
      )}
    </>
  );
}
