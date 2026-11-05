import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import {
  ROLES_CIERRAN_PERIODO, ROLES_REABREN_PERIODO, ROLES_RETIRAN_CIERRE, ROLES_VEN_CIERRE, checklistCierre, etiquetaMes, historialCierre,
  type ConfirmacionCierre, type PuntoCierre,
} from '@/lib/contabilidad/cierre';
import { getDb } from '@/lib/db';
import { cerrarMesAccion, confirmarCierreAccion, reabrirMesAccion, retirarCierreAccion } from './acciones';

const TONO = { abierto: 'exito', cerrado: 'advertencia', bloqueado: 'peligro' } as const;

function mesPasado(): string {
  const c = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  c.setDate(1);
  c.setMonth(c.getMonth() - 1);
  return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`;
}

function Retirar({ c, periodo }: { c: ConfirmacionCierre; periodo: string }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">Retirar la confirmación</summary>
      <Formulario accion={retirarCierreAccion} className="mt-2 flex flex-wrap items-end gap-3">
        <input type="hidden" name="id" value={c.id} />
        <input type="hidden" name="periodo" value={periodo} />
        <Campo etiqueta="Motivo (queda auditado)"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
        <BotonEnviar variante="peligro">Retirar</BotonEnviar>
      </Formulario>
    </details>
  );
}

function Punto({ p, periodo, abierto, puedeConfirmar, puedeRetirar }: { p: PuntoCierre; periodo: string; abierto: boolean; puedeConfirmar: boolean; puedeRetirar: boolean }) {
  const hecha = p.confirmacion?.hecha ?? null;
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="max-w-2xl text-sm font-semibold">{p.titulo}</h2>
        <Etiqueta tono={p.ok ? 'exito' : 'advertencia'}>{p.ok ? 'en orden' : 'pendiente'}</Etiqueta>
      </div>
      <p className={`mt-2 text-sm ${p.ok ? 'text-emerald-300' : 'text-texto-2'}`}><span className="font-semibold">{p.ok ? '✓ ' : '· '}</span>{p.detalle}</p>
      {p.pendientes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-9 text-sm text-texto-2">{p.pendientes.map((x) => <li key={x}>{x}</li>)}</ul>
      )}
      {p.confirmacion && hecha && (
        <div className="mt-2 text-sm">
          <p><span className="font-semibold text-emerald-300">✓ </span>Confirmado por {hecha.por} el {hecha.el}{hecha.nota ? `: ${hecha.nota}` : ''}.</p>
          {abierto && puedeRetirar && <Retirar c={hecha} periodo={periodo} />}
        </div>
      )}
      {p.confirmacion && !hecha && abierto && (puedeConfirmar ? (
        <Formulario accion={confirmarCierreAccion} className="mt-2 flex flex-wrap items-end gap-3">
          <input type="hidden" name="codigo" value={p.confirmacion.codigo} />
          <input type="hidden" name="periodo" value={periodo} />
          <Campo etiqueta="Nota (opcional)"><input name="nota" maxLength={200} className="campo" /></Campo>
          <BotonEnviar>Confirmar</BotonEnviar>
        </Formulario>
      ) : <p className="mt-2 text-xs text-texto-2">Lo confirma Contabilidad o Gerencia.</p>)}
      {p.enlace && <p className="mt-2 text-xs"><Link href={p.enlace.href} className="text-acento hover:underline">{p.enlace.texto} →</Link></p>}
    </Panel>
  );
}

export default async function CierrePage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CIERRE);
  const q = await searchParams;
  const mm = /^(\d{4})-(\d{2})$/.exec(q.periodo ?? '');
  const periodo = mm && Number(mm[2]) >= 1 && Number(mm[2]) <= 12 ? q.periodo! : mesPasado();
  const [anio, mes] = periodo.split('-').map(Number);
  const db = await getDb();

  let c: Awaited<ReturnType<typeof checklistCierre>> | null = null;
  let falta: string | null = null;
  try {
    c = await checklistCierre(db, anio, mes);
  } catch (e) {
    falta = (e as Error).message;
  }
  const historial = c ? await historialCierre(db, anio, mes) : [];
  const puedeCerrar = tieneRol(u, [...ROLES_CIERRAN_PERIODO]);
  const puedeReabrir = tieneRol(u, [...ROLES_REABREN_PERIODO]);
  const puedeRetirar = tieneRol(u, [...ROLES_RETIRAN_CIERRE]);
  const hechos = c ? c.puntos.filter((p) => p.ok).length : 0;

  return (
    <>
      <Encabezado titulo="Cierre mensual"
        descripcion="El checklist de §12.4: el sistema comprueba lo que puede y Contabilidad confirma lo demás. Con todo en orden, Contabilidad cierra el mes y queda la foto del checklist. Reabrirlo es de Gerencia, con motivo.">
        <Link href="/contabilidad/periodos" className="text-sm text-texto-2 hover:text-texto">Periodos →</Link>
      </Encabezado>
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={periodo} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
      </Panel>

      {falta && <Aviso tono="advertencia">{falta}</Aviso>}

      {c && (
        <div className="space-y-4">
          <Aviso tono={c.periodo.estado === 'abierto' ? (c.listo ? 'exito' : 'advertencia') : 'info'}>
            {c.periodo.estado === 'abierto'
              ? `${etiquetaMes(anio, mes)}: ${hechos} de ${c.puntos.length} puntos en orden.${c.listo ? ' Ya se puede cerrar el mes.' : ' Faltan los que siguen marcados como pendientes.'}`
              : `${etiquetaMes(anio, mes)} está ${c.periodo.estado}. Abajo, el checklist con el estado de hoy; la foto con que se cerró queda en el historial.`}
          </Aviso>

          {c.puntos.map((p) => (
            <Punto key={p.codigo} p={p} periodo={periodo} abierto={c.periodo.estado === 'abierto'} puedeConfirmar={puedeCerrar} puedeRetirar={puedeRetirar} />
          ))}

          <Panel titulo="Cerrar o reabrir el mes">
            <p className="mb-3 text-sm text-texto-2">Estado del periodo: <Etiqueta tono={TONO[c.periodo.estado]}>{c.periodo.estado}</Etiqueta></p>
            {c.periodo.estado === 'abierto' && (puedeCerrar ? (
              <Formulario accion={cerrarMesAccion} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="periodo" value={periodo} />
                <BotonEnviar disabled={!c.listo}>Cerrar {etiquetaMes(anio, mes)}</BotonEnviar>
                {!c.listo && <span className="text-xs text-texto-2">Se habilita cuando todos los puntos estén en orden.</span>}
              </Formulario>
            ) : <p className="text-sm text-texto-2">Lo cierra Contabilidad o Gerencia.</p>)}
            {c.periodo.estado === 'cerrado' && (puedeReabrir ? (
              <Formulario accion={reabrirMesAccion} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="periodo" value={periodo} />
                <Campo etiqueta="Motivo de la reapertura (queda auditado)"><input name="motivo" required minLength={3} maxLength={200} className="campo w-80" /></Campo>
                <BotonEnviar variante="peligro">Reabrir {etiquetaMes(anio, mes)}</BotonEnviar>
              </Formulario>
            ) : <p className="text-sm text-texto-2">Solo Gerencia reabre un periodo cerrado, con motivo.</p>)}
            {c.periodo.estado === 'bloqueado' && <p className="text-sm text-texto-2">Un periodo bloqueado no se reabre.</p>}
          </Panel>

          <Panel titulo="Historial del periodo">
            <Tabla columnas={['Acción', 'Quién', 'Cuándo', 'Motivo']} vacio="Todavía no se ha cerrado ni reabierto.">
              {historial.map((h) => (
                <tr key={h.id}>
                  <Celda><Etiqueta tono={h.accion === 'cierre' ? 'advertencia' : 'peligro'}>{h.accion === 'cierre' ? 'cierre' : 'reapertura'}</Etiqueta></Celda>
                  <Celda>{h.por}</Celda>
                  <Celda>{h.el}</Celda>
                  <Celda className="text-texto-2">{h.motivo ?? '—'}</Celda>
                </tr>
              ))}
            </Tabla>
          </Panel>
        </div>
      )}
    </>
  );
}
