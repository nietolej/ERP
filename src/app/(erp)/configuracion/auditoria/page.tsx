import Link from 'next/link';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import {
  ACCIONES_AUDITORIA, consultarAuditoria, diferencias, entidadesAuditadas, limpiarFiltros, ROLES_VEN_AUDITORIA, rutaDeEntidad, valorLegible,
} from '@/lib/auditoria';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fechaHora } from '@/lib/formato';

const TONO: Record<string, 'exito' | 'info' | 'peligro' | 'advertencia'> = { INSERT: 'exito', UPDATE: 'info', DELETE: 'peligro', BLOQUEO_ACCESO: 'advertencia' };
const NOMBRE_ACCION: Record<string, string> = { INSERT: 'Creó', UPDATE: 'Cambió', DELETE: 'Borró', BLOQUEO_ACCESO: 'Bloqueo de acceso' };

export default async function AuditoriaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await exigirRol(...ROLES_VEN_AUDITORIA);
  const f = limpiarFiltros(await searchParams);
  const db = await getDb();
  const [{ filas, hayMas }, entidades, usuarios] = await Promise.all([
    consultarAuditoria(db, f),
    entidadesAuditadas(db),
    db.query<{ id: string; nombre: string }>('select id, nombre from usuario order by nombre'),
  ]);

  // La página siguiente conserva los filtros y pide los registros anteriores al último mostrado.
  const siguiente = new URLSearchParams();
  if (f.desde) siguiente.set('desde', f.desde);
  if (f.hasta) siguiente.set('hasta', f.hasta);
  if (f.usuarioId) siguiente.set('usuario', f.usuarioId);
  if (f.entidad) siguiente.set('entidad', f.entidad);
  if (f.accion) siguiente.set('accion', f.accion);
  if (f.entidadId) siguiente.set('registro', f.entidadId);
  if (hayMas) siguiente.set('antes', filas[filas.length - 1].id);

  return (
    <>
      <Encabezado titulo="Auditoría"
        descripcion="Registro de quién hizo qué y cuándo. Es de solo lectura y no se puede modificar ni borrar. Se ordena del más reciente al más antiguo." />

      <Panel titulo="Filtros">
        <form method="get" className="grid gap-3 md:grid-cols-3 lg:grid-cols-6 lg:items-end">
          <Campo etiqueta="Desde"><input type="date" name="desde" defaultValue={f.desde ?? ''} className="campo" /></Campo>
          <Campo etiqueta="Hasta"><input type="date" name="hasta" defaultValue={f.hasta ?? ''} className="campo" /></Campo>
          <Campo etiqueta="Usuario">
            <select name="usuario" defaultValue={f.usuarioId ?? ''} className="campo">
              <option value="">Todos</option>
              {usuarios.rows.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Entidad">
            <select name="entidad" defaultValue={f.entidad ?? ''} className="campo">
              <option value="">Todas</option>
              {entidades.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Acción">
            <select name="accion" defaultValue={f.accion ?? ''} className="campo">
              <option value="">Todas</option>
              {ACCIONES_AUDITORIA.map((a) => <option key={a} value={a}>{NOMBRE_ACCION[a]}</option>)}
            </select>
          </Campo>
          <div className="flex gap-2">
            <button type="submit" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Filtrar</button>
            <Link href="/configuracion/auditoria" className="rounded-lg border border-borde px-4 py-2 text-sm hover:bg-white/5">Limpiar</Link>
          </div>
        </form>
        {f.entidadId && (
          <p className="mt-3 text-sm text-texto-2">Mostrando solo el registro <span className="font-mono">{f.entidadId}</span>.</p>
        )}
      </Panel>

      <Panel titulo="Movimientos" className="mt-5">
        <Aviso tono="info">Los datos personales (RIF, teléfono, correo) aparecen en el detalle de los cambios: use esta pantalla solo para fines de control.</Aviso>
        <div className="mt-4">
          <Tabla columnas={['Fecha', 'Usuario', 'Acción', 'Entidad', 'Detalle']} vacio="No hay movimientos con esos filtros.">
            {filas.map((r) => {
              const cambios = diferencias(r.antes, r.despues);
              const ruta = rutaDeEntidad(r.entidad, r.entidad_id);
              return (
                <tr key={r.id} className="align-top">
                  <Celda className="whitespace-nowrap text-texto-2">{fechaHora(r.created_at)}</Celda>
                  <Celda>{r.usuario ?? <span className="text-texto-2">Sistema</span>}</Celda>
                  <Celda><Etiqueta tono={TONO[r.accion] ?? 'info'}>{NOMBRE_ACCION[r.accion] ?? r.accion}</Etiqueta></Celda>
                  <Celda>
                    <span className="font-mono text-xs">{r.entidad}</span>
                    {r.entidad_id && (
                      <p className="text-xs text-texto-2">
                        {ruta ? <Link href={ruta} className="text-acento hover:underline">{r.entidad_id.slice(0, 8)}…</Link> : <span className="font-mono">{r.entidad_id.slice(0, 8)}</span>}
                        {' · '}
                        <Link href={`/configuracion/auditoria?registro=${encodeURIComponent(r.entidad_id)}`} className="hover:underline">historial</Link>
                      </p>
                    )}
                  </Celda>
                  <Celda>
                    {cambios.length === 0 ? (
                      <span className="text-texto-2">Sin cambios de valores</span>
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-xs text-texto-2 hover:text-texto">{cambios.length} {cambios.length === 1 ? 'campo' : 'campos'}</summary>
                        <dl className="mt-2 space-y-1 text-xs">
                          {cambios.map((c) => (
                            <div key={c.campo} className="grid gap-x-2 sm:grid-cols-[10rem_1fr]">
                              <dt className="font-mono text-texto-2">{c.campo}</dt>
                              <dd className="break-words">
                                {r.antes && r.despues
                                  ? <><span className="text-red-300 line-through">{valorLegible(c.antes)}</span> → <span className="text-emerald-300">{valorLegible(c.despues)}</span></>
                                  : valorLegible(r.despues ? c.despues : c.antes)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                  </Celda>
                </tr>
              );
            })}
          </Tabla>
        </div>
        {hayMas && (
          <p className="mt-4 text-right text-sm">
            <Link href={`/configuracion/auditoria?${siguiente.toString()}`} className="text-acento hover:underline">Ver movimientos anteriores →</Link>
          </p>
        )}
      </Panel>
    </>
  );
}
