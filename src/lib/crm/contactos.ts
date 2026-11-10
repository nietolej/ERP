import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { vacioANull } from '@/lib/maestros/terceros';
import { exigirTercero, soloLoSuyo, UUID, type Usuario } from './comun';

/**
 * Contactos y actividades del CRM (§6.5). Los datos de contacto son personales (regla 7): no van en URLs ni en registros
 * de error, por eso las pantallas usan el id interno y los errores nunca repiten el teléfono o el correo.
 */

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface DatosContacto { nombre: string; cargo?: string; telefono?: string; correo?: string; principal?: boolean }

function validarContacto(d: DatosContacto): void {
  if (d.nombre.trim().length < 2) throw new ErrorMaestro('Indique el nombre del contacto.');
  if (d.correo?.trim() && !EMAIL.test(d.correo.trim())) throw new ErrorMaestro('El correo del contacto no tiene un formato válido.');
}

async function quitarPrincipal(tx: Db, terceroId: string, salvo?: string): Promise<void> {
  await tx.query('update contacto set principal = false where tercero_id = $1 and principal and id is distinct from $2', [terceroId, salvo ?? null]);
}

export async function crearContacto(tx: Db, u: Usuario, terceroId: string, d: DatosContacto): Promise<string> {
  await exigirTercero(tx, u, terceroId);
  validarContacto(d);
  if (d.principal) await quitarPrincipal(tx, terceroId);
  const { rows } = await tx.query<{ id: string }>(
    `insert into contacto (tercero_id, nombre, cargo, telefono, correo, principal, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [terceroId, d.nombre.trim(), vacioANull(d.cargo), vacioANull(d.telefono), vacioANull(d.correo)?.toLowerCase() ?? null, !!d.principal, u.id]);
  return rows[0].id;
}

async function contactoDe(tx: Db, u: Usuario, id: string): Promise<string> {
  if (!UUID.test(id)) throw new ErrorMaestro('El contacto no existe.');
  const { rows } = await tx.query<{ tercero_id: string }>('select tercero_id from contacto where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El contacto no existe.');
  await exigirTercero(tx, u, rows[0].tercero_id);
  return rows[0].tercero_id;
}

export async function actualizarContacto(tx: Db, u: Usuario, id: string, d: DatosContacto & { activo: boolean }): Promise<void> {
  const terceroId = await contactoDe(tx, u, id);
  validarContacto(d);
  const principal = !!d.principal && d.activo;
  if (principal) await quitarPrincipal(tx, terceroId, id);
  await tx.query(
    `update contacto set nombre = $2, cargo = $3, telefono = $4, correo = $5, principal = $6, activo = $7 where id = $1`,
    [id, d.nombre.trim(), vacioANull(d.cargo), vacioANull(d.telefono), vacioANull(d.correo)?.toLowerCase() ?? null, principal, d.activo]);
}

export interface FilaContacto { id: string; nombre: string; cargo: string | null; telefono: string | null; correo: string | null; principal: boolean; activo: boolean }

export async function contactosDe(db: Db, terceroId: string): Promise<FilaContacto[]> {
  const { rows } = await db.query<FilaContacto>(
    `select id, nombre, cargo, telefono, correo, principal, activo from contacto where tercero_id = $1
      order by activo desc, principal desc, nombre`, [terceroId]);
  return rows;
}

// ---------------------------------------------------------------------
// Actividades: hechos que no se editan ni se borran (R-CR4)
// ---------------------------------------------------------------------

export const TIPOS_ACTIVIDAD = ['visita', 'llamada', 'mensaje', 'correo', 'tarea'] as const;
export type TipoActividad = (typeof TIPOS_ACTIVIDAD)[number];
export const NOMBRE_ACTIVIDAD: Record<TipoActividad, string> = {
  visita: 'Visita', llamada: 'Llamada', mensaje: 'Mensaje', correo: 'Correo', tarea: 'Tarea',
};

export interface DatosActividad {
  terceroId: string;
  oportunidadId?: string | null;
  tipo: TipoActividad;
  /** Fecha y hora local de Caracas 'AAAA-MM-DDTHH:MM'; por omisión, ahora. */
  fecha?: string;
  resultado?: string;
  proximaAccion?: string;
  proximaFecha?: string;
}

export async function registrarActividad(tx: Db, u: Usuario, d: DatosActividad): Promise<string> {
  if (!TIPOS_ACTIVIDAD.includes(d.tipo)) throw new ErrorMaestro('Seleccione el tipo de actividad.');
  await exigirTercero(tx, u, d.terceroId);
  const resultado = (d.resultado ?? '').trim();
  const proxima = (d.proximaAccion ?? '').trim();
  if (resultado.length < 3 && proxima.length < 3) throw new ErrorMaestro('Escriba el resultado de la actividad o la próxima acción.');
  if (d.proximaFecha && !/^\d{4}-\d{2}-\d{2}$/.test(d.proximaFecha)) throw new ErrorMaestro('La fecha de la próxima acción no es válida.');
  if (d.proximaFecha && proxima.length < 3) throw new ErrorMaestro('Indique cuál es la próxima acción.');
  if (d.fecha && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.fecha)) throw new ErrorMaestro('La fecha de la actividad no es válida.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into actividad_crm (tercero_id, oportunidad_id, tipo, usuario_id, fecha, resultado, proxima_accion, proxima_fecha)
     values ($1, $2, $3, $4, case when $5::text is null then now() else ($5::timestamp at time zone 'America/Caracas') end,
             $6, $7, $8::date) returning id`,
    [d.terceroId, d.oportunidadId || null, d.tipo, u.id, d.fecha || null, resultado || null, proxima || null, d.proximaFecha || null]);
  return rows[0].id;
}

export interface FilaActividad {
  id: string; fecha: string; tipo: TipoActividad; tercero_id: string; tercero: string; oportunidad: string | null;
  usuario: string; resultado: string | null; proxima_accion: string | null; proxima_fecha: string | null;
}

/** Actividades recientes; de un tercero si se indica. Quien solo vende ve las de sus clientes y prospectos. */
export async function listarActividades(db: Db, u: Usuario, filtro: { terceroId?: string } = {}, limite = 100): Promise<FilaActividad[]> {
  const { rows } = await db.query<FilaActividad>(
    `select a.id, to_char(a.fecha at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha, a.tipo, a.tercero_id,
            t.razon_social as tercero, o.titulo as oportunidad, us.nombre as usuario, a.resultado, a.proxima_accion,
            to_char(a.proxima_fecha, 'DD-MM-YYYY') as proxima_fecha
       from actividad_crm a
       join tercero t on t.id = a.tercero_id
       join usuario us on us.id = a.usuario_id
       left join oportunidad o on o.id = a.oportunidad_id
       left join cliente c on c.tercero_id = a.tercero_id
       left join prospecto p on p.tercero_id = a.tercero_id
       left join vendedor v on v.id = coalesce(c.vendedor_id, p.vendedor_id)
      where (not $1 or v.usuario_id = $2)
        and ($3::uuid is null or a.tercero_id = $3)
      order by a.fecha desc limit $4`, [soloLoSuyo(u), u.id, filtro.terceroId || null, limite]);
  return rows;
}

/** Próximas acciones pendientes (la última actividad de cada tercero que dejó una próxima acción con fecha). */
export async function agendaPendiente(db: Db, u: Usuario, limite = 50): Promise<FilaActividad[]> {
  const { rows } = await db.query<FilaActividad>(
    `select * from (
       select distinct on (a.tercero_id) a.id, to_char(a.fecha at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha, a.tipo,
              a.tercero_id, t.razon_social as tercero, o.titulo as oportunidad, us.nombre as usuario, a.resultado, a.proxima_accion,
              to_char(a.proxima_fecha, 'DD-MM-YYYY') as proxima_fecha, a.proxima_fecha as orden
         from actividad_crm a
         join tercero t on t.id = a.tercero_id
         join usuario us on us.id = a.usuario_id
         left join oportunidad o on o.id = a.oportunidad_id
         left join cliente c on c.tercero_id = a.tercero_id
         left join prospecto p on p.tercero_id = a.tercero_id
         left join vendedor v on v.id = coalesce(c.vendedor_id, p.vendedor_id)
        where (not $1 or v.usuario_id = $2)
        order by a.tercero_id, a.fecha desc) x
      where x.orden is not null
      order by x.orden limit $3`, [soloLoSuyo(u), u.id, limite]);
  return rows;
}
