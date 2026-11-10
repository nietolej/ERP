import type { Db } from '@/lib/db/tipos';
import { soloLoSuyo, type Usuario } from './comun';

/**
 * Indicadores del CRM (§6.5 regla 6). Se calculan una sola vez en la base (migración 0058: vw_crm_embudo,
 * fn_crm_conversion, fn_crm_actividades, vw_crm_clientes_sin_contacto, fn_crm_casos); aquí solo se filtran por la
 * seguridad por fila y se les pone nombre. Quien solo vende ve sus propias cifras.
 */

export interface FilaEmbudo { etapa: string; orden: number; oportunidades: number; monto_usd: string; probabilidad_pct: string; ponderado_usd: string }

export async function embudo(db: Db, u: Usuario): Promise<FilaEmbudo[]> {
  const { rows } = await db.query<FilaEmbudo>(
    `select e.etapa, e.orden, sum(e.oportunidades)::int as oportunidades, sum(e.monto_usd)::text as monto_usd,
            max(e.probabilidad_pct)::text as probabilidad_pct, sum(e.ponderado_usd)::text as ponderado_usd
       from vw_crm_embudo e join vendedor v on v.id = e.vendedor_id
      where (not $1 or v.usuario_id = $2)
      group by e.etapa, e.orden order by e.orden`, [soloLoSuyo(u), u.id]);
  return rows;
}

export interface FilaConversion { vendedor: string; ganadas: number; perdidas: number; tasa_pct: string; monto_ganado_usd: string; ciclo_dias: string | null }

export async function conversion(db: Db, u: Usuario, desde: string, hasta: string): Promise<FilaConversion[]> {
  const { rows } = await db.query<FilaConversion>(
    `select v.nombre as vendedor, f.ganadas, f.perdidas, f.tasa_pct::text, f.monto_ganado_usd::text, f.ciclo_dias::text
       from fn_crm_conversion($3::date, $4::date) f join vendedor v on v.id = f.vendedor_id
      where (not $1 or v.usuario_id = $2)
      order by f.monto_ganado_usd desc, v.nombre`, [soloLoSuyo(u), u.id, desde, hasta]);
  return rows;
}

export interface FilaActividades { usuario: string; visitas: number; llamadas: number; mensajes: number; correos: number; tareas: number; total: number }

export async function actividadesPorVendedor(db: Db, u: Usuario, desde: string, hasta: string): Promise<FilaActividades[]> {
  const { rows } = await db.query<FilaActividades>(
    `select coalesce(v.nombre, us.nombre) as usuario, f.visitas, f.llamadas, f.mensajes, f.correos, f.tareas, f.total
       from fn_crm_actividades($3::date, $4::date) f join usuario us on us.id = f.usuario_id left join vendedor v on v.id = f.vendedor_id
      where (not $1 or f.usuario_id = $2)
      order by f.total desc`, [soloLoSuyo(u), u.id, desde, hasta]);
  return rows;
}

export interface FilaSinContacto { cliente_id: string; cliente: string; vendedor: string | null; ultima_actividad: string | null; dias_sin_contacto: number }

export async function clientesSinContacto(db: Db, u: Usuario, limite = 100): Promise<{ dias: number; filas: FilaSinContacto[] }> {
  const { rows: p } = await db.query<{ v: string }>(`select fn_parametro_reporte('CRM_SIN_CONTACTO_DIAS')::text as v`);
  const { rows } = await db.query<FilaSinContacto>(
    `select s.cliente_id, c.codigo || ' · ' || t.razon_social as cliente, v.nombre as vendedor,
            to_char(s.ultima_actividad at time zone 'America/Caracas', 'DD-MM-YYYY') as ultima_actividad, s.dias_sin_contacto
       from vw_crm_clientes_sin_contacto s
       join cliente c on c.tercero_id = s.cliente_id
       join tercero t on t.id = s.cliente_id
       left join vendedor v on v.id = s.vendedor_id
      where (not $1 or v.usuario_id = $2)
      order by s.dias_sin_contacto desc limit $3`, [soloLoSuyo(u), u.id, limite]);
  return { dias: Number(p[0].v), filas: rows };
}

export interface FilaCasos { tipo: string; resueltos: number; dias_resolucion: string | null; pendientes: number }

/** Tiempo de resolución por tipo de caso. Es un indicador de la empresa: el vendedor no lo filtra por cartera. */
export async function casosPorTipo(db: Db, desde: string, hasta: string): Promise<FilaCasos[]> {
  const { rows } = await db.query<FilaCasos>(
    `select tipo, resueltos, dias_resolucion::text, pendientes from fn_crm_casos($1::date, $2::date)`, [desde, hasta]);
  return rows;
}
