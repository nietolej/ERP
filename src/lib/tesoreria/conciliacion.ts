import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { dos } from '@/lib/dinero';

/**
 * Conciliación bancaria (spec §10.2; migración 0041).
 *
 *   extracto del mes (CSV o a mano) → el sistema propone pares por monto exacto, fecha dentro de la ventana y referencia → una persona los confirma
 *   → lo que queda del mayor sin pareja está «en tránsito» → Contabilidad o Gerencia (distinta de quien concilió) cierra el mes.
 *
 * El saldo conciliado debe coincidir con el mayor: mayor = saldo del banco + neto de lo que está en tránsito (R-CM).
 */

export const ROLES_CONCILIAN = ['tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_CIERRAN = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_CONCILIACION = ['tesoreria', 'gerencia', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

export type UsuarioConc = { id: string; roles: readonly string[] };
const tiene = (u: UsuarioConc, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));

const MONTO = /^-?\d{1,12}(\.\d{1,2})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function exigir(u: UsuarioConc, roles: readonly string[], texto: string) {
  if (!tiene(u, roles)) throw new ErrorMaestro(texto);
}

async function ventanaDias(db: Db): Promise<number> {
  const { rows } = await db.query<{ valor: string }>(`select valor::text from parametro_conciliacion where codigo = 'VENTANA_DIAS'`);
  if (!rows[0]) throw new ErrorMaestro('Falta configurar la ventana de días de la conciliación.');
  return Number(rows[0].valor);
}

/** Columna del mayor que corresponde a la moneda de la cuenta. */
const NETO = (moneda: string, alias = 'l') => (moneda === 'USD' ? `(${alias}.debe_usd - ${alias}.haber_usd)` : `(${alias}.debe_ves - ${alias}.haber_ves)`);

// ---------------------------------------------------------------------
// Extractos
// ---------------------------------------------------------------------

export interface DatosExtracto { cuentaId: string; anio: number; mes: number; saldoInicial: string; saldoFinal: string }

export async function crearExtracto(tx: Db, u: UsuarioConc, d: DatosExtracto): Promise<string> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) carga extractos bancarios.');
  if (!d.cuentaId) throw new ErrorMaestro('Seleccione la cuenta bancaria.');
  if (!Number.isInteger(d.anio) || d.anio < 2000 || d.anio > 2100 || !Number.isInteger(d.mes) || d.mes < 1 || d.mes > 12) throw new ErrorMaestro('Indique el mes y el año del extracto.');
  if (!MONTO.test(d.saldoInicial.trim()) || !MONTO.test(d.saldoFinal.trim())) throw new ErrorMaestro('Los saldos del banco deben ser números con hasta 2 decimales.');
  const { rows: previo } = await tx.query<{ anio: number; mes: number; saldo_final: string }>(
    `select anio, mes, saldo_final::text from extracto_bancario where cuenta_bancaria_id = $1 and estado = 'cerrado' and (anio, mes) < ($2, $3) order by anio desc, mes desc limit 1`,
    [d.cuentaId, d.anio, d.mes]);
  if (previo[0] && !dos(d.saldoInicial).equals(previo[0].saldo_final)) {
    throw new ErrorMaestro(`El saldo inicial debe ser el saldo final del último mes cerrado (${NOMBRE_MES[previo[0].mes - 1]} ${previo[0].anio}): ${previo[0].saldo_final}.`);
  }
  const { rows: abiertoAntes } = await tx.query(
    `select 1 from extracto_bancario where cuenta_bancaria_id = $1 and estado = 'abierto' and (anio, mes) < ($2, $3)`, [d.cuentaId, d.anio, d.mes]);
  if (abiertoAntes.length) throw new ErrorMaestro('Cierre primero los meses anteriores de esta cuenta.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into extracto_bancario (cuenta_bancaria_id, anio, mes, saldo_inicial, saldo_final, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [d.cuentaId, d.anio, d.mes, d.saldoInicial.trim(), d.saldoFinal.trim(), u.id]);
  return rows[0].id;
}

export async function actualizarSaldosExtracto(tx: Db, u: UsuarioConc, id: string, saldoInicial: string, saldoFinal: string): Promise<void> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) carga extractos bancarios.');
  if (!MONTO.test(saldoInicial.trim()) || !MONTO.test(saldoFinal.trim())) throw new ErrorMaestro('Los saldos del banco deben ser números con hasta 2 decimales.');
  const { rows } = await tx.query('update extracto_bancario set saldo_inicial = $2, saldo_final = $3 where id = $1 returning id', [id, saldoInicial.trim(), saldoFinal.trim()]);
  if (!rows[0]) throw new ErrorMaestro('El extracto no existe.');
}

// ---------------------------------------------------------------------
// Líneas del banco
// ---------------------------------------------------------------------

export interface LineaEntrada { fecha: string; descripcion: string; referencia?: string; monto: string }

export async function agregarLinea(tx: Db, u: UsuarioConc, extractoId: string, l: LineaEntrada): Promise<string> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) carga extractos bancarios.');
  if (!FECHA.test(l.fecha)) throw new ErrorMaestro('Indique la fecha del movimiento.');
  if (!l.descripcion.trim()) throw new ErrorMaestro('Indique la descripción del movimiento.');
  if (!MONTO.test(l.monto.trim()) || new Decimal(l.monto).isZero()) throw new ErrorMaestro('El monto debe ser distinto de cero, con hasta 2 decimales (ingreso positivo, egreso negativo).');
  const { rows } = await tx.query<{ id: string }>(
    `insert into extracto_linea (extracto_id, fecha, descripcion, referencia, monto, created_by) values ($1, $2::date, $3, nullif(trim($4), ''), $5, $6) returning id`,
    [extractoId, l.fecha, l.descripcion.trim().slice(0, 200), l.referencia ?? '', l.monto.trim(), u.id]);
  return rows[0].id;
}

export async function eliminarLinea(tx: Db, u: UsuarioConc, lineaId: string): Promise<void> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) carga extractos bancarios.');
  const { rows } = await tx.query('delete from extracto_linea where id = $1 returning id', [lineaId]);
  if (!rows[0]) throw new ErrorMaestro('La línea no existe.');
}

/** Un número del banco: «1.234,56», «1234,56» o «1234.56». Un punto con tres dígitos detrás y sin coma es ambiguo y se rechaza. */
export function leerNumeroBanco(texto: string): string {
  let t = texto.trim().replace(/\s/g, '');
  let signo = '';
  if (/^\(.*\)$/.test(t)) { signo = '-'; t = t.slice(1, -1); }
  if (t.startsWith('-')) { signo = signo ? '' : '-'; t = t.slice(1); }
  if (t.startsWith('+')) t = t.slice(1);
  if (t.includes(',') && t.includes('.')) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    if ((t.match(/,/g) ?? []).length > 1 || /,\d{3}$/.test(t)) throw new ErrorMaestro(`El número «${texto}» es ambiguo: escríbalo con dos decimales.`);
    t = t.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    throw new ErrorMaestro(`El número «${texto}» es ambiguo: escríbalo con dos decimales.`);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new ErrorMaestro(`El número «${texto}» no es un monto válido.`);
  return signo + t;
}

function leerFecha(texto: string): string {
  const t = texto.trim();
  let iso: string | null = null;
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const b = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(t);
  if (a) iso = t;
  else if (b) iso = `${b[3]}-${b[2]}-${b[1]}`;
  const d = iso ? new Date(`${iso}T00:00:00Z`) : null;
  if (!iso || !d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new ErrorMaestro(`La fecha «${texto}» no es válida: use dd-mm-aaaa.`);
  return iso;
}

/** Divide una línea CSV respetando comillas. */
function celdas(linea: string, sep: string): string[] {
  const r: string[] = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') { if (comillas && linea[i + 1] === '"') { actual += '"'; i++; } else comillas = !comillas; }
    else if (c === sep && !comillas) { r.push(actual); actual = ''; }
    else actual += c;
  }
  r.push(actual);
  return r.map((x) => x.trim());
}

const normaliza = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Lee el CSV del banco. Primera fila con encabezados: fecha, descripción, referencia (opcional) y el monto, ya sea en una columna
 * «monto» (ingreso +, egreso −) o en dos «ingreso/crédito» y «egreso/débito». Todo o nada: la primera fila mala cancela la carga.
 */
export function leerCsvBanco(contenido: string): LineaEntrada[] {
  const filas = contenido.replace(/^﻿/, '').split(/\r?\n/).filter((f) => f.trim());
  if (filas.length < 2) throw new ErrorMaestro('El archivo no trae movimientos.');
  const sep = [';', '\t', ','].reduce((mejor, s) => (filas[0].split(s).length > filas[0].split(mejor).length ? s : mejor), ';');
  const enc = celdas(filas[0], sep).map(normaliza);
  const idx = (...nombres: string[]) => enc.findIndex((e) => nombres.includes(e));
  const iFecha = idx('fecha');
  const iDesc = idx('descripcion', 'concepto', 'detalle');
  const iRef = idx('referencia', 'ref', 'nro. referencia', 'numero de referencia');
  const iMonto = idx('monto', 'importe');
  const iIng = idx('ingreso', 'ingresos', 'credito', 'abono', 'haber');
  const iEgr = idx('egreso', 'egresos', 'debito', 'cargo', 'debe');
  if (iFecha < 0 || iDesc < 0 || (iMonto < 0 && (iIng < 0 || iEgr < 0))) {
    throw new ErrorMaestro('El archivo necesita las columnas: fecha, descripción y monto (o ingreso y egreso). Referencia es opcional.');
  }
  return filas.slice(1).map((f, n) => {
    const c = celdas(f, sep);
    try {
      let monto: string;
      if (iMonto >= 0) monto = leerNumeroBanco(c[iMonto] ?? '');
      else {
        const ing = (c[iIng] ?? '').trim() ? leerNumeroBanco(c[iIng]) : '0';
        const egr = (c[iEgr] ?? '').trim() ? leerNumeroBanco(c[iEgr]) : '0';
        monto = new Decimal(ing).abs().minus(new Decimal(egr).abs()).toFixed(2);
      }
      if (new Decimal(monto).isZero()) throw new ErrorMaestro('El monto es cero.');
      return { fecha: leerFecha(c[iFecha] ?? ''), descripcion: c[iDesc] ?? '', referencia: iRef >= 0 ? c[iRef] : undefined, monto };
    } catch (e) {
      throw new ErrorMaestro(`Fila ${n + 2}: ${(e as Error).message}`);
    }
  });
}

/** Carga el CSV completo en el extracto (todo o nada). */
export async function importarCsv(tx: Db, u: UsuarioConc, extractoId: string, contenido: string): Promise<number> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) carga extractos bancarios.');
  const lineas = leerCsvBanco(contenido);
  for (const [n, l] of lineas.entries()) {
    try { await agregarLinea(tx, u, extractoId, l); } catch (e) { throw new ErrorMaestro(`Fila ${n + 2}: ${(e as Error).message}`); }
  }
  return lineas.length;
}

// ---------------------------------------------------------------------
// Emparejamiento
// ---------------------------------------------------------------------

export interface Candidato {
  asiento_linea_id: string; fecha: string; asiento: string; descripcion: string; neto: string; dias: number; referencia: string | null; origen: string | null;
  referencia_coincide: boolean; mismo_monto: boolean;
}

interface ExtractoBase { id: string; cuenta_contable_id: string; moneda: string; estado: string; fin: string }

async function extractoBase(db: Db, id: string): Promise<ExtractoBase> {
  const { rows } = await db.query<ExtractoBase>(
    `select e.id, cb.cuenta_contable_id, cb.moneda, e.estado,
            (make_date(e.anio, e.mes, 1) + interval '1 month' - interval '1 day')::date::text as fin
       from extracto_bancario e join cuenta_bancaria cb on cb.id = e.cuenta_bancaria_id where e.id = $1`, [id]);
  if (!rows[0]) throw new ErrorMaestro('El extracto no existe.');
  return rows[0];
}

const norm = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Líneas del mayor de la cuenta que siguen sin pareja, hasta el fin del mes del extracto, con la referencia de su cobro o pago. */
async function pendientesDelMayor(db: Db, e: ExtractoBase, excluir: string[] = []): Promise<(Omit<Candidato, 'dias' | 'referencia_coincide' | 'mismo_monto'>)[]> {
  const { rows } = await db.query<Omit<Candidato, 'dias' | 'referencia_coincide' | 'mismo_monto'>>(
    `select l.id::text as asiento_linea_id, a.fecha::text, a.numero::text as asiento, coalesce(l.glosa, a.descripcion) as descripcion, ${NETO(e.moneda)}::text as neto,
            coalesce(c.referencia, p.referencia) as referencia, a.origen_tipo as origen
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
       left join cobro c on a.origen_tipo = 'cobro' and c.id = a.origen_id
       left join pago p on a.origen_tipo = 'pago_proveedor' and p.id = a.origen_id
      where l.cuenta_id = $1 and a.fecha <= $2::date and not exists (select 1 from extracto_linea x where x.asiento_linea_id = l.id)
        and not (l.id::text = any($3::text[]))
      order by a.fecha, l.id`, [e.cuenta_contable_id, e.fin, excluir]);
  return rows;
}

export interface Propuesta { linea_id: string; candidatos: Candidato[]; unica: boolean }

/**
 * Propone pares: mismo monto exacto y fecha dentro de la ventana. La referencia igual pone primero al candidato. Es solo una propuesta:
 * ningún par se guarda hasta que una persona lo confirma. Si dos líneas del banco compiten por el mismo asiento, se marcan no únicas.
 */
export async function proponer(db: Db, extractoId: string): Promise<Propuesta[]> {
  const e = await extractoBase(db, extractoId);
  const ventana = await ventanaDias(db);
  const { rows: lineas } = await db.query<{ id: string; fecha: string; monto: string; referencia: string | null }>(
    `select id, fecha::text, monto::text, referencia from extracto_linea where extracto_id = $1 and asiento_linea_id is null order by fecha, id`, [extractoId]);
  const mayor = await pendientesDelMayor(db, e);
  const ms = (f: string) => Date.parse(`${f}T00:00:00Z`);
  const propuestas: Propuesta[] = lineas.map((l) => {
    const candidatos = mayor
      .filter((m) => new Decimal(m.neto).equals(l.monto))
      .map<Candidato>((m) => ({ ...m, dias: Math.round(Math.abs(ms(m.fecha) - ms(l.fecha)) / 86400000), referencia_coincide: !!norm(l.referencia) && norm(l.referencia) === norm(m.referencia), mismo_monto: true }))
      .filter((c) => c.dias <= ventana)
      .sort((a, b) => Number(b.referencia_coincide) - Number(a.referencia_coincide) || a.dias - b.dias);
    return { linea_id: l.id, candidatos, unica: false };
  });
  const usos = new Map<string, number>();
  for (const p of propuestas) if (p.candidatos[0]) usos.set(p.candidatos[0].asiento_linea_id, (usos.get(p.candidatos[0].asiento_linea_id) ?? 0) + 1);
  for (const p of propuestas) {
    const mejor = p.candidatos[0];
    const empate = p.candidatos.length > 1 && !mejor?.referencia_coincide && p.candidatos[1].dias === mejor.dias && !p.candidatos[1].referencia_coincide;
    p.unica = !!mejor && usos.get(mejor.asiento_linea_id) === 1 && !empate;
  }
  return propuestas;
}

/** Candidatos para emparejar a mano una línea: del mismo monto primero, luego el resto de lo pendiente (la base exige el mismo monto). */
export async function candidatosDe(db: Db, lineaId: string): Promise<Candidato[]> {
  const { rows } = await db.query<{ extracto_id: string; fecha: string; monto: string; referencia: string | null }>(
    'select extracto_id, fecha::text, monto::text, referencia from extracto_linea where id = $1', [lineaId]);
  if (!rows[0]) throw new ErrorMaestro('La línea no existe.');
  const e = await extractoBase(db, rows[0].extracto_id);
  const ms = (f: string) => Date.parse(`${f}T00:00:00Z`);
  return (await pendientesDelMayor(db, e))
    .map<Candidato>((m) => ({ ...m, dias: Math.round(Math.abs(ms(m.fecha) - ms(rows[0].fecha)) / 86400000), referencia_coincide: !!norm(rows[0].referencia) && norm(rows[0].referencia) === norm(m.referencia), mismo_monto: new Decimal(m.neto).equals(rows[0].monto) }))
    .sort((a, b) => Number(b.mismo_monto) - Number(a.mismo_monto) || a.dias - b.dias)
    .slice(0, 60);
}

export async function conciliar(tx: Db, u: UsuarioConc, lineaId: string, asientoLineaId: string): Promise<void> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) concilia.');
  const { rows } = await tx.query<{ id: string }>(
    `update extracto_linea set asiento_linea_id = $2::bigint, conciliado_por = $3 where id = $1 and asiento_linea_id is null returning id`, [lineaId, asientoLineaId, u.id]);
  if (!rows[0]) throw new ErrorMaestro('La línea no existe o ya está conciliada.');
}

/** Confirma varios pares de una vez (los que la persona revisó). */
export async function conciliarPares(tx: Db, u: UsuarioConc, pares: { lineaId: string; asientoLineaId: string }[]): Promise<number> {
  for (const p of pares) await conciliar(tx, u, p.lineaId, p.asientoLineaId);
  return pares.length;
}

export async function desconciliar(tx: Db, u: UsuarioConc, lineaId: string): Promise<void> {
  exigir(u, ROLES_CONCILIAN, 'Solo Tesorería (o Gerencia) concilia.');
  const { rows } = await tx.query(
    `update extracto_linea set asiento_linea_id = null, conciliado_por = null, conciliado_at = null where id = $1 and asiento_linea_id is not null returning id`, [lineaId]);
  if (!rows[0]) throw new ErrorMaestro('La línea no existe o no está conciliada.');
}

// ---------------------------------------------------------------------
// Resumen y cierre
// ---------------------------------------------------------------------

export interface ResumenConciliacion {
  moneda: string; saldo_inicial: string; saldo_final: string; movimientos: string; pendientes: number; conciliadas: number;
  banco_cuadra: boolean; mayor: string; transito: string; diferencia: string; cuadra: boolean; puede_cerrar: boolean;
}

export async function resumen(db: Db, extractoId: string): Promise<ResumenConciliacion> {
  const e = await extractoBase(db, extractoId);
  const { rows: x } = await db.query<{ saldo_inicial: string; saldo_final: string; movs: string; pend: number; conc: number }>(
    `select e.saldo_inicial::text, e.saldo_final::text, coalesce((select sum(monto) from extracto_linea where extracto_id = e.id), 0)::text as movs,
            (select count(*)::int from extracto_linea where extracto_id = e.id and asiento_linea_id is null) as pend,
            (select count(*)::int from extracto_linea where extracto_id = e.id and asiento_linea_id is not null) as conc
       from extracto_bancario e where e.id = $1`, [extractoId]);
  const { rows: m } = await db.query<{ mayor: string; transito: string }>(
    `select coalesce(sum(${NETO(e.moneda)}), 0)::text as mayor,
            coalesce(sum(${NETO(e.moneda)}) filter (where not exists (select 1 from extracto_linea z where z.asiento_linea_id = l.id)), 0)::text as transito
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' where l.cuenta_id = $1 and a.fecha <= $2::date`, [e.cuenta_contable_id, e.fin]);
  const r = x[0];
  const bancoCuadra = new Decimal(r.saldo_inicial).plus(r.movs).equals(r.saldo_final);
  const dif = new Decimal(m[0].mayor).minus(new Decimal(r.saldo_final).plus(m[0].transito));
  return {
    moneda: e.moneda, saldo_inicial: r.saldo_inicial, saldo_final: r.saldo_final, movimientos: r.movs, pendientes: r.pend, conciliadas: r.conc,
    banco_cuadra: bancoCuadra, mayor: m[0].mayor, transito: m[0].transito, diferencia: dif.toFixed(2), cuadra: dif.isZero(),
    puede_cerrar: e.estado === 'abierto' && r.pend === 0 && bancoCuadra && dif.isZero(),
  };
}

/** Cierra el mes: guarda las cifras y marca como conciliados los cobros cuyos asientos se emparejaron. */
export async function cerrarExtracto(tx: Db, u: UsuarioConc, extractoId: string): Promise<void> {
  exigir(u, ROLES_CIERRAN, 'Solo Contabilidad o Gerencia cierran la conciliación.');
  const r = await resumen(tx, extractoId);
  if (r.pendientes > 0) throw new ErrorMaestro(`Quedan ${r.pendientes} líneas del banco sin conciliar.`);
  if (!r.banco_cuadra) throw new ErrorMaestro('El saldo inicial más los movimientos no da el saldo final del banco: revise las líneas cargadas.');
  if (!r.cuadra) throw new ErrorMaestro(`El saldo conciliado no coincide con el mayor (diferencia ${r.moneda} ${r.diferencia}).`);
  await tx.query(
    `update extracto_bancario set estado = 'cerrado', cerrado_por = $2, cierre_mayor = $3, cierre_transito = $4 where id = $1`, [extractoId, u.id, r.mayor, r.transito]);
  await tx.query(
    `update cobro set estado = 'conciliado'
      where estado = 'registrado' and id in (select a.origen_id from extracto_linea x join asiento_linea l on l.id = x.asiento_linea_id
                                              join asiento a on a.id = l.asiento_id where x.extracto_id = $1 and a.origen_tipo = 'cobro')`, [extractoId]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaExtracto {
  id: string; cuenta: string; moneda: string; anio: number; mes: number; estado: string; saldo_final: string; lineas: number; pendientes: number;
}

export async function listarExtractos(db: Db): Promise<FilaExtracto[]> {
  const { rows } = await db.query<FilaExtracto>(
    `select e.id, cb.codigo || ' · ' || cb.nombre as cuenta, cb.moneda, e.anio, e.mes, e.estado, e.saldo_final::text,
            (select count(*)::int from extracto_linea z where z.extracto_id = e.id) as lineas,
            (select count(*)::int from extracto_linea z where z.extracto_id = e.id and z.asiento_linea_id is null) as pendientes
       from extracto_bancario e join cuenta_bancaria cb on cb.id = e.cuenta_bancaria_id order by e.anio desc, e.mes desc, cb.codigo`);
  return rows;
}

export interface DetalleExtracto { id: string; cuenta_id: string; cuenta: string; moneda: string; anio: number; mes: number; estado: string; creador: string; cerrado_por: string | null }

export async function detalleExtracto(db: Db, id: string): Promise<DetalleExtracto | null> {
  const { rows } = await db.query<DetalleExtracto>(
    `select e.id, e.cuenta_bancaria_id as cuenta_id, cb.codigo || ' · ' || cb.nombre as cuenta, cb.moneda, e.anio, e.mes, e.estado, cr.nombre as creador, ce.nombre as cerrado_por
       from extracto_bancario e join cuenta_bancaria cb on cb.id = e.cuenta_bancaria_id join usuario cr on cr.id = e.created_by left join usuario ce on ce.id = e.cerrado_por
      where e.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface LineaBanco {
  id: string; fecha: string; descripcion: string; referencia: string | null; monto: string; asiento: string | null; conciliador: string | null;
}

export async function lineasDeExtracto(db: Db, extractoId: string): Promise<LineaBanco[]> {
  const { rows } = await db.query<LineaBanco>(
    `select x.id, to_char(x.fecha, 'DD-MM-YYYY') as fecha, x.descripcion, x.referencia, x.monto::text, a.numero::text as asiento, u.nombre as conciliador
       from extracto_linea x left join asiento_linea l on l.id = x.asiento_linea_id left join asiento a on a.id = l.asiento_id left join usuario u on u.id = x.conciliado_por
      where x.extracto_id = $1 order by x.fecha, x.created_at, x.id`, [extractoId]);
  return rows;
}

/** Lo del mayor que sigue sin pareja hasta el fin del mes del extracto (partidas en tránsito). */
export async function enTransito(db: Db, extractoId: string): Promise<Omit<Candidato, 'dias' | 'referencia_coincide' | 'mismo_monto'>[]> {
  return pendientesDelMayor(db, await extractoBase(db, extractoId));
}

export async function cuentasConciliables(db: Db): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(
    `select id, codigo || ' · ' || nombre || ' · ' || moneda as texto from cuenta_bancaria where activa and tipo <> 'caja' and moneda in ('VES', 'USD') order by codigo`);
  return rows;
}
