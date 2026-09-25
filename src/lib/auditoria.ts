import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';

/**
 * Consulta del registro de auditoría (audit_log, §4.3). Es solo lectura: la tabla es inmutable.
 * Los filtros son fechas, usuario, entidad y acción: nunca texto libre sobre el contenido,
 * para que ningún dato personal viaje en la dirección de la página.
 */

export const ROLES_VEN_AUDITORIA: Rol[] = ['administrador', 'auditor', 'gerencia'];

export const TAMANO_PAGINA = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const ACCIONES_AUDITORIA = ['INSERT', 'UPDATE', 'DELETE', 'BLOQUEO_ACCESO'] as const;

export interface FiltrosAuditoria {
  desde?: string;
  hasta?: string;
  usuarioId?: string;
  entidad?: string;
  accion?: string;
  entidadId?: string;
  /** Id del último registro de la página anterior: la siguiente página trae los más antiguos. */
  antes?: number;
}

export interface RegistroAuditoria {
  id: string;
  created_at: string;
  usuario: string | null;
  accion: string;
  entidad: string;
  entidad_id: string | null;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
}

/** Deja solo filtros con formato válido: lo demás se ignora (nunca llega a la consulta). */
export function limpiarFiltros(crudo: Record<string, string | undefined>): FiltrosAuditoria {
  const f: FiltrosAuditoria = {};
  const t = (k: string) => crudo[k]?.trim() ?? '';
  if (FECHA.test(t('desde')) && !Number.isNaN(Date.parse(t('desde')))) f.desde = t('desde');
  if (FECHA.test(t('hasta')) && !Number.isNaN(Date.parse(t('hasta')))) f.hasta = t('hasta');
  if (UUID.test(t('usuario'))) f.usuarioId = t('usuario');
  if (/^[a-z][a-z0-9_]{0,62}$/.test(t('entidad'))) f.entidad = t('entidad');
  if ((ACCIONES_AUDITORIA as readonly string[]).includes(t('accion'))) f.accion = t('accion');
  if (/^[0-9a-zA-Z-]{1,64}$/.test(t('registro'))) f.entidadId = t('registro');
  if (/^\d{1,18}$/.test(t('antes'))) f.antes = Number(t('antes'));
  return f;
}

/** Una página de registros, del más reciente al más antiguo. `hayMas` indica si existe otra página. */
export async function consultarAuditoria(db: Db, f: FiltrosAuditoria): Promise<{ filas: RegistroAuditoria[]; hayMas: boolean }> {
  const { rows } = await db.query<RegistroAuditoria>(
    `select a.id::text, a.created_at, u.nombre as usuario, a.accion, a.entidad, a.entidad_id, a.antes, a.despues
       from audit_log a left join usuario u on u.id = a.usuario_id
      where ($1::date is null or a.created_at >= ($1::date)::timestamp at time zone 'America/Caracas')
        and ($2::date is null or a.created_at <  (($2::date) + 1)::timestamp at time zone 'America/Caracas')
        and ($3::uuid is null or a.usuario_id = $3)
        and ($4::text is null or a.entidad = $4)
        and ($5::text is null or a.accion = $5)
        and ($6::text is null or a.entidad_id = $6)
        and ($7::bigint is null or a.id < $7)
      order by a.id desc
      limit ${TAMANO_PAGINA + 1}`,
    [f.desde ?? null, f.hasta ?? null, f.usuarioId ?? null, f.entidad ?? null, f.accion ?? null, f.entidadId ?? null, f.antes ?? null]);
  return { filas: rows.slice(0, TAMANO_PAGINA), hayMas: rows.length > TAMANO_PAGINA };
}

/** Entidades que tienen registros, sin recorrer toda la tabla (usa el índice por entidad). */
export async function entidadesAuditadas(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ entidad: string }>(
    `with recursive t as (
       (select entidad from audit_log order by entidad limit 1)
       union all
       select (select entidad from audit_log where entidad > t.entidad order by entidad limit 1) from t where t.entidad is not null)
     select entidad from t where entidad is not null order by entidad`);
  return rows.map((r) => r.entidad);
}

export interface Cambio { campo: string; antes: unknown; despues: unknown }

/**
 * Qué cambió en un registro: en un UPDATE, solo los campos distintos; en un INSERT o DELETE,
 * todos los campos con valor.
 */
export function diferencias(antes: Record<string, unknown> | null, despues: Record<string, unknown> | null): Cambio[] {
  const a = antes ?? {};
  const d = despues ?? {};
  const campos = [...new Set([...Object.keys(a), ...Object.keys(d)])].sort();
  const igual = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const conValor = (v: unknown) => v !== null && v !== undefined;
  const esCambio = antes && despues
    ? (c: string) => !igual(a[c], d[c])
    : (c: string) => conValor(antes ? a[c] : d[c]);
  return campos.filter(esCambio).map((c) => ({ campo: c, antes: a[c], despues: d[c] }));
}

/** Valor para mostrar: texto corto, sin tumbar la pantalla con valores enormes. */
export function valorLegible(v: unknown, max = 200): string {
  if (v === null || v === undefined) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Pantalla del registro afectado, cuando existe. */
const RUTAS: Record<string, string> = {
  cliente: '/maestros/clientes',
  proveedor: '/maestros/proveedores',
  producto: '/maestros/productos',
  vendedor: '/maestros/vendedores',
  almacen: '/maestros/almacenes',
  banco: '/maestros/bancos',
  meta_lote: '/metas/lote',
  asiento: '/contabilidad/asientos',
};

export function rutaDeEntidad(entidad: string, id: string | null): string | null {
  return id && RUTAS[entidad] && UUID.test(id) ? `${RUTAS[entidad]}/${id}` : null;
}
