import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';

/**
 * CRM y postventa (módulo CR, §6.5, migración 0058). Seguridad por fila (regla 4): quien solo tiene el rol Ventas ve y
 * trabaja únicamente sus prospectos, oportunidades, cotizaciones, actividades y los de su cartera de clientes; el
 * Supervisor de ventas y Gerencia ven todo (no hay equipos: decisión del 10-11-2026). El Auditor solo lee.
 */

export type Usuario = { id: string; roles: readonly string[] };

/** Trabajan el CRM comercial (prospectos, oportunidades, cotizaciones, actividades). */
export const ROLES_CRM = ['ventas', 'supervisor_ventas', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_CRM = [...ROLES_CRM, 'auditor'] as const satisfies readonly Rol[];
/** Abren y atienden casos de postventa. */
export const ROLES_CASOS = ['ventas', 'supervisor_ventas', 'facturacion', 'cobranzas', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_CASOS = [...ROLES_CASOS, 'auditor'] as const satisfies readonly Rol[];

/** Quien solo tiene el rol Ventas (sin Supervisor, Facturación, Cobranzas ni Gerencia) ve solo lo suyo. */
export const soloLoSuyo = (u: Usuario): boolean =>
  u.roles.includes('ventas') && !u.roles.some((r) => ['supervisor_ventas', 'facturacion', 'cobranzas', 'gerencia', 'auditor'].includes(r));

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Vendedor enlazado al usuario, si lo tiene. */
export async function vendedorDeUsuario(db: Db, usuarioId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`select id from vendedor where usuario_id = $1 and estado = 'activo'`, [usuarioId]);
  return rows[0]?.id ?? null;
}

export interface TerceroCrm {
  id: string; rif: string; razon_social: string;
  es_cliente: boolean; cliente_estado: string | null; cliente_codigo: string | null;
  es_prospecto: boolean; prospecto_estado: string | null;
  /** Vendedor responsable: el del cliente o, si aún es prospecto, el del prospecto. */
  vendedor_id: string | null; vendedor_usuario: string | null; vendedor: string | null;
}

/** Datos de CRM de un tercero (cliente o prospecto); null si no es ninguno. */
export async function terceroCrm(db: Db, id: string): Promise<TerceroCrm | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<TerceroCrm>(
    `select t.id, t.rif, t.razon_social,
            c.tercero_id is not null as es_cliente, c.estado as cliente_estado, c.codigo as cliente_codigo,
            p.tercero_id is not null as es_prospecto, p.estado as prospecto_estado,
            v.id as vendedor_id, v.usuario_id as vendedor_usuario, v.nombre as vendedor
       from tercero t
       left join cliente c on c.tercero_id = t.id
       left join prospecto p on p.tercero_id = t.id
       left join vendedor v on v.id = coalesce(c.vendedor_id, p.vendedor_id)
      where t.id = $1 and (c.tercero_id is not null or p.tercero_id is not null)`, [id]);
  return rows[0] ?? null;
}

/** ¿Puede el usuario ver la ficha de CRM de ese tercero? */
export function puedeVerTercero(u: Usuario, t: Pick<TerceroCrm, 'vendedor_usuario'>): boolean {
  return !soloLoSuyo(u) || t.vendedor_usuario === u.id;
}

/** Exige que el tercero exista en el CRM y que el usuario pueda trabajarlo. */
export async function exigirTercero(db: Db, u: Usuario, id: string): Promise<TerceroCrm> {
  const t = await terceroCrm(db, id);
  if (!t) throw new ErrorMaestro('Seleccione un cliente o un prospecto.');
  if (!puedeVerTercero(u, t)) throw new ErrorMaestro('Ese cliente o prospecto es de otro vendedor.');
  return t;
}

/** Vendedor con que se registra algo: el del usuario si solo vende lo suyo; si no, el indicado o el del tercero. */
export async function vendedorParaRegistro(db: Db, u: Usuario, indicado: string | null | undefined, delTercero: string | null): Promise<string> {
  if (soloLoSuyo(u)) {
    const propio = await vendedorDeUsuario(db, u.id);
    if (!propio) throw new ErrorMaestro('Su usuario no está enlazado a un vendedor activo: pídaselo a Gerencia.');
    return propio;
  }
  const id = indicado || delTercero;
  if (!id) throw new ErrorMaestro('Seleccione el vendedor.');
  const { rows } = await db.query(`select 1 from vendedor where id = $1 and estado = 'activo'`, [id]);
  if (!rows.length) throw new ErrorMaestro('El vendedor no existe o está inactivo.');
  return id;
}

export const MONTO = /^\d{1,12}(\.\d{1,2})?$/;
export const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
export const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;
export const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Texto decimal con coma o punto → con punto. */
export const decimal = (v: string | undefined | null) => (v ?? '').trim().replace(',', '.');
