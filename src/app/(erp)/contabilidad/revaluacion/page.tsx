import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_PROPONEN_REVALUACION, ROLES_VEN_REVALUACION, estadoRevaluacion, type EstadoRevaluacion } from '@/lib/contabilidad/revaluacion';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { decidirRevaluacionAccion, proponerRevaluacionAccion } from './acciones';

const TONO = { pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro' } as const;

function mesPasado(): string {
  const [a, m] = hoyCaracas().split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

export default async function RevaluacionPage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_REVALUACION);
  const q = await searchParams;
  const mm = /^(\d{4})-(\d{2})$/.exec(q.periodo ?? '');
  const periodo = mm && Number(mm[2]) >= 1 && Number(mm[2]) <= 12 ? q.periodo! : mesPasado();
  const [anio, mes] = periodo.split('-').map(Number);
  const db = await getDb();

  let e: EstadoRevaluacion | null = null;
  let error: string | null = null;
  try {
    e = await estadoRevaluacion(db, anio, mes);
  } catch (x) {
    error = (x as Error).message;
  }
  const r = e?.registro ?? null;
  const puedeDecidir = r?.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'revaluacion_cambiaria', r.id));

  return (
    <>
      <Encabezado titulo="Revaluación cambiaria mensual"
        descripcion="Al cierre del mes, las partidas monetarias en dólares (bancos y cajas, cuentas por pagar y anticipos) se valoran a la tasa BCV del último día; la diferencia contra su valor en libros va a diferencial cambiario. Solo mueve bolívares y se reversa el primer día del mes siguiente.">
        <Link href={`/contabilidad/cierre?periodo=${periodo}`} className="text-sm text-texto-2 hover:text-texto">Cierre mensual →</Link>
      </Encabezado>
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={periodo} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
      </Panel>
      {error && <Aviso tono="advertencia">{error}</Aviso>}
      {e && (
        <div className="space-y-5">
          <Aviso tono={e.ok ? 'exito' : 'advertencia'}>{e.detalle}</Aviso>
          {r && (
            <Aviso tono={TONO[r.estado]}>
              Revaluación {r.estado}: propuesta por {r.creador}{r.aprobador ? `, aprobada por ${r.aprobador}` : ''}.{r.rechazo_motivo ? ` Motivo: ${r.rechazo_motivo}.` : ''}
            </Aviso>
          )}
          <Panel titulo={`Cálculo al ${fecha(e.calculo.fin)} · tasa BCV ${e.calculo.tasa}`}>
            <Tabla columnas={['Partida', 'Cuenta', 'Naturaleza', { t: 'Saldo (US$)', derecha: true }, { t: 'En libros (Bs)', derecha: true }, { t: 'Revaluado (Bs)', derecha: true }, { t: 'Efecto (Bs)', derecha: true }]}
              vacio="No hay partidas en divisas con diferencia por registrar.">
              {e.calculo.items.map((i) => (
                <tr key={i.clave}>
                  <Celda>{i.concepto}</Celda><Celda mono>{i.codigo}</Celda><Celda>{i.naturaleza}</Celda>
                  <Celda derecha>{monto(i.divisaUsd)}</Celda><Celda derecha>{monto(i.librosVes)}</Celda><Celda derecha>{monto(i.revaluadoVes)}</Celda>
                  <Celda derecha className={i.efectoVes.startsWith('-') ? 'text-red-300' : 'text-emerald-300'}>{monto(i.efectoVes)}</Celda>
                </tr>
              ))}
            </Tabla>
            {e.calculo.items.length > 0 && (
              <p className="mt-3 text-sm text-texto-2">Ganancia por diferencial cambiario: Bs {monto(e.calculo.gananciaVes)} · Pérdida: Bs {monto(e.calculo.perdidaVes)}. Efecto positivo = ganancia.</p>
            )}
          </Panel>
          {!r && e.calculo.items.length > 0 && tieneRol(u, ROLES_PROPONEN_REVALUACION) && (
            <Panel titulo="Proponer la revaluación">
              <Formulario accion={proponerRevaluacionAccion} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="periodo" value={periodo} />
                <BotonEnviar>Proponer al Jefe de contabilidad</BotonEnviar>
              </Formulario>
              <p className="mt-3 text-xs text-texto-2">Lo aprueba el Jefe de contabilidad, distinto de quien propone. Al aprobar se contabiliza el ajuste y su reverso.</p>
            </Panel>
          )}
          {puedeDecidir && r && (
            <Panel titulo="Decisión del Jefe de contabilidad">
              <div className="grid gap-6 md:grid-cols-2">
                <Formulario accion={decidirRevaluacionAccion} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="aprobada" />
                  <BotonEnviar>Aprobar y contabilizar</BotonEnviar>
                </Formulario>
                <Formulario accion={decidirRevaluacionAccion} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="rechazada" />
                  <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
                  <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
                </Formulario>
              </div>
            </Panel>
          )}
          {r?.estado === 'pendiente' && !puedeDecidir && <Etiqueta tono="advertencia">Pendiente de otra persona con rol de Jefe de contabilidad</Etiqueta>}
        </div>
      )}
    </>
  );
}
