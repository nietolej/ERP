import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { libroCompras, libroVentas, validarPeriodo } from './libros';

/**
 * Declaraciones fiscales y cierre fiscal (spec §11.4; migración 0047).
 *
 *   IVA mensual: débito fiscal (libro de ventas) − crédito fiscal (libro de compras) − excedente del mes anterior; si el crédito supera al
 *     débito, el excedente se traslada al mes siguiente. Las retenciones de IVA que practican los clientes aún no existen y no restan.
 *   Retenciones de IVA: por quincena si la empresa es contribuyente especial, si no por mes. CSV con las columnas del comprobante.
 *   Retenciones de ISLR: por mes, en XML.
 * Al declarar se guarda la foto de las cifras (y el archivo tal como se declaró) y la base bloquea los documentos fechados en el periodo (R-DF).
 * Los formatos de archivo son borradores que el contador valida antes de subirlos al portal.
 */

export const ROLES_DECLARAN = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export type TipoDeclaracion = 'iva' | 'retenciones_iva' | 'retenciones_islr';
export const NOMBRE_DECLARACION: Record<TipoDeclaracion, string> = { iva: 'Declaración de IVA', retenciones_iva: 'Retenciones de IVA', retenciones_islr: 'Retenciones de ISLR' };

export type UsuarioDecl = { id: string; roles: readonly string[] };
const dec = (v: Decimal.Value) => new Decimal(v);
const dos = (v: Decimal.Value) => dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const pad = (n: number) => String(n).padStart(2, '0');

export interface Periodo { anio: number; mes: number; quincena: 1 | 2 | null; desde: string; hasta: string }

export function periodoDe(anio: number, mes: number, quincena: number | null = null): Periodo {
  validarPeriodo(anio, mes);
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const base = `${anio}-${pad(mes)}`;
  if (quincena === 1) return { anio, mes, quincena: 1, desde: `${base}-01`, hasta: `${base}-15` };
  if (quincena === 2) return { anio, mes, quincena: 2, desde: `${base}-16`, hasta: `${base}-${pad(ultimo)}` };
  return { anio, mes, quincena: null, desde: `${base}-01`, hasta: `${base}-${pad(ultimo)}` };
}

/** ¿Las retenciones de IVA se declaran por quincena? Sí si la empresa es contribuyente especial (§11.0). */
export async function declaraPorQuincena(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ q: boolean }>('select coalesce((select contribuyente_especial from empresa limit 1), false) as q');
  return rows[0].q;
}

// ---------------------------------------------------------------------
// Archivos (puros, con prueba)
// ---------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const csv = (c: string) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
const sinGuiones = (rif: string) => rif.replace(/-/g, '');
const ddmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export interface RetencionIslrArchivo { rif: string; factura: string; control: string; fecha: string; concepto: string; base_ves: string; porcentaje: string }

/** XML de retenciones de ISLR (estructura del portal; el contador valida el formato y los códigos de concepto antes de subirlo). */
export function xmlRetencionesIslr(agenteRif: string, anio: number, mes: number, filas: RetencionIslrArchivo[]): string {
  const detalle = filas.map((f) => [
    '  <DetalleRetencion>',
    `    <RifRetenido>${xml(sinGuiones(f.rif))}</RifRetenido>`,
    `    <NumeroFactura>${xml(f.factura)}</NumeroFactura>`,
    `    <NumeroControl>${xml(f.control)}</NumeroControl>`,
    `    <FechaOperacion>${ddmmaaaa(f.fecha)}</FechaOperacion>`,
    `    <CodigoConcepto>${xml(f.concepto)}</CodigoConcepto>`,
    `    <MontoOperacion>${dos(f.base_ves)}</MontoOperacion>`,
    `    <PorcentajeRetencion>${dec(f.porcentaje).toString()}</PorcentajeRetencion>`,
    '  </DetalleRetencion>',
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<RelacionRetencionesISLR RifAgente="${xml(sinGuiones(agenteRif))}" Periodo="${anio}${pad(mes)}">\n${detalle}${detalle ? '\n' : ''}</RelacionRetencionesISLR>\n`;
}

export interface RetencionIvaArchivo {
  comprobante: string; fecha: string; factura: string; control: string; rif: string; razon: string; iva_ves: string; porcentaje: string; retenido_ves: string;
}

/** CSV de retenciones de IVA con las columnas del comprobante (separador «;»). */
export function csvRetencionesIva(filas: RetencionIvaArchivo[]): string {
  const enc = ['Comprobante', 'Fecha de la operación', 'Factura', 'N° de control', 'RIF retenido', 'Razón social', 'IVA de la factura (Bs.)', 'Porcentaje', 'IVA retenido (Bs.)'];
  const cuerpo = filas.map((f) => [f.comprobante, ddmmaaaa(f.fecha), f.factura, f.control, f.rif, f.razon, dos(f.iva_ves), dec(f.porcentaje).toString(), dos(f.retenido_ves)].map(csv).join(';'));
  return `﻿${[enc.join(';'), ...cuerpo].join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------
// Cifras y archivos de cada declaración
// ---------------------------------------------------------------------

export interface CifrasIva {
  baseVentas: string; debito: string; baseCompras: string; credito: string; excedenteAnterior: string; retencionesSoportadas: string;
  resultado: string; cuotaPagar: string; excedenteSiguiente: string;
}

async function declaracionVigente(db: Db, tipo: TipoDeclaracion, anio: number, mes: number, quincena: number | null) {
  const { rows } = await db.query<{ id: string; excedente_siguiente: string | null }>(
    `select id, excedente_siguiente::text from declaracion_fiscal where tipo = $1 and anio = $2 and mes = $3 and coalesce(quincena, 0) = $4 and reabierta_at is null`,
    [tipo, anio, mes, quincena ?? 0]);
  return rows[0] ?? null;
}

/** Excedente de crédito fiscal que trae el mes: el de la declaración vigente del mes anterior. Exige que ese mes esté declarado si hay declaraciones previas. */
async function excedenteAnterior(db: Db, anio: number, mes: number): Promise<string> {
  const ant = mes === 1 ? { a: anio - 1, m: 12 } : { a: anio, m: mes - 1 };
  const d = await declaracionVigente(db, 'iva', ant.a, ant.m, null);
  if (d) return dec(d.excedente_siguiente ?? 0).toFixed(2);
  const { rows } = await db.query('select 1 from declaracion_fiscal where tipo = \'iva\' and (anio, mes) < ($1, $2) limit 1', [anio, mes]);
  if (rows.length) throw new ErrorMaestro(`Declare primero el IVA de ${pad(ant.m)}-${ant.a}: el excedente de crédito fiscal se traslada de un mes al siguiente.`);
  return '0.00';
}

export async function cifrasIva(db: Db, anio: number, mes: number): Promise<CifrasIva> {
  const [v, c, ex] = await Promise.all([libroVentas(db, anio, mes), libroCompras(db, anio, mes), excedenteAnterior(db, anio, mes)]);
  const resultado = dec(v.debito).minus(c.credito).minus(ex);
  return {
    baseVentas: v.base, debito: v.debito, baseCompras: c.base, credito: c.credito, excedenteAnterior: ex, retencionesSoportadas: '0.00',
    resultado: resultado.toFixed(2),
    cuotaPagar: resultado.isPositive() ? resultado.toFixed(2) : '0.00',
    excedenteSiguiente: resultado.isNegative() ? resultado.abs().toFixed(2) : '0.00',
  };
}

export interface CifrasRetenciones { comprobantes: number; baseVes: string; retenidoVes: string; pendientes: number; ajustesPorNotas: string }

interface FilaRetIva extends RetencionIvaArchivo { base_ves: string }

async function filasRetencionIva(db: Db, p: Periodo): Promise<FilaRetIva[]> {
  const { rows } = await db.query<FilaRetIva>(
    `select c.numero as comprobante, r.fecha::text, coalesce(f.numero_factura, g.numero_factura, gp.numero_factura) as factura,
            coalesce(f.numero_control, g.numero_control, gp.numero_control) as control, t.rif, t.razon_social as razon,
            round(r.base * r.tasa, 2)::text as iva_ves, r.porcentaje::text, round(r.monto * r.tasa, 2)::text as retenido_ves, round(r.base * r.tasa, 2)::text as base_ves
       from retencion_compra r join comprobante_retencion c on c.retencion_id = r.id join tercero t on t.id = r.proveedor_id
       left join factura_compra f on f.id = r.factura_id left join gasto_importacion g on g.id = r.gasto_id left join gasto_proveedor gp on gp.id = r.gasto_proveedor_id
      where r.impuesto = 'iva' and r.fecha between $1::date and $2::date order by c.numero`, [p.desde, p.hasta]);
  return rows;
}

async function pendientesDe(db: Db, impuesto: 'iva' | 'islr', p: Periodo): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from retencion_compra r where r.impuesto = $1 and r.nota_id is null and r.signo = 1 and r.fecha between $2::date and $3::date
        and not exists (select 1 from comprobante_retencion c where c.retencion_id = r.id)`, [impuesto, p.desde, p.hasta]);
  return rows[0].n;
}

async function ajustesNotas(db: Db, impuesto: 'iva' | 'islr', p: Periodo): Promise<string> {
  const { rows } = await db.query<{ s: string }>(
    `select coalesce(sum(round(r.monto * r.tasa, 2) * r.signo), 0)::text as s from retencion_compra r where r.impuesto = $1 and r.nota_id is not null and r.fecha between $2::date and $3::date`, [impuesto, p.desde, p.hasta]);
  return dec(rows[0].s).toFixed(2);
}

export interface PrevisionDeclaracion {
  tipo: TipoDeclaracion; periodo: Periodo; cifras: CifrasIva | CifrasRetenciones; archivo: string | null; archivoNombre: string | null;
  /** Lo que impide declarar todavía (vacío si se puede). */
  impedimentos: string[]; declarada: boolean;
}

async function agenteRif(db: Db): Promise<string> {
  const { rows } = await db.query<{ rif: string }>('select rif from empresa limit 1');
  if (!rows[0]) throw new ErrorMaestro('Falta registrar los datos de la empresa (RIF del agente de retención).');
  return rows[0].rif;
}

/** Calcula la declaración sin guardar nada: cifras, archivo y lo que impediría declararla. */
export async function previsualizar(db: Db, tipo: TipoDeclaracion, anio: number, mes: number, quincenaPedida: number | null = null): Promise<PrevisionDeclaracion> {
  const porQuincena = tipo === 'retenciones_iva' && (await declaraPorQuincena(db));
  const quincena = porQuincena ? (quincenaPedida === 2 ? 2 : 1) : null;
  const p = periodoDe(anio, mes, quincena);
  const impedimentos: string[] = [];
  const hoy = (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;
  if (p.hasta >= hoy) impedimentos.push('El periodo todavía no ha terminado.');
  const declarada = (await declaracionVigente(db, tipo, anio, mes, quincena)) !== null;
  if (declarada) impedimentos.push('Ese periodo ya está declarado; Gerencia puede reabrirlo.');

  if (tipo === 'iva') {
    const { rows: despues } = await db.query(`select 1 from declaracion_fiscal where tipo = 'iva' and reabierta_at is null and (anio, mes) > ($1, $2) limit 1`, [anio, mes]);
    if (despues.length) impedimentos.push('Ya hay un IVA declarado de un mes posterior: reabra ese primero, porque su excedente de crédito fiscal depende de este mes.');
    let cifras: CifrasIva;
    try {
      cifras = await cifrasIva(db, anio, mes);
    } catch (e) {
      if (!(e instanceof ErrorMaestro)) throw e;
      impedimentos.push(e.message);
      cifras = { baseVentas: '0.00', debito: '0.00', baseCompras: '0.00', credito: '0.00', excedenteAnterior: '0.00', retencionesSoportadas: '0.00', resultado: '0.00', cuotaPagar: '0.00', excedenteSiguiente: '0.00' };
    }
    return { tipo, periodo: p, cifras, archivo: null, archivoNombre: null, impedimentos, declarada };
  }

  const impuesto = tipo === 'retenciones_iva' ? 'iva' : 'islr';
  const pend = await pendientesDe(db, impuesto, p);
  if (pend > 0) impedimentos.push(`Hay ${pend} retenciones sin comprobante: emítalos primero en Fiscal → Comprobantes.`);
  const ajustes = await ajustesNotas(db, impuesto, p);
  if (tipo === 'retenciones_iva') {
    const filas = await filasRetencionIva(db, p);
    const cifras: CifrasRetenciones = {
      comprobantes: filas.length, baseVes: dos(filas.reduce((s, f) => s.plus(f.base_ves), dec(0))), retenidoVes: dos(filas.reduce((s, f) => s.plus(f.retenido_ves), dec(0))), pendientes: pend, ajustesPorNotas: ajustes,
    };
    const sufijo = p.quincena ? `-Q${p.quincena}` : '';
    return { tipo, periodo: p, cifras, archivo: csvRetencionesIva(filas), archivoNombre: `retenciones-iva-${anio}${pad(mes)}${sufijo}.csv`, impedimentos, declarada };
  }
  const { rows } = await db.query<RetencionIslrArchivo>(
    `select t.rif, coalesce(f.numero_factura, g.numero_factura, gp.numero_factura) as factura, coalesce(f.numero_control, g.numero_control, gp.numero_control) as control,
            r.fecha::text, ct.codigo as concepto, round(r.base * r.tasa, 2)::text as base_ves, r.porcentaje::text
       from retencion_compra r join comprobante_retencion c on c.retencion_id = r.id join tercero t on t.id = r.proveedor_id
       join concepto_islr_tarifa tf on tf.id = r.tarifa_id join concepto_islr ct on ct.id = tf.concepto_id
       left join factura_compra f on f.id = r.factura_id left join gasto_importacion g on g.id = r.gasto_id left join gasto_proveedor gp on gp.id = r.gasto_proveedor_id
      where r.impuesto = 'islr' and r.fecha between $1::date and $2::date order by c.numero`, [p.desde, p.hasta]);
  const retenido = await db.query<{ s: string }>(
    `select coalesce(sum(round(r.monto * r.tasa, 2)), 0)::text as s from retencion_compra r join comprobante_retencion c on c.retencion_id = r.id where r.impuesto = 'islr' and r.fecha between $1::date and $2::date`, [p.desde, p.hasta]);
  const cifras: CifrasRetenciones = {
    comprobantes: rows.length, baseVes: dos(rows.reduce((s, f) => s.plus(f.base_ves), dec(0))), retenidoVes: dos(retenido.rows[0].s), pendientes: pend, ajustesPorNotas: ajustes,
  };
  return { tipo, periodo: p, cifras, archivo: xmlRetencionesIslr(await agenteRif(db), anio, mes, rows), archivoNombre: `retenciones-islr-${anio}${pad(mes)}.xml`, impedimentos, declarada };
}

// ---------------------------------------------------------------------
// Declarar, reabrir y consultar
// ---------------------------------------------------------------------

/** Declara el periodo: guarda las cifras y el archivo y, con ello, cierra fiscalmente el periodo (la base bloquea los documentos de ese mes). */
export async function declarar(tx: Db, u: UsuarioDecl, d: { tipo: TipoDeclaracion; anio: number; mes: number; quincena?: number | null }): Promise<string> {
  if (!u.roles.some((r) => (ROLES_DECLARAN as readonly string[]).includes(r))) throw new ErrorMaestro('Solo Contabilidad o Gerencia declaran.');
  if (!['iva', 'retenciones_iva', 'retenciones_islr'].includes(d.tipo)) throw new ErrorMaestro('Seleccione la declaración.');
  const prev = await previsualizar(tx, d.tipo, d.anio, d.mes, d.quincena ?? null);
  if (prev.impedimentos.length) throw new ErrorMaestro(prev.impedimentos[0]);
  const excedente = d.tipo === 'iva' ? (prev.cifras as CifrasIva).excedenteSiguiente : null;
  const { rows } = await tx.query<{ id: string }>(
    `insert into declaracion_fiscal (tipo, anio, mes, quincena, desde, hasta, cifras, excedente_siguiente, archivo, archivo_nombre, declarada_por)
     values ($1, $2, $3, $4, $5::date, $6::date, $7::jsonb, $8, $9, $10, $11) returning id`,
    [d.tipo, d.anio, d.mes, prev.periodo.quincena, prev.periodo.desde, prev.periodo.hasta, JSON.stringify(prev.cifras), excedente, prev.archivo, prev.archivoNombre, u.id]);
  return rows[0].id;
}

/** Reabre el periodo: solo Gerencia, con motivo. La declaración original se conserva y se puede declarar de nuevo. */
export async function reabrir(tx: Db, u: UsuarioDecl, id: string, motivo: string): Promise<void> {
  if (!u.roles.includes('gerencia')) throw new ErrorMaestro('Solo Gerencia reabre un periodo declarado.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la reapertura.');
  // Un IVA no se reabre si el mes siguiente ya se declaró con su excedente.
  const { rows: d } = await tx.query<{ tipo: string; anio: number; mes: number }>('select tipo, anio, mes from declaracion_fiscal where id = $1', [id]);
  if (!d[0]) throw new ErrorMaestro('La declaración no existe.');
  if (d[0].tipo === 'iva') {
    const { rows } = await tx.query(`select 1 from declaracion_fiscal where tipo = 'iva' and reabierta_at is null and (anio, mes) > ($1, $2) limit 1`, [d[0].anio, d[0].mes]);
    if (rows.length) throw new ErrorMaestro('Reabra primero los meses de IVA posteriores: su excedente de crédito fiscal depende de este mes.');
  }
  const { rows } = await tx.query('update declaracion_fiscal set reabierta_motivo = $2, reabierta_por = $3 where id = $1 and reabierta_at is null returning id', [id, motivo.trim(), u.id]);
  if (!rows[0]) throw new ErrorMaestro('La declaración ya fue reabierta.');
}

export interface FilaDeclaracion {
  id: string; tipo: TipoDeclaracion; anio: number; mes: number; quincena: number | null; desde: string; hasta: string; declarada_por: string; declarada: string;
  reabierta: boolean; reabierta_por: string | null; reabierta_motivo: string | null; cifras: Record<string, string | number>; archivo_nombre: string | null; excedente_siguiente: string | null;
}

export async function listarDeclaraciones(db: Db): Promise<FilaDeclaracion[]> {
  const { rows } = await db.query<FilaDeclaracion>(
    `select d.id, d.tipo, d.anio, d.mes, d.quincena, d.desde::text, d.hasta::text, u.nombre as declarada_por,
            to_char(d.declarada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as declarada, (d.reabierta_at is not null) as reabierta, ru.nombre as reabierta_por,
            d.reabierta_motivo, d.cifras, d.archivo_nombre, d.excedente_siguiente::text
       from declaracion_fiscal d join usuario u on u.id = d.declarada_por left join usuario ru on ru.id = d.reabierta_por
      order by d.anio desc, d.mes desc, d.tipo, d.quincena nulls first, d.declarada_at desc`);
  return rows;
}

export async function detalleDeclaracion(db: Db, id: string): Promise<(FilaDeclaracion & { archivo: string | null }) | null> {
  const { rows } = await db.query<FilaDeclaracion & { archivo: string | null }>(
    `select d.id, d.tipo, d.anio, d.mes, d.quincena, d.desde::text, d.hasta::text, u.nombre as declarada_por,
            to_char(d.declarada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as declarada, (d.reabierta_at is not null) as reabierta, ru.nombre as reabierta_por,
            d.reabierta_motivo, d.cifras, d.archivo_nombre, d.excedente_siguiente::text, d.archivo
       from declaracion_fiscal d join usuario u on u.id = d.declarada_por left join usuario ru on ru.id = d.reabierta_por where d.id = $1`, [id]);
  return rows[0] ?? null;
}
