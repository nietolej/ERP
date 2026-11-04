import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from './terceros';

/**
 * Parámetros de reportes e inventario (spec_reportes §1.4: ningún umbral vive en el código). Los edita Gerencia, y cada cambio
 * queda en la auditoría (trigger fn_audit de ambas tablas). Aquí solo se cambia el valor: el código, la descripción y la unidad
 * son parte del diseño del reporte y los fija una migración.
 */

export const ROLES_PARAMETROS = ['gerencia', 'administrador'] as const;

export type TablaParametro = 'reporte' | 'inventario' | 'conciliacion';
const TABLA_SQL: Record<TablaParametro, string> = { reporte: 'parametro_reporte', inventario: 'parametro_inventario', conciliacion: 'parametro_conciliacion' };

/** Parámetros opcionales: no tienen valor inicial y el reporte oculta lo que depende de ellos mientras no se carguen. */
export const PARAMETROS_OPCIONALES: { tabla: TablaParametro; codigo: string; descripcion: string; unidad: string }[] = [
  { tabla: 'reporte', codigo: 'COSTO_POR_DEVOLUCION_USD', descripcion: 'Devoluciones: costo operativo estimado de cada devolución (habilita la tarjeta "Costo operativo estimado")', unidad: 'usd' },
];

export interface Parametro { tabla: TablaParametro; codigo: string; descripcion: string; valor: string; unidad: string; }

export const NOMBRE_UNIDAD: Record<string, string> = {
  dias: 'días', porcentaje: '%', unidades: 'unidades', usd: 'US$', unidades_por_dia: 'unidades por día',
};

export async function listarParametros(db: Db): Promise<Parametro[]> {
  const { rows } = await db.query<Parametro>(
    `select 'reporte' as tabla, codigo, descripcion, valor::text, unidad from parametro_reporte
     union all select 'inventario', codigo, descripcion, valor::text, unidad from parametro_inventario
     union all select 'conciliacion', codigo, descripcion, valor::text, unidad from parametro_conciliacion
     order by 1, 2`);
  return rows;
}

/** Valor ingresado a decimal exacto (admite coma decimal); error de negocio si no es un número no negativo con hasta 4 decimales. */
export function leerValor(entrada: string): Decimal {
  const v = entrada.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(v)) throw new ErrorMaestro('Escriba un número positivo, con hasta 4 decimales (por ejemplo 15 o 0,1).');
  return new Decimal(v);
}

async function valorDe(db: Db, tabla: TablaParametro, codigo: string): Promise<Decimal | null> {
  const { rows } = await db.query<{ valor: string }>(`select valor::text from ${TABLA_SQL[tabla]} where codigo = $1`, [codigo]);
  return rows[0] ? new Decimal(rows[0].valor) : null;
}

/**
 * Cambia el valor de un parámetro existente (o crea uno de los opcionales). Valida el tipo de unidad y las relaciones entre
 * parámetros que, si se invierten, rompen el reporte (tramo y tope del histograma; riesgo y sobrestock de cobertura).
 */
export async function actualizarParametro(tx: Db, tabla: string, codigo: string, entrada: string): Promise<{ anterior: string | null; nuevo: string }> {
  if (tabla !== 'reporte' && tabla !== 'inventario' && tabla !== 'conciliacion') throw new ErrorMaestro('Parámetro desconocido.');
  const valor = leerValor(entrada);
  const opcional = PARAMETROS_OPCIONALES.find((p) => p.tabla === tabla && p.codigo === codigo);
  const { rows } = await tx.query<{ unidad: string }>(`select unidad from ${TABLA_SQL[tabla]} where codigo = $1 for update`, [codigo]);
  const unidad = rows[0]?.unidad ?? opcional?.unidad;
  if (!unidad) throw new ErrorMaestro('Parámetro desconocido.');

  if (unidad === 'dias' && (!valor.isInteger() || valor.lt(1))) throw new ErrorMaestro('Los días deben ser un número entero de 1 en adelante.');
  if (unidad === 'porcentaje' && valor.gt(100) && !codigo.endsWith('TENDENCIA_PCT')) throw new ErrorMaestro('Un porcentaje no puede pasar de 100.');

  const otro = async (c: string) => valorDe(tx, tabla, c);
  if (codigo === 'HISTOGRAMA_PEDIDOS_TRAMO_USD') {
    if (valor.lte(0)) throw new ErrorMaestro('El ancho del tramo debe ser mayor que cero.');
    const tope = await otro('HISTOGRAMA_PEDIDOS_TOPE_USD');
    if (tope && valor.gt(tope)) throw new ErrorMaestro(`El tramo no puede ser mayor que el tope (US$ ${tope.toFixed(2)}).`);
  }
  if (codigo === 'HISTOGRAMA_PEDIDOS_TOPE_USD') {
    const tramo = await otro('HISTOGRAMA_PEDIDOS_TRAMO_USD');
    if (tramo && valor.lt(tramo)) throw new ErrorMaestro(`El tope no puede ser menor que el ancho del tramo (US$ ${tramo.toFixed(2)}).`);
  }
  if (codigo === 'COBERTURA_RIESGO_DIAS') {
    const sobre = await otro('COBERTURA_SOBRESTOCK_DIAS');
    if (sobre && valor.gte(sobre)) throw new ErrorMaestro(`La cobertura de riesgo debe ser menor que la de sobrestock (${sobre.toFixed(0)} días).`);
  }
  if (codigo === 'COBERTURA_SOBRESTOCK_DIAS') {
    const riesgo = await otro('COBERTURA_RIESGO_DIAS');
    if (riesgo && valor.lte(riesgo)) throw new ErrorMaestro(`La cobertura de sobrestock debe ser mayor que la de riesgo (${riesgo.toFixed(0)} días).`);
  }

  const anterior = rows[0] ? (await valorDe(tx, tabla, codigo))!.toString() : null;
  if (rows[0]) {
    await tx.query(`update ${TABLA_SQL[tabla]} set valor = $2 where codigo = $1`, [codigo, valor.toString()]);
  } else {
    await tx.query(`insert into ${TABLA_SQL[tabla]} (codigo, descripcion, valor, unidad) values ($1, $2, $3, $4)`,
      [codigo, opcional!.descripcion, valor.toString(), opcional!.unidad]);
  }
  return { anterior, nuevo: valor.toString() };
}
