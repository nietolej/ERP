import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { obtenerOCrearTercero, rifOError, vacioANull, type DatosTercero } from '@/lib/maestros/terceros';
import { exigirTercero, soloLoSuyo, vendedorParaRegistro, type Usuario } from './comun';

/**
 * Prospectos (§6.5 regla 1, migración 0058): un tercero con RIF que aún no es cliente, asignado a un vendedor. No se le pide
 * ni se le factura. Se convierte en cliente al ganar su primera oportunidad, por el alta normal con aprobación de Gerencia.
 */

export interface DatosProspecto {
  rif: string;
  tercero: DatosTercero;
  vendedorId?: string | null;
  origen?: string;
  confirmarNombreParecido?: boolean;
}

export async function registrarProspecto(tx: Db, u: Usuario, d: DatosProspecto): Promise<string> {
  const rif = rifOError(d.rif);
  const { rows: previo } = await tx.query<{ cliente: string | null; prospecto: string | null }>(
    `select c.codigo as cliente, p.estado as prospecto
       from tercero t left join cliente c on c.tercero_id = t.id left join prospecto p on p.tercero_id = t.id
      where t.rif = $1`, [rif]);
  if (previo[0]?.cliente) throw new ErrorMaestro(`El RIF ${rif} ya es el cliente ${previo[0].cliente}.`);
  if (previo[0]?.prospecto) throw new ErrorMaestro(`El RIF ${rif} ya está registrado como prospecto.`);
  const vendedorId = await vendedorParaRegistro(tx, u, d.vendedorId, null);
  const t = await obtenerOCrearTercero(tx, u.id, rif, d.tercero, d.confirmarNombreParecido);
  await tx.query(
    `insert into prospecto (tercero_id, vendedor_id, origen, created_by) values ($1, $2, $3, $4)`,
    [t.id, vendedorId, vacioANull(d.origen), u.id]);
  return t.id;
}

export async function descartarProspecto(tx: Db, u: Usuario, id: string, motivo: string): Promise<void> {
  const t = await exigirTercero(tx, u, id);
  if (t.prospecto_estado !== 'activo') throw new ErrorMaestro('Solo se descarta un prospecto activo.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique por qué se descarta el prospecto.');
  await tx.query(`update prospecto set estado = 'descartado', descartado_motivo = $2 where tercero_id = $1`, [id, motivo.trim()]);
}

export async function reactivarProspecto(tx: Db, u: Usuario, id: string): Promise<void> {
  const t = await exigirTercero(tx, u, id);
  if (t.prospecto_estado !== 'descartado') throw new ErrorMaestro('Solo se reactiva un prospecto descartado.');
  await tx.query(`update prospecto set estado = 'activo' where tercero_id = $1`, [id]);
}

/** Supervisor o Gerencia reasignan el prospecto a otro vendedor. */
export async function reasignarProspecto(tx: Db, u: Usuario, id: string, vendedorId: string): Promise<void> {
  if (soloLoSuyo(u)) throw new ErrorMaestro('Solo el Supervisor de ventas o Gerencia reasignan prospectos.');
  const t = await exigirTercero(tx, u, id);
  if (t.prospecto_estado !== 'activo') throw new ErrorMaestro('Solo se reasigna un prospecto activo.');
  const v = await vendedorParaRegistro(tx, u, vendedorId, null);
  await tx.query('update prospecto set vendedor_id = $2 where tercero_id = $1', [id, v]);
}

export interface FilaProspecto {
  id: string; rif: string; razon_social: string; vendedor: string; origen: string | null; estado: string;
  creado: string; oportunidades_abiertas: number; ultima_actividad: string | null;
}

export async function listarProspectos(db: Db, u: Usuario, filtro: { estado?: string; texto?: string } = {}, limite = 200): Promise<FilaProspecto[]> {
  const texto = (filtro.texto ?? '').trim();
  const { rows } = await db.query<FilaProspecto>(
    `select p.tercero_id as id, t.rif, t.razon_social, v.nombre as vendedor, p.origen, p.estado,
            to_char(p.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as creado,
            (select count(*)::int from oportunidad o where o.tercero_id = p.tercero_id and o.cerrada_at is null) as oportunidades_abiertas,
            (select to_char(max(a.fecha) at time zone 'America/Caracas', 'DD-MM-YYYY') from actividad_crm a where a.tercero_id = p.tercero_id) as ultima_actividad
       from prospecto p
       join tercero t on t.id = p.tercero_id
       join vendedor v on v.id = p.vendedor_id
      where (not $1 or v.usuario_id = $2)
        and ($3 = '' or p.estado = $3)
        and ($4 = '' or replace(t.rif, '-', '') ilike '%' || replace($4, '-', '') || '%'
                     or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($4) || '%')
      order by p.estado = 'activo' desc, p.created_at desc
      limit $5`, [soloLoSuyo(u), u.id, filtro.estado ?? '', texto, limite]);
  return rows;
}

/** Clientes activos y prospectos activos que el usuario puede trabajar (para los selectores). */
export async function tercerosComerciales(db: Db, u: Usuario): Promise<{ id: string; etiqueta: string; prospecto: boolean }[]> {
  const { rows } = await db.query<{ id: string; etiqueta: string; prospecto: boolean }>(
    `select t.id, coalesce(c.codigo, 'Prospecto') || ' · ' || t.razon_social as etiqueta, c.tercero_id is null as prospecto
       from tercero t
       left join cliente c on c.tercero_id = t.id and c.estado = 'activo'
       left join prospecto p on p.tercero_id = t.id and p.estado = 'activo'
       left join vendedor v on v.id = coalesce(c.vendedor_id, p.vendedor_id)
      where (c.tercero_id is not null or p.tercero_id is not null)
        and (not $1 or v.usuario_id = $2)
      order by c.tercero_id is null, t.razon_social`, [soloLoSuyo(u), u.id]);
  return rows;
}
