import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { NOMBRE_ROL } from '@/lib/auth/constantes';
import { exigirSesion } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { delegacionesDe, historialDecisiones, pendientesDe, solicitudesDe } from '@/lib/flujo/flujo';
import { TIPOS_OBJETO } from '@/lib/flujo/objetos';
import { fecha, fechaHora, hoyCaracas } from '@/lib/formato';
import { crearDelegacionAccion, quitarDelegacionAccion } from './acciones';

const TONO = { pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro', cancelada: 'info' } as const;

/** Textos y enlaces de una lista de solicitudes, agrupando las consultas por tipo de objeto. */
async function detalles(db: Awaited<ReturnType<typeof getDb>>, filas: { objeto_tipo: string; objeto_id: string }[]) {
  const resumen = new Map<string, string>();
  const ruta = new Map<string, string>();
  for (const tipo of new Set(filas.map((f) => f.objeto_tipo))) {
    const t = TIPOS_OBJETO[tipo];
    const ids = filas.filter((f) => f.objeto_tipo === tipo).map((f) => f.objeto_id);
    if (!t) continue;
    const textos = await t.resumenes(db, ids);
    for (const id of ids) {
      resumen.set(`${tipo}|${id}`, textos.get(id) ?? '—');
      ruta.set(`${tipo}|${id}`, await t.ruta(id, db));
    }
  }
  return { resumen, ruta };
}

export default async function AprobacionesPage() {
  const u = await exigirSesion();
  const db = await getDb();
  const [pendientes, mias, historial, delegaciones, usuarios] = await Promise.all([
    pendientesDe(db, u.id),
    solicitudesDe(db, u.id),
    historialDecisiones(db, u.id, 20),
    delegacionesDe(db, u.id),
    db.query<{ id: string; nombre: string }>('select id, nombre from usuario where activo and id <> $1 order by nombre', [u.id]),
  ]);
  const { resumen, ruta } = await detalles(db, [...pendientes, ...mias, ...historial]);
  const etiqueta = (tipo: string) => TIPOS_OBJETO[tipo]?.etiqueta ?? tipo;
  const hoy = hoyCaracas();

  return (
    <>
      <Encabezado titulo="Bandeja de aprobaciones"
        descripcion="Lo que le toca aprobar según los flujos de trabajo, lo que usted solicitó y sus decisiones recientes. Se decide en la pantalla de cada registro." />

      <Panel titulo={`Por aprobar (${pendientes.length})`}>
        <Tabla columnas={['Solicitud', 'Registro', 'Solicitó', 'Fecha', 'Paso', '']} vacio="No tiene aprobaciones pendientes.">
          {pendientes.map((s) => {
            const k = `${s.objeto_tipo}|${s.objeto_id}`;
            return (
              <tr key={s.id}>
                <Celda>{etiqueta(s.objeto_tipo)}</Celda>
                <Celda>{resumen.get(k)}</Celda>
                <Celda className="text-texto-2">{s.solicitante}</Celda>
                <Celda className="whitespace-nowrap text-texto-2">{fechaHora(s.created_at)}</Celda>
                <Celda className="text-texto-2">
                  {s.paso_actual} de {s.total_pasos} · {NOMBRE_ROL[s.rol]}
                  {s.escalada && <> <Etiqueta tono="advertencia">escalada</Etiqueta></>}
                </Celda>
                <Celda><Link href={ruta.get(k) ?? '#'} className="text-acento hover:underline">Revisar</Link></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>

      <Panel titulo="Mis solicitudes" className="mt-5">
        <Tabla columnas={['Solicitud', 'Registro', 'Fecha', 'Estado', '']} vacio="No ha solicitado aprobaciones.">
          {mias.map((s) => {
            const k = `${s.objeto_tipo}|${s.objeto_id}`;
            return (
              <tr key={s.id}>
                <Celda>{etiqueta(s.objeto_tipo)}</Celda>
                <Celda>{resumen.get(k)}</Celda>
                <Celda className="whitespace-nowrap text-texto-2">{fechaHora(s.created_at)}</Celda>
                <Celda>
                  <Etiqueta tono={TONO[s.estado]}>{s.estado}</Etiqueta>
                  {s.estado === 'pendiente' && <span className="ml-2 text-xs text-texto-2">espera a {NOMBRE_ROL[s.rol]}</span>}
                </Celda>
                <Celda><Link href={ruta.get(k) ?? '#'} className="text-acento hover:underline">Ver</Link></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>

      <Panel titulo="Mis decisiones recientes" className="mt-5">
        <Tabla columnas={['Solicitud', 'Registro', 'Decisión', 'Fecha']} vacio="Aún no ha decidido ninguna solicitud.">
          {historial.map((d) => {
            const k = `${d.objeto_tipo}|${d.objeto_id}`;
            return (
              <tr key={`${d.solicitud_id}-${d.paso}`}>
                <Celda>{etiqueta(d.objeto_tipo)}</Celda>
                <Celda><Link href={ruta.get(k) ?? '#'} className="text-acento hover:underline">{resumen.get(k)}</Link></Celda>
                <Celda>
                  <Etiqueta tono={d.decision === 'aprobada' ? 'exito' : 'peligro'}>{d.decision}</Etiqueta>
                  {d.en_nombre_de && <span className="ml-2 text-xs text-texto-2">en nombre de {d.en_nombre_de}</span>}
                </Celda>
                <Celda className="whitespace-nowrap text-texto-2">{fechaHora(d.created_at)}</Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>

      <Panel titulo="Delegar mis aprobaciones" className="mt-5">
        <p className="mb-3 text-sm text-texto-2">
          Durante estas fechas, la persona que elija puede aprobar en su nombre lo que a usted le corresponde. Su decisión queda registrada como
          tomada por ella, en nombre suyo, y las reglas de segregación de funciones siguen aplicando.
        </p>
        <Tabla columnas={['Sustituto', 'Desde', 'Hasta', '']} vacio="No tiene delegaciones vigentes.">
          {delegaciones.map((g) => (
            <tr key={g.id}>
              <Celda>{g.sustituto}</Celda>
              <Celda>{fecha(g.desde)}</Celda>
              <Celda>{fecha(g.hasta)}</Celda>
              <Celda>
                <Formulario accion={quitarDelegacionAccion}>
                  <input type="hidden" name="id" value={g.id} />
                  <BotonEnviar variante="secundario">Retirar</BotonEnviar>
                </Formulario>
              </Celda>
            </tr>
          ))}
        </Tabla>
        <Formulario accion={crearDelegacionAccion} className="mt-4 grid gap-3 md:grid-cols-[1fr_9rem_9rem_auto] md:items-end">
          <Campo etiqueta="Sustituto">
            <select name="sustituto_id" required defaultValue="" className="campo">
              <option value="">Seleccione…</option>
              {usuarios.rows.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Desde"><input type="date" name="desde" required defaultValue={hoy} className="campo" /></Campo>
          <Campo etiqueta="Hasta"><input type="date" name="hasta" required defaultValue={hoy} className="campo" /></Campo>
          <BotonEnviar>Delegar</BotonEnviar>
        </Formulario>
      </Panel>
    </>
  );
}
