import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Libro diario y libro mayor (spec §12.5): legales, en bolívares y con numeración. Son lecturas del mayor —los asientos contabilizados son inmutables y su
 * número es correlativo y sin huecos— así que no guardan nada: el mismo rango siempre da el mismo libro.
 *
 *   Libro diario: cada asiento con su número, fecha, líneas y totales, en orden de número. Se reparte en folios (hojas numeradas) de un máximo de líneas
 *   (parámetro de la pantalla): un asiento no se parte entre dos folios y cada folio trae su total y el acumulado, para encadenar las hojas.
 *   Libro mayor: los movimientos de una cuenta y de sus subcuentas, con saldo inicial al día anterior al rango y saldo después de cada línea.
 */

export const ROLES_VEN_LIBROS = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ASIENTOS_DIARIO = 2000;
const MAX_LINEAS_MAYOR = 5000;
export const LINEAS_POR_FOLIO = 40;

function validarRango(desde: string, hasta: string) {
  if (!FECHA.test(desde) || !FECHA.test(hasta)) throw new ErrorMaestro('Indique un rango de fechas válido.');
  if (hasta < desde) throw new ErrorMaestro('La fecha final no puede ser anterior a la inicial.');
}

// ---------------------------------------------------------------------
// Libro diario
// ---------------------------------------------------------------------

export interface LineaDiario { codigo: string; cuenta: string; glosa: string | null; debe: Decimal; haber: Decimal }
export interface AsientoDiario { id: string; numero: string; fecha: string; tipo: string; descripcion: string; lineas: LineaDiario[]; debe: Decimal; haber: Decimal }
export interface FolioDiario {
  folio: number; asientos: AsientoDiario[]; debe: Decimal; haber: Decimal;
  /** Totales desde el primer folio hasta este (lo que «pasa» al folio siguiente). */
  debeAcumulado: Decimal; haberAcumulado: Decimal;
}

/**
 * Reparte los asientos en folios de a lo sumo `lineasPorFolio` renglones (cada asiento ocupa su encabezado más sus líneas). Un asiento no se parte: si no cabe
 * en lo que queda del folio, abre el siguiente; uno más largo que un folio completo ocupa uno solo.
 */
export function asignarFolios(asientos: AsientoDiario[], lineasPorFolio = LINEAS_POR_FOLIO, folioInicial = 1): FolioDiario[] {
  if (!Number.isInteger(lineasPorFolio) || lineasPorFolio < 5 || lineasPorFolio > 200) throw new ErrorMaestro('Las líneas por folio deben estar entre 5 y 200.');
  if (!Number.isInteger(folioInicial) || folioInicial < 1 || folioInicial > 99999) throw new ErrorMaestro('Indique un folio inicial válido.');
  const folios: FolioDiario[] = [];
  let acD = new Decimal(0);
  let acH = new Decimal(0);
  let usadas = 0;
  let actual: FolioDiario | null = null;
  for (const a of asientos) {
    const ocupa = a.lineas.length + 1;
    if (!actual || (usadas > 0 && usadas + ocupa > lineasPorFolio)) {
      actual = { folio: folioInicial + folios.length, asientos: [], debe: new Decimal(0), haber: new Decimal(0), debeAcumulado: acD, haberAcumulado: acH };
      folios.push(actual);
      usadas = 0;
    }
    actual.asientos.push(a);
    actual.debe = actual.debe.plus(a.debe);
    actual.haber = actual.haber.plus(a.haber);
    acD = acD.plus(a.debe);
    acH = acH.plus(a.haber);
    actual.debeAcumulado = acD;
    actual.haberAcumulado = acH;
    usadas += ocupa;
  }
  return folios;
}

export interface LibroDiario { desde: string; hasta: string; folios: FolioDiario[]; asientos: number; debe: Decimal; haber: Decimal; cuadra: boolean }

/** Asientos contabilizados con fecha en [desde, hasta], en orden de número, repartidos en folios. */
export async function libroDiario(db: Db, desde: string, hasta: string, opciones: { lineasPorFolio?: number; folioInicial?: number } = {}): Promise<LibroDiario> {
  validarRango(desde, hasta);
  const n = (await db.query<{ n: number }>(`select count(*)::int as n from asiento where estado = 'contabilizado' and fecha between $1::date and $2::date`, [desde, hasta])).rows[0].n;
  if (n > MAX_ASIENTOS_DIARIO) throw new ErrorMaestro(`El rango tiene ${n} asientos; acótelo a un máximo de ${MAX_ASIENTOS_DIARIO} para armar el libro.`);
  const { rows } = await db.query<{
    id: string; numero: string; fecha: string; tipo: string; descripcion: string; codigo: string; cuenta: string; glosa: string | null; debe: string; haber: string;
  }>(
    `select a.id, a.numero::text, a.fecha::text, a.tipo, a.descripcion, c.codigo, c.nombre as cuenta, l.glosa, l.debe_ves::text as debe, l.haber_ves::text as haber
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.estado = 'contabilizado' and a.fecha between $1::date and $2::date
      order by a.numero, l.id`, [desde, hasta]);
  const asientos: AsientoDiario[] = [];
  for (const r of rows) {
    let a = asientos[asientos.length - 1];
    if (!a || a.id !== r.id) {
      a = { id: r.id, numero: r.numero, fecha: r.fecha, tipo: r.tipo, descripcion: r.descripcion, lineas: [], debe: new Decimal(0), haber: new Decimal(0) };
      asientos.push(a);
    }
    const debe = new Decimal(r.debe);
    const haber = new Decimal(r.haber);
    a.lineas.push({ codigo: r.codigo, cuenta: r.cuenta, glosa: r.glosa, debe, haber });
    a.debe = a.debe.plus(debe);
    a.haber = a.haber.plus(haber);
  }
  const folios = asignarFolios(asientos, opciones.lineasPorFolio, opciones.folioInicial);
  const debe = asientos.reduce((s, a) => s.plus(a.debe), new Decimal(0));
  const haber = asientos.reduce((s, a) => s.plus(a.haber), new Decimal(0));
  return { desde, hasta, folios, asientos: asientos.length, debe, haber, cuadra: debe.equals(haber) };
}

// ---------------------------------------------------------------------
// Libro mayor
// ---------------------------------------------------------------------

export interface MovimientoMayor {
  fecha: string; asiento: string; tipo: string; descripcion: string; codigo: string; glosa: string | null;
  debe: Decimal; haber: Decimal; saldo: Decimal;
}
export interface LibroMayor {
  cuenta: { codigo: string; nombre: string; naturaleza: 'D' | 'A' };
  desde: string; hasta: string; subcuentas: number;
  saldoInicial: Decimal; movimientos: MovimientoMayor[]; debe: Decimal; haber: Decimal; saldoFinal: Decimal;
}

/** Saldo en la naturaleza de la cuenta: deudora = debe − haber; acreedora = haber − debe. */
const enNaturaleza = (neto: Decimal, nat: 'D' | 'A') => (nat === 'D' ? neto : neto.negated());

export async function cuentasDelLibro(db: Db): Promise<{ codigo: string; nombre: string }[]> {
  const { rows } = await db.query<{ codigo: string; nombre: string }>(
    `select codigo, nombre from cuenta_contable where activa order by string_to_array(codigo, '.')::int[]`);
  return rows;
}

/** Movimientos de una cuenta y de sus subcuentas en [desde, hasta], con saldo inicial y saldo corrido, en bolívares. */
export async function libroMayor(db: Db, codigo: string, desde: string, hasta: string): Promise<LibroMayor> {
  validarRango(desde, hasta);
  const { rows: cu } = await db.query<{ codigo: string; nombre: string; naturaleza: 'D' | 'A' }>('select codigo, nombre, naturaleza from cuenta_contable where codigo = $1', [codigo]);
  if (!cu[0]) throw new ErrorMaestro('Seleccione una cuenta del plan.');
  const cuenta = cu[0];
  const alcance = `c.imputable and (c.codigo = $1 or c.codigo like $1 || '.%')`;
  const sub = (await db.query<{ n: number }>(`select count(*)::int as n from cuenta_contable c where ${alcance}`, [codigo])).rows[0].n;

  const ini = (await db.query<{ neto: string }>(
    `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as neto
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' and a.fecha < $2::date
       join cuenta_contable c on c.id = l.cuenta_id where ${alcance}`, [codigo, desde])).rows[0].neto;
  const n = (await db.query<{ n: number }>(
    `select count(*)::int as n from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' and a.fecha between $2::date and $3::date
       join cuenta_contable c on c.id = l.cuenta_id where ${alcance}`, [codigo, desde, hasta])).rows[0].n;
  if (n > MAX_LINEAS_MAYOR) throw new ErrorMaestro(`El rango tiene ${n} movimientos; acótelo a un máximo de ${MAX_LINEAS_MAYOR} para armar el libro.`);

  const { rows } = await db.query<{ fecha: string; asiento: string; tipo: string; descripcion: string; codigo: string; glosa: string | null; debe: string; haber: string }>(
    `select a.fecha::text, a.numero::text as asiento, a.tipo, a.descripcion, c.codigo, l.glosa, l.debe_ves::text as debe, l.haber_ves::text as haber
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' and a.fecha between $2::date and $3::date
       join cuenta_contable c on c.id = l.cuenta_id where ${alcance}
      order by a.fecha, a.numero, l.id`, [codigo, desde, hasta]);

  const saldoInicial = enNaturaleza(new Decimal(ini), cuenta.naturaleza);
  let saldo = saldoInicial;
  let debe = new Decimal(0);
  let haber = new Decimal(0);
  const movimientos = rows.map((r): MovimientoMayor => {
    const d = new Decimal(r.debe);
    const h = new Decimal(r.haber);
    debe = debe.plus(d);
    haber = haber.plus(h);
    saldo = saldo.plus(enNaturaleza(d.minus(h), cuenta.naturaleza));
    return { fecha: r.fecha, asiento: r.asiento, tipo: r.tipo, descripcion: r.descripcion, codigo: r.codigo, glosa: r.glosa, debe: d, haber: h, saldo };
  });
  return { cuenta, desde, hasta, subcuentas: sub, saldoInicial, movimientos, debe, haber, saldoFinal: saldo };
}
