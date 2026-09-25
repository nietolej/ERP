import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Motor de flujo de trabajo y aprobaciones (§4.5). Decide QUIÉN aprueba; qué pasa al aprobar lo hace
 * el módulo dueño del objeto (un manejador). La base de datos valida cada decisión
 * (fn_flujo_puede_decidir): rol del paso, segregación de funciones, escalamiento y delegación.
 */

export interface Contexto { [campo: string]: number | string | boolean | null }

export type EstadoSolicitud = 'pendiente' | 'aprobada' | 'rechazada' | 'cancelada';
export type Decision = 'aprobada' | 'rechazada';

export interface PasoSolicitud {
  orden: number; rol: Rol; distinto: boolean; horas: number | null; escalar_a: Rol | null;
}

/** Lo que el módulo dueño hace cuando se resuelve una solicitud. Corre en la misma transacción. */
export interface Manejador<R = unknown> {
  /** Se llama con el último aprobador y los datos que aportó en su decisión (p. ej. condiciones de crédito). */
  alAprobar(tx: Db, objetoId: string, aprobadorId: string, datos: Record<string, unknown>): Promise<R>;
  /** Si no existe, ese tipo de objeto no admite rechazo. */
  alRechazar?(tx: Db, objetoId: string, usuarioId: string, motivo: string): Promise<void>;
}

/** Crea la solicitud de aprobación de un objeto (idempotente: si ya hay una abierta, devuelve esa). */
export async function solicitarAprobacion(
  tx: Db, p: { tipo: string; objetoId: string; solicitanteId: string; contexto?: Contexto },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'select fn_flujo_solicitar($1, $2, $3, $4::jsonb) as id', [p.tipo, p.objetoId, p.solicitanteId, JSON.stringify(p.contexto ?? {})]);
  return rows[0].id;
}

/** Cancela la solicitud abierta de un objeto que ya no va a aprobarse (p. ej. un borrador eliminado). */
export async function cancelarSolicitud(tx: Db, tipo: string, objetoId: string): Promise<void> {
  await tx.query(
    `update solicitud_aprobacion set estado = 'cancelada' where objeto_tipo = $1 and objeto_id = $2 and estado = 'pendiente'`, [tipo, objetoId]);
}

export interface ResultadoDecision<R> {
  estado: EstadoSolicitud;
  /** Paso que sigue, si la solicitud continúa pendiente en otro paso. */
  paso: number;
  /** Lo que devolvió el manejador al aprobar (p. ej. el número del asiento). */
  resultado?: R;
}

/**
 * Registra la decisión de un usuario sobre la solicitud abierta de un objeto.
 * - Rechazar exige comentario.
 * - Si era el último paso y se aprueba, ejecuta `alAprobar`; si se rechaza, ejecuta `alRechazar`.
 * - Todo ocurre en la transacción de quien llama: si el manejador falla, la decisión se revierte.
 */
export async function decidirAprobacion<R>(
  tx: Db,
  p: { tipo: string; objetoId: string; usuarioId: string; decision: Decision; comentario?: string; datos?: Record<string, unknown> },
  manejador: Manejador<R>,
): Promise<ResultadoDecision<R>> {
  if (p.decision === 'rechazada' && !manejador.alRechazar) {
    throw new ErrorMaestro('Este tipo de solicitud no se rechaza: se corrige o se deja pendiente.');
  }
  if (p.decision === 'rechazada' && (p.comentario?.trim().length ?? 0) < 3) throw new ErrorMaestro('Indique el motivo del rechazo.');
  const { rows } = await tx.query<{ id: string; paso_actual: number }>(
    `select id, paso_actual from solicitud_aprobacion where objeto_tipo = $1 and objeto_id = $2 and estado = 'pendiente' for update`,
    [p.tipo, p.objetoId]);
  const s = rows[0];
  if (!s) throw new ErrorMaestro('No hay una solicitud de aprobación pendiente para este registro.');

  await tx.query(
    'insert into aprobacion_decision (solicitud_id, paso, usuario_id, decision, comentario, datos) values ($1, $2, $3, $4, $5, $6::jsonb)',
    [s.id, s.paso_actual, p.usuarioId, p.decision, p.comentario?.trim() || null, p.datos ? JSON.stringify(p.datos) : null]);

  const { rows: despues } = await tx.query<{ estado: EstadoSolicitud; paso_actual: number; en_nombre_de: string | null }>(
    `select s.estado, s.paso_actual,
            (select d.en_nombre_de from aprobacion_decision d where d.solicitud_id = s.id order by d.id desc limit 1) as en_nombre_de
       from solicitud_aprobacion s where s.id = $1`, [s.id]);
  const estado = despues[0].estado;
  // Si decidió un sustituto, el módulo dueño registra como responsable a quien delegó (que tiene el rol);
  // la decisión conserva quién la tomó realmente.
  const responsable = despues[0].en_nombre_de ?? p.usuarioId;

  if (estado === 'aprobada') {
    return { estado, paso: despues[0].paso_actual, resultado: await manejador.alAprobar(tx, p.objetoId, responsable, p.datos ?? {}) };
  }
  if (estado === 'rechazada') {
    await manejador.alRechazar?.(tx, p.objetoId, responsable, p.comentario ?? '');
  }
  return { estado, paso: despues[0].paso_actual };
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/** ¿Puede este usuario decidir hoy la solicitud abierta de un objeto? (para mostrar u ocultar los botones) */
export async function puedeDecidirObjeto(db: Db, usuarioId: string, tipo: string, objetoId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select exists (select 1 from solicitud_aprobacion s
                     where s.objeto_tipo = $2 and s.objeto_id = $3 and s.estado = 'pendiente' and fn_flujo_puede_decidir($1, s.id)) as ok`,
    [usuarioId, tipo, objetoId]);
  return rows[0].ok;
}

export interface SolicitudPendiente {
  id: string;
  objeto_tipo: string;
  objeto_id: string;
  solicitante: string;
  created_at: string;
  paso_actual: number;
  total_pasos: number;
  rol: Rol;
  escalada: boolean;
}

/** Solicitudes que este usuario puede decidir ahora (incluye las que le tocan como sustituto o por escalamiento). */
export async function pendientesDe(db: Db, usuarioId: string): Promise<SolicitudPendiente[]> {
  const { rows } = await db.query<SolicitudPendiente>(
    `select s.id, s.objeto_tipo, s.objeto_id, u.nombre as solicitante, s.created_at, s.paso_actual,
            jsonb_array_length(s.pasos) as total_pasos, (s.pasos -> (s.paso_actual - 1) ->> 'rol') as rol,
            coalesce((s.pasos -> (s.paso_actual - 1) ->> 'horas')::int is not null
                     and now() >= s.paso_desde + make_interval(hours => (s.pasos -> (s.paso_actual - 1) ->> 'horas')::int), false) as escalada
       from solicitud_aprobacion s join usuario u on u.id = s.solicitante_id
      where s.estado = 'pendiente' and fn_flujo_puede_decidir($1, s.id)
      order by s.created_at`, [usuarioId]);
  return rows;
}

export interface SolicitudResumen extends SolicitudPendiente {
  estado: EstadoSolicitud;
  resuelta_at: string | null;
}

/** Solicitudes que creó el usuario, con su estado. */
export async function solicitudesDe(db: Db, usuarioId: string, limite = 30): Promise<SolicitudResumen[]> {
  const { rows } = await db.query<SolicitudResumen>(
    `select s.id, s.objeto_tipo, s.objeto_id, u.nombre as solicitante, s.created_at, s.paso_actual,
            jsonb_array_length(s.pasos) as total_pasos, (s.pasos -> (s.paso_actual - 1) ->> 'rol') as rol,
            false as escalada, s.estado, s.resuelta_at
       from solicitud_aprobacion s join usuario u on u.id = s.solicitante_id
      where s.solicitante_id = $1 order by s.created_at desc limit ${Math.min(limite, 100)}`, [usuarioId]);
  return rows;
}

export interface DecisionRegistrada {
  solicitud_id: string; objeto_tipo: string; objeto_id: string; paso: number; decision: Decision;
  comentario: string | null; created_at: string; decidio: string; en_nombre_de: string | null;
}

/** Historial: decisiones tomadas (por un usuario, o de todos si no se indica). */
export async function historialDecisiones(db: Db, usuarioId: string | null, limite = 30): Promise<DecisionRegistrada[]> {
  const { rows } = await db.query<DecisionRegistrada>(
    `select d.solicitud_id, s.objeto_tipo, s.objeto_id, d.paso, d.decision, d.comentario, d.created_at,
            u.nombre as decidio, o.nombre as en_nombre_de
       from aprobacion_decision d
       join solicitud_aprobacion s on s.id = d.solicitud_id
       join usuario u on u.id = d.usuario_id
       left join usuario o on o.id = d.en_nombre_de
      where ($1::uuid is null or d.usuario_id = $1)
      order by d.id desc limit ${Math.min(limite, 100)}`, [usuarioId]);
  return rows;
}

/** Decisiones de una solicitud, para mostrar el recorrido en la pantalla del objeto. */
export async function decisionesDe(db: Db, tipo: string, objetoId: string): Promise<DecisionRegistrada[]> {
  const { rows } = await db.query<DecisionRegistrada>(
    `select d.solicitud_id, s.objeto_tipo, s.objeto_id, d.paso, d.decision, d.comentario, d.created_at,
            u.nombre as decidio, o.nombre as en_nombre_de
       from aprobacion_decision d
       join solicitud_aprobacion s on s.id = d.solicitud_id
       join usuario u on u.id = d.usuario_id
       left join usuario o on o.id = d.en_nombre_de
      where s.objeto_tipo = $1 and s.objeto_id = $2 order by d.id`, [tipo, objetoId]);
  return rows;
}

// ---------------------------------------------------------------------
// Delegación
// ---------------------------------------------------------------------
export interface Delegacion { id: string; sustituto_id: string; sustituto: string; desde: string; hasta: string }

export async function crearDelegacion(tx: Db, usuarioId: string, sustitutoId: string, desde: string, hasta: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new ErrorMaestro('Indique las fechas de la delegación.');
  if (hasta < desde) throw new ErrorMaestro('La fecha final no puede ser anterior a la inicial.');
  if (!sustitutoId) throw new ErrorMaestro('Seleccione quién lo sustituye.');
  if (sustitutoId === usuarioId) throw new ErrorMaestro('No puede delegarse a sí mismo.');
  const { rows } = await tx.query('select 1 from usuario where id = $1 and activo', [sustitutoId]);
  if (!rows.length) throw new ErrorMaestro('El sustituto no existe o está inactivo.');
  await tx.query('insert into delegacion_aprobacion (usuario_id, sustituto_id, desde, hasta) values ($1, $2, $3, $4)',
    [usuarioId, sustitutoId, desde, hasta]);
}

export async function quitarDelegacion(tx: Db, usuarioId: string, id: string): Promise<void> {
  const { rows } = await tx.query('delete from delegacion_aprobacion where id = $1 and usuario_id = $2 returning id', [id, usuarioId]);
  if (!rows[0]) throw new ErrorMaestro('La delegación no existe.');
}

export async function delegacionesDe(db: Db, usuarioId: string): Promise<Delegacion[]> {
  const { rows } = await db.query<Delegacion>(
    `select g.id, g.sustituto_id, u.nombre as sustituto, g.desde::text, g.hasta::text
       from delegacion_aprobacion g join usuario u on u.id = g.sustituto_id
      where g.usuario_id = $1 and g.hasta >= (now() at time zone 'America/Caracas')::date order by g.desde`, [usuarioId]);
  return rows;
}

// ---------------------------------------------------------------------
// Definiciones (las edita Gerencia)
// ---------------------------------------------------------------------
export const OPERADORES = ['>', '>=', '<', '<=', '='] as const;
export type Operador = (typeof OPERADORES)[number];

export interface PasoDefinicion {
  id: string; orden: number; condicion_campo: string | null; condicion_operador: Operador | null; condicion_valor: string | null;
  rol_aprobador: Rol; distinto_del_creador: boolean; horas_para_escalar: number | null; escalar_a_rol: Rol | null;
}
export interface Definicion { id: string; objeto_tipo: string; nombre: string; activo: boolean; pasos: PasoDefinicion[] }

export async function listarDefiniciones(db: Db): Promise<Definicion[]> {
  const { rows: defs } = await db.query<Omit<Definicion, 'pasos'>>('select id, objeto_tipo, nombre, activo from flujo_definicion order by nombre');
  const { rows: pasos } = await db.query<PasoDefinicion & { definicion_id: string }>(
    `select id, definicion_id, orden, condicion_campo, condicion_operador, condicion_valor::text, rol_aprobador,
            distinto_del_creador, horas_para_escalar, escalar_a_rol
       from flujo_paso order by definicion_id, orden`);
  return defs.map((d) => ({ ...d, pasos: pasos.filter((p) => p.definicion_id === d.id) }));
}

export interface DatosPaso {
  rol: string;
  distintoDelCreador: boolean;
  condicionCampo?: string;
  condicionOperador?: string;
  condicionValor?: string;
  horasParaEscalar?: string;
  escalarARol?: string;
}

function validarPaso(d: DatosPaso): void {
  const errores: string[] = [];
  if (!d.rol) errores.push('Seleccione el rol que aprueba.');
  const campo = d.condicionCampo?.trim() ?? '';
  const operador = d.condicionOperador?.trim() ?? '';
  const valor = d.condicionValor?.trim() ?? '';
  if (campo || operador || valor) {
    if (!/^[a-z_]+$/.test(campo)) errores.push('El campo de la condición se escribe en minúsculas y guiones bajos (p. ej. monto_usd).');
    if (!(OPERADORES as readonly string[]).includes(operador)) errores.push('Seleccione el operador de la condición.');
    if (!/^\d{1,14}(\.\d{1,2})?$/.test(valor)) errores.push('El umbral debe ser un número positivo con hasta 2 decimales.');
  }
  const horas = d.horasParaEscalar?.trim() ?? '';
  if (horas || d.escalarARol) {
    if (!/^[1-9]\d{0,4}$/.test(horas)) errores.push('Las horas para escalar deben ser un número entero positivo.');
    if (!d.escalarARol) errores.push('Seleccione el rol al que se escala.');
    if (d.escalarARol === d.rol) errores.push('El rol de escalamiento debe ser distinto del que aprueba.');
  }
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

/** Agrega un paso al final del flujo. Solo afecta a las solicitudes nuevas. */
export async function agregarPaso(tx: Db, definicionId: string, d: DatosPaso): Promise<void> {
  validarPaso(d);
  const { rows } = await tx.query<{ orden: number }>('select coalesce(max(orden), 0) + 1 as orden from flujo_paso where definicion_id = $1', [definicionId]);
  const campo = d.condicionCampo?.trim() || null;
  await tx.query(
    `insert into flujo_paso (definicion_id, orden, condicion_campo, condicion_operador, condicion_valor, rol_aprobador,
                             distinto_del_creador, horas_para_escalar, escalar_a_rol)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [definicionId, rows[0].orden, campo, campo ? d.condicionOperador : null, campo ? d.condicionValor?.trim() : null, d.rol,
      d.distintoDelCreador, d.horasParaEscalar?.trim() ? Number(d.horasParaEscalar) : null, d.horasParaEscalar?.trim() ? d.escalarARol : null]);
}

/** Quita un paso. La base impide dejar el flujo sin un paso incondicional. */
export async function quitarPaso(tx: Db, pasoId: string): Promise<void> {
  const { rows } = await tx.query('delete from flujo_paso where id = $1 returning id', [pasoId]);
  if (!rows[0]) throw new ErrorMaestro('El paso no existe.');
}

export async function cambiarActivoFlujo(tx: Db, definicionId: string, activo: boolean): Promise<void> {
  const { rows } = await tx.query('update flujo_definicion set activo = $2 where id = $1 returning id', [definicionId, activo]);
  if (!rows[0]) throw new ErrorMaestro('El flujo no existe.');
}
