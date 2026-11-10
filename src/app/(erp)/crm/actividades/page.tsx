import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM } from '@/lib/crm/comun';
import { listarActividades, NOMBRE_ACTIVIDAD, TIPOS_ACTIVIDAD } from '@/lib/crm/contactos';
import { tercerosComerciales } from '@/lib/crm/prospectos';
import { getDb } from '@/lib/db';
import { registrarActividadAccion } from '../acciones';

export default async function ActividadesPage() {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const db = await getDb();
  const registra = tieneRol(u, [...ROLES_CRM]);
  const [filas, terceros] = await Promise.all([listarActividades(db, u, {}, 200), registra ? tercerosComerciales(db, u) : Promise.resolve([])]);

  return (
    <>
      <Encabezado titulo="Actividades y visitas"
        descripcion="Visitas, llamadas, mensajes, correos y tareas con clientes y prospectos. Una actividad registrada no se edita ni se borra." />
      {registra && (
        <Panel titulo="Registrar una actividad" className="mb-5">
          <Formulario accion={registrarActividadAccion} className="grid gap-4 sm:grid-cols-4">
            <Campo etiqueta="Cliente o prospecto">
              <select name="tercero_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {terceros.map((t) => <option key={t.id} value={t.id}>{t.etiqueta}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Tipo">
              <select name="tipo" required defaultValue="visita" className="campo">
                {TIPOS_ACTIVIDAD.map((x) => <option key={x} value={x}>{NOMBRE_ACTIVIDAD[x]}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Fecha y hora" ayuda="Vacío: ahora."><input name="fecha" type="datetime-local" className="campo" /></Campo>
            <Campo etiqueta="Resultado"><input name="resultado" className="campo" /></Campo>
            <div className="sm:col-span-3"><Campo etiqueta="Próxima acción"><input name="proxima_accion" className="campo" /></Campo></div>
            <Campo etiqueta="Para el"><input name="proxima_fecha" type="date" className="campo" /></Campo>
            <div className="sm:col-span-4 flex justify-end"><BotonEnviar>Registrar</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
      <Panel titulo="Últimas actividades">
        <Tabla columnas={['Fecha', 'Tipo', 'Cliente o prospecto', 'Resultado', 'Próxima acción', 'Por']} vacio="Todavía no hay actividades registradas.">
          {filas.map((a) => (
            <tr key={a.id}>
              <Celda className="text-texto-2 whitespace-nowrap">{a.fecha}</Celda>
              <Celda>{NOMBRE_ACTIVIDAD[a.tipo]}</Celda>
              <Celda><Link href={`/crm/terceros/${a.tercero_id}`} className="text-acento hover:underline">{a.tercero}</Link></Celda>
              <Celda>{a.resultado ?? '—'}{a.oportunidad && <span className="block text-xs text-texto-2">{a.oportunidad}</span>}</Celda>
              <Celda className="text-texto-2">{a.proxima_accion ? `${a.proxima_accion}${a.proxima_fecha ? ` (${a.proxima_fecha})` : ''}` : '—'}</Celda>
              <Celda className="text-texto-2">{a.usuario}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
