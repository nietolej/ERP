import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Estados financieros desde el mayor (spec §12.5). Una sola fuente: las líneas de los asientos contabilizados. Se leen en VES (legal) y en USD
 * (gestión, la suma de los valores en USD de cada asiento: sin reexpresión). Nada se calcula con reglas propias fuera de esta agrupación por código del plan:
 *
 *   Estado de situación: activo (1.4 no corriente, el resto corriente), pasivo (2.2 no corriente, el resto corriente) y patrimonio (3.x). El resultado del
 *   ejercicio abierto —ingresos, costos y gastos acumulados que todavía no se cerraron contra 3.3.02— es una partida del patrimonio, así siempre cuadra.
 *   Estado de resultados: con la estructura de §12.5. Excluye los asientos de cierre del ejercicio, que solo traspasan el resultado al patrimonio.
 *   Cambios en el patrimonio: saldo inicial, movimientos, resultado del periodo y saldo final por grupo de cuenta.
 */

export const ROLES_VEN_ESTADOS = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];

export type Moneda = 'ves' | 'usd';
export interface Par { ves: Decimal; usd: Decimal }
const cero = (): Par => ({ ves: new Decimal(0), usd: new Decimal(0) });
const suma = (a: Par, b: Par): Par => ({ ves: a.ves.plus(b.ves), usd: a.usd.plus(b.usd) });
const resta = (a: Par, b: Par): Par => ({ ves: a.ves.minus(b.ves), usd: a.usd.minus(b.usd) });
const neg = (a: Par): Par => ({ ves: a.ves.negated(), usd: a.usd.negated() });
const esCero = (a: Par) => a.ves.isZero() && a.usd.isZero();

/** Saldo neto de una cuenta: debe − haber, en VES y en USD. */
export interface FilaCuenta { codigo: string; nombre: string; tipo: 'activo' | 'pasivo' | 'patrimonio' | 'ingreso' | 'costo' | 'gasto'; neto: Par }

export interface LineaEstado { codigo: string; nombre: string; valor: Par }
export interface Grupo { titulo: string; lineas: LineaEstado[]; total: Par }

const grupo = (titulo: string, lineas: LineaEstado[]): Grupo => ({ titulo, lineas, total: lineas.reduce((s, l) => suma(s, l.valor), cero()) });
const linea = (f: FilaCuenta, signo: 1 | -1): LineaEstado => ({ codigo: f.codigo, nombre: f.nombre, valor: signo === 1 ? f.neto : neg(f.neto) });
const noCero = (f: FilaCuenta) => !esCero(f.neto);

// ---------------------------------------------------------------------
// Estado de situación financiera
// ---------------------------------------------------------------------

export interface Situacion {
  activoCorriente: Grupo; activoNoCorriente: Grupo; totalActivo: Par;
  pasivoCorriente: Grupo; pasivoNoCorriente: Grupo; totalPasivo: Par;
  patrimonio: Grupo; resultadoEjercicio: Par; totalPatrimonio: Par;
  totalPasivoPatrimonio: Par; diferencia: Par; cuadra: boolean;
}

/** `filas`: saldos acumulados de todas las cuentas al corte. */
export function construirSituacion(filas: FilaCuenta[]): Situacion {
  const act = filas.filter((f) => f.tipo === 'activo' && noCero(f));
  const pas = filas.filter((f) => f.tipo === 'pasivo' && noCero(f));
  const pat = filas.filter((f) => f.tipo === 'patrimonio' && noCero(f));
  const resultados = filas.filter((f) => f.tipo === 'ingreso' || f.tipo === 'costo' || f.tipo === 'gasto');
  const resultadoEjercicio = neg(resultados.reduce((s, f) => suma(s, f.neto), cero()));          // ingresos − costos − gastos (acreedor positivo)

  const activoCorriente = grupo('Activo corriente', act.filter((f) => !f.codigo.startsWith('1.4')).map((f) => linea(f, 1)));
  const activoNoCorriente = grupo('Activo no corriente', act.filter((f) => f.codigo.startsWith('1.4')).map((f) => linea(f, 1)));
  const pasivoNoCorriente = grupo('Pasivo no corriente', pas.filter((f) => f.codigo.startsWith('2.2')).map((f) => linea(f, -1)));
  const pasivoCorriente = grupo('Pasivo corriente', pas.filter((f) => !f.codigo.startsWith('2.2')).map((f) => linea(f, -1)));
  const lineasPat = pat.map((f) => linea(f, -1));
  if (!esCero(resultadoEjercicio)) lineasPat.push({ codigo: '', nombre: 'Resultado del ejercicio en curso (sin cerrar)', valor: resultadoEjercicio });
  const patrimonio = grupo('Patrimonio', lineasPat);

  const totalActivo = suma(activoCorriente.total, activoNoCorriente.total);
  const totalPasivo = suma(pasivoCorriente.total, pasivoNoCorriente.total);
  const totalPatrimonio = patrimonio.total;
  const totalPasivoPatrimonio = suma(totalPasivo, totalPatrimonio);
  const diferencia = resta(totalActivo, totalPasivoPatrimonio);
  return {
    activoCorriente, activoNoCorriente, totalActivo, pasivoCorriente, pasivoNoCorriente, totalPasivo, patrimonio, resultadoEjercicio, totalPatrimonio,
    totalPasivoPatrimonio, diferencia, cuadra: esCero(diferencia),
  };
}

// ---------------------------------------------------------------------
// Estado de resultados
// ---------------------------------------------------------------------

export interface Resultados {
  ventasBrutas: Grupo; devoluciones: Grupo; descuentos: Grupo; ventasNetas: Par;
  costoVentas: Grupo; utilidadBruta: Par; margenBrutoPct: string | null;
  gastosVenta: Grupo; gastosAdministracion: Grupo; otrosGastos: Grupo; utilidadOperativa: Par;
  diferencialCambiario: Grupo; gastosFinancieros: Grupo; otrosIngresos: Grupo; utilidadAntesIslr: Par;
  islr: Grupo; utilidadNeta: Par;
}

/** `filas`: movimiento (no acumulado) del periodo de las cuentas de resultados, sin los asientos de cierre. */
export function construirResultados(filas: FilaCuenta[]): Resultados {
  const r = filas.filter((f) => (f.tipo === 'ingreso' || f.tipo === 'costo' || f.tipo === 'gasto') && noCero(f));
  const en = (pred: (f: FilaCuenta) => boolean, signo: 1 | -1) => r.filter(pred).map((f) => linea(f, signo));
  const usado = new Set<string>();
  const toma = (pred: (f: FilaCuenta) => boolean) => (f: FilaCuenta) => { if (usado.has(f.codigo) || !pred(f)) return false; usado.add(f.codigo); return true; };

  const devoluciones = grupo('Devoluciones en ventas', en(toma((f) => f.codigo === '4.1.02'), 1));
  const descuentos = grupo('Descuentos en ventas', en(toma((f) => f.codigo === '4.1.03'), 1));
  const difIng = en(toma((f) => f.codigo === '4.2.01'), -1);
  const otrosIng = en(toma((f) => f.tipo === 'ingreso' && f.codigo.startsWith('4.2')), -1);
  const ventasBrutas = grupo('Ventas brutas', en(toma((f) => f.tipo === 'ingreso'), -1));            // el resto de los ingresos: ventas
  const costoVentas = grupo('Costo de ventas', en(toma((f) => f.tipo === 'costo'), 1));
  const gastosVenta = grupo('Gastos de venta', en(toma((f) => f.tipo === 'gasto' && f.codigo.startsWith('6.1')), 1));
  const gastosAdministracion = grupo('Gastos de administración', en(toma((f) => f.tipo === 'gasto' && f.codigo.startsWith('6.2')), 1));
  const difGasto = en(toma((f) => f.codigo === '6.3.02'), 1);
  const gastosFinancieros = grupo('Gastos financieros', en(toma((f) => f.tipo === 'gasto' && f.codigo.startsWith('6.3')), 1));
  const islr = grupo('ISLR del ejercicio', en(toma((f) => f.tipo === 'gasto' && f.codigo.startsWith('6.4')), 1));
  const otrosGastos = grupo('Otros gastos', en(toma((f) => f.tipo === 'gasto'), 1));                 // cuentas de gasto fuera de la estructura base

  const ventasNetas = resta(resta(ventasBrutas.total, devoluciones.total), descuentos.total);
  const utilidadBruta = resta(ventasNetas, costoVentas.total);
  const utilidadOperativa = resta(resta(resta(utilidadBruta, gastosVenta.total), gastosAdministracion.total), otrosGastos.total);
  // Diferencial cambiario: ganancia (4.2.01) menos pérdida (6.3.02), como partida separada.
  const dif = grupo('Resultado por diferencial cambiario', [...difIng, ...difGasto.map((l) => ({ ...l, valor: neg(l.valor) }))]);
  const otrosIngresos = grupo('Otros ingresos', otrosIng);
  const utilidadAntesIslr = resta(suma(suma(utilidadOperativa, dif.total), otrosIngresos.total), gastosFinancieros.total);
  const utilidadNeta = resta(utilidadAntesIslr, islr.total);
  const margenBrutoPct = ventasNetas.ves.isZero() ? null : utilidadBruta.ves.dividedBy(ventasNetas.ves).times(100).toFixed(2);
  return {
    ventasBrutas, devoluciones, descuentos, ventasNetas, costoVentas, utilidadBruta, margenBrutoPct, gastosVenta, gastosAdministracion, otrosGastos, utilidadOperativa,
    diferencialCambiario: dif, gastosFinancieros, otrosIngresos, utilidadAntesIslr, islr, utilidadNeta,
  };
}

// ---------------------------------------------------------------------
// Estado de cambios en el patrimonio
// ---------------------------------------------------------------------

export interface ColumnaPatrimonio { clave: string; titulo: string }
export const COLUMNAS_PATRIMONIO: ColumnaPatrimonio[] = [
  { clave: 'capital', titulo: 'Capital social' }, { clave: 'reservas', titulo: 'Reservas' }, { clave: 'acumuladas', titulo: 'Utilidades acumuladas y resultado cerrado' },
  { clave: 'apertura', titulo: 'Saldos de apertura' }, { clave: 'otras', titulo: 'Otras cuentas' }, { clave: 'ejercicio', titulo: 'Resultado del ejercicio en curso' },
];

const columnaDe = (codigo: string) => codigo.startsWith('3.1') ? 'capital' : codigo.startsWith('3.2') ? 'reservas' : codigo.startsWith('3.3') ? 'acumuladas' : codigo.startsWith('3.9') ? 'apertura' : 'otras';

export interface CambiosPatrimonio {
  columnas: ColumnaPatrimonio[];
  filas: { titulo: string; valores: Record<string, Par>; total: Par }[];
}

/**
 * `inicio` y `fin`: saldos acumulados al inicio del periodo y a su cierre (todas las cuentas). El resultado del periodo es la utilidad neta del estado
 * de resultados; los movimientos son lo que cambió en cuentas de patrimonio (aportes, reservas, traspasos del resultado cerrado).
 */
export function construirCambiosPatrimonio(inicio: FilaCuenta[], fin: FilaCuenta[], utilidadNetaPeriodo: Par): CambiosPatrimonio {
  const saldos = (filas: FilaCuenta[]): Record<string, Par> => {
    const out: Record<string, Par> = Object.fromEntries(COLUMNAS_PATRIMONIO.map((c) => [c.clave, cero()]));
    for (const f of filas.filter((x) => x.tipo === 'patrimonio')) out[columnaDe(f.codigo)] = suma(out[columnaDe(f.codigo)], neg(f.neto));
    const resultados = filas.filter((x) => x.tipo === 'ingreso' || x.tipo === 'costo' || x.tipo === 'gasto').reduce((s, f) => suma(s, f.neto), cero());
    out.ejercicio = neg(resultados);
    return out;
  };
  const a = saldos(inicio);
  const b = saldos(fin);
  const total = (v: Record<string, Par>) => Object.values(v).reduce((s, p) => suma(s, p), cero());
  const mov: Record<string, Par> = {};
  for (const c of COLUMNAS_PATRIMONIO) mov[c.clave] = resta(b[c.clave], a[c.clave]);
  // De lo que cambió el resultado del ejercicio en curso, la utilidad del periodo es el resultado; el resto (cierre del ejercicio) es un traspaso a utilidades acumuladas.
  const resultadoPeriodo: Record<string, Par> = Object.fromEntries(COLUMNAS_PATRIMONIO.map((c) => [c.clave, cero()]));
  resultadoPeriodo.ejercicio = utilidadNetaPeriodo;
  const movimientos: Record<string, Par> = {};
  for (const c of COLUMNAS_PATRIMONIO) movimientos[c.clave] = resta(mov[c.clave], resultadoPeriodo[c.clave]);
  return {
    columnas: COLUMNAS_PATRIMONIO,
    filas: [
      { titulo: 'Saldo al inicio del periodo', valores: a, total: total(a) },
      { titulo: 'Resultado del periodo', valores: resultadoPeriodo, total: total(resultadoPeriodo) },
      { titulo: 'Otros movimientos del periodo (aportes, traspasos, cierre del ejercicio)', valores: movimientos, total: total(movimientos) },
      { titulo: 'Saldo al cierre del periodo', valores: b, total: total(b) },
    ],
  };
}

// ---------------------------------------------------------------------
// Lectura del mayor
// ---------------------------------------------------------------------

function validarFecha(f: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw new ErrorMaestro('Indique una fecha válida.');
}

/** Saldos acumulados de todas las cuentas hasta `corte` (incluido), de los asientos contabilizados. */
export async function saldosAl(db: Db, corte: string): Promise<FilaCuenta[]> {
  validarFecha(corte);
  const { rows } = await db.query<{ codigo: string; nombre: string; tipo: FilaCuenta['tipo']; ves: string; usd: string }>(
    `select c.codigo, c.nombre, c.tipo, coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves, coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd
       from cuenta_contable c join asiento_linea l on l.cuenta_id = c.id join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' and a.fecha <= $1::date
      where c.imputable group by c.codigo, c.nombre, c.tipo order by string_to_array(c.codigo, '.')::int[]`, [corte]);
  return rows.map((r) => ({ codigo: r.codigo, nombre: r.nombre, tipo: r.tipo, neto: { ves: new Decimal(r.ves), usd: new Decimal(r.usd) } }));
}

/** Movimiento del periodo [desde, hasta] de las cuentas de resultados, sin los asientos de cierre del ejercicio. */
export async function movimientosDe(db: Db, desde: string, hasta: string): Promise<FilaCuenta[]> {
  validarFecha(desde); validarFecha(hasta);
  const { rows } = await db.query<{ codigo: string; nombre: string; tipo: FilaCuenta['tipo']; ves: string; usd: string }>(
    `select c.codigo, c.nombre, c.tipo, coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves, coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd
       from cuenta_contable c join asiento_linea l on l.cuenta_id = c.id
       join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' and a.fecha between $1::date and $2::date and a.tipo <> 'cierre'
      where c.imputable and c.tipo in ('ingreso', 'costo', 'gasto') group by c.codigo, c.nombre, c.tipo order by string_to_array(c.codigo, '.')::int[]`, [desde, hasta]);
  return rows.map((r) => ({ codigo: r.codigo, nombre: r.nombre, tipo: r.tipo, neto: { ves: new Decimal(r.ves), usd: new Decimal(r.usd) } }));
}

export function rangoDeMes(anio: number, mes: number): { desde: string; hasta: string; anterior: { anio: number; mes: number } } {
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) throw new ErrorMaestro('Indique un mes y un año válidos.');
  const p = (n: number) => String(n).padStart(2, '0');
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return { desde: `${anio}-${p(mes)}-01`, hasta: `${anio}-${p(mes)}-${p(ultimo)}`, anterior: mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 } };
}

export interface EstadosDelMes {
  anio: number; mes: number;
  situacion: { actual: Situacion; mesAnterior: Situacion; cierreAnioAnterior: Situacion };
  resultados: { periodo: Resultados; mesAnterior: Resultados; acumuladoAnio: Resultados };
  patrimonio: CambiosPatrimonio;
}

/** Todos los estados del mes con sus comparativos: el mes anterior y el cierre del año anterior (balance), el mes anterior y el acumulado del año (resultados). */
export async function estadosDelMes(db: Db, anio: number, mes: number): Promise<EstadosDelMes> {
  const m = rangoDeMes(anio, mes);
  const ant = rangoDeMes(m.anterior.anio, m.anterior.mes);
  const [alCierre, alAnterior, alAnioAnterior, alInicio] = await Promise.all([
    saldosAl(db, m.hasta), saldosAl(db, ant.hasta), saldosAl(db, `${anio - 1}-12-31`), saldosAl(db, ant.hasta),
  ]);
  const [periodo, mesAnterior, acumulado] = await Promise.all([
    movimientosDe(db, m.desde, m.hasta), movimientosDe(db, ant.desde, ant.hasta), movimientosDe(db, `${anio}-01-01`, m.hasta),
  ]);
  const rPeriodo = construirResultados(periodo);
  return {
    anio, mes,
    situacion: { actual: construirSituacion(alCierre), mesAnterior: construirSituacion(alAnterior), cierreAnioAnterior: construirSituacion(alAnioAnterior) },
    resultados: { periodo: rPeriodo, mesAnterior: construirResultados(mesAnterior), acumuladoAnio: construirResultados(acumulado) },
    patrimonio: construirCambiosPatrimonio(alInicio, alCierre, rPeriodo.utilidadNeta),
  };
}
