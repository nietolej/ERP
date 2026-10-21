import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Disponibilidad y velocidad de venta (spec_reportes §9.1, migración 0027). Todo se calcula en la base, en fn_disponibilidad:
 * aquí solo se consulta, se filtra y se presenta. Los umbrales del estado de salud son parámetros de inventario.
 */

export const ROLES_VEN_DISPONIBILIDAD = [
  'almacen', 'compras', 'gerencia', 'supervisor_ventas', 'contabilidad', 'jefe_contabilidad', 'auditor',
] as const satisfies readonly Rol[];

export const ESTADOS_SALUD = ['RIESGO_QUIEBRE', 'DEMANDA_REPRIMIDA', 'SOBRESTOCK', 'SIN_ROTACION', 'SALUDABLE'] as const;
export type EstadoSalud = (typeof ESTADOS_SALUD)[number];

export const NOMBRE_ESTADO_SALUD: Record<EstadoSalud, { texto: string; tono: 'peligro' | 'advertencia' | 'info' | 'exito'; ayuda: string }> = {
  RIESGO_QUIEBRE: { texto: 'Riesgo de quiebre', tono: 'peligro', ayuda: 'Sin existencia o con cobertura menor al mínimo' },
  DEMANDA_REPRIMIDA: { texto: 'Demanda reprimida', tono: 'advertencia', ayuda: 'Se vende bien cuando hay, pero pasa muchos días sin existencia' },
  SOBRESTOCK: { texto: 'Sobrestock', tono: 'advertencia', ayuda: 'Cobertura mayor al máximo con ventas' },
  SIN_ROTACION: { texto: 'Sin rotación', tono: 'info', ayuda: 'Tiene existencia y no vendió nada en el periodo' },
  SALUDABLE: { texto: 'Saludable', tono: 'exito', ayuda: 'Dentro de los umbrales' },
};

export interface FilaDisponibilidad {
  producto_id: string;
  codigo: string;
  descripcion: string;
  dias_periodo: number;
  dias_con_existencia: number;
  dias_sin_existencia: number;
  pct_disponibilidad: string;
  unidades_vendidas: string;
  velocidad_basica: string | null;
  velocidad_ajustada: string | null;
  stock_comercial: string;
  cobertura_dias: string | null;
  venta_perdida_unidades: string | null;
  precio_lista_a_usd: string | null;
  venta_perdida_usd: string | null;
  estado_salud: EstadoSalud;
}

export const ORDENES = {
  venta_perdida: 'd.venta_perdida_usd desc nulls last, d.dias_sin_existencia desc, p.codigo',
  dias_sin_existencia: 'd.dias_sin_existencia desc, p.codigo',
  cobertura: 'd.cobertura_dias asc nulls last, p.codigo',
  velocidad: 'd.velocidad_ajustada desc nulls last, p.codigo',
  codigo: 'p.codigo',
} as const;
export type OrdenDisponibilidad = keyof typeof ORDENES;

export interface FiltroDisponibilidad {
  /** Por defecto, la ventana de VENTANA_VELOCIDAD_DIAS terminada hoy. */
  desde?: string;
  hasta?: string;
  texto?: string;
  estado?: string;
  orden?: OrdenDisponibilidad;
  limite?: number;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function validarPeriodo(desde?: string, hasta?: string): void {
  if ((desde && !FECHA.test(desde)) || (hasta && !FECHA.test(hasta))) throw new ErrorMaestro('Las fechas deben tener el formato aaaa-mm-dd.');
  if (desde && hasta && desde > hasta) throw new ErrorMaestro('La fecha inicial no puede ser posterior a la final.');
  if (desde && hasta && (new Date(hasta).getTime() - new Date(desde).getTime()) / 86_400_000 > 1100) {
    throw new ErrorMaestro('El periodo no puede pasar de tres años.');
  }
}

const HOY = `((now() at time zone 'America/Caracas')::date)`;

export async function consultarDisponibilidad(db: Db, f: FiltroDisponibilidad = {}): Promise<{ desde: string; hasta: string; filas: FilaDisponibilidad[] }> {
  validarPeriodo(f.desde, f.hasta);
  const estado = (ESTADOS_SALUD as readonly string[]).includes(f.estado ?? '') ? f.estado! : '';
  const orden = ORDENES[f.orden ?? 'venta_perdida'];
  const texto = (f.texto ?? '').trim();
  // El periodo por omisión sale de la base, junto con el parámetro de la ventana.
  const { rows: pe } = await db.query<{ desde: string; hasta: string }>(
    `select (coalesce($1::date, ${HOY} - (fn_parametro_inventario('VENTANA_VELOCIDAD_DIAS')::int - 1)))::text as desde,
            (coalesce($2::date, ${HOY}))::text as hasta`,
    [f.desde || null, f.hasta || null]);
  const { desde, hasta } = pe[0];
  const { rows } = await db.query<FilaDisponibilidad>(
    `select d.producto_id, p.codigo, p.descripcion, d.dias_periodo, d.dias_con_existencia, d.dias_sin_existencia,
            d.pct_disponibilidad::text, d.unidades_vendidas::text, d.velocidad_basica::text, d.velocidad_ajustada::text,
            d.stock_comercial::text, d.cobertura_dias::text, d.venta_perdida_unidades::text, d.precio_lista_a_usd::text,
            d.venta_perdida_usd::text, d.estado_salud
       from fn_disponibilidad($1::date, $2::date) d
       join producto p on p.id = d.producto_id
      where ($3 = '' or d.estado_salud = $3)
        and ($4 = '' or p.codigo ilike '%' || $4 || '%' or fn_nombre_normalizado(p.descripcion) like '%' || fn_nombre_normalizado($4) || '%')
      order by ${orden}
      limit $5`,
    [desde, hasta, estado, texto, Math.min(Math.max(f.limite ?? 200, 1), 1000)]);
  return { desde, hasta, filas: rows };
}

/** Cuántos productos hay en cada estado de salud en el periodo. */
export async function resumenSalud(db: Db, desde: string, hasta: string): Promise<Record<EstadoSalud, number>> {
  validarPeriodo(desde, hasta);
  const { rows } = await db.query<{ estado_salud: EstadoSalud; n: number }>(
    'select estado_salud, count(*)::int as n from fn_disponibilidad($1::date, $2::date) group by estado_salud', [desde, hasta]);
  const r = Object.fromEntries(ESTADOS_SALUD.map((e) => [e, 0])) as Record<EstadoSalud, number>;
  for (const x of rows) r[x.estado_salud] = x.n;
  return r;
}
