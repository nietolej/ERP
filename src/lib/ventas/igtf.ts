import Decimal from 'decimal.js';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { dos } from '@/lib/dinero';

/**
 * IGTF percibido en los cobros (spec §11.3; migración 0046).
 *
 * Se percibe cuando la empresa es agente de percepción (empresa.agente_percepcion_igtf), el cobro es en divisas y el instrumento genera IGTF.
 * Va aparte, además del cobro: el cobro y sus aplicaciones no cambian. Es un pasivo (2.1.06) que se entera después, no un ingreso.
 * El porcentaje sale de parametro_fiscal (IGTF) con su vigencia a la fecha del cobro.
 */


export interface EstimacionIgtfCobro { aplica: boolean; motivo: string | null; porcentaje: string | null; monto: string | null; moneda: string }

/** ¿Se percibe IGTF en este cobro y de cuánto? (sin escribir nada). `motivo` explica por qué no, si no aplica. */
export async function estimarIgtfCobro(db: Db, d: { cuentaBancariaId: string; instrumentoId: string; fecha: string; monto: string }): Promise<EstimacionIgtfCobro> {
  const { rows } = await db.query<{ moneda: string; genera: boolean; agente: boolean }>(
    `select cb.moneda, i.genera_igtf as genera, coalesce((select agente_percepcion_igtf from empresa limit 1), false) as agente
       from cuenta_bancaria cb, instrumento_pago i where cb.id = $1 and i.id = $2`, [d.cuentaBancariaId, d.instrumentoId]);
  const x = rows[0];
  if (!x) return { aplica: false, motivo: null, porcentaje: null, monto: null, moneda: 'VES' };
  const no = (motivo: string): EstimacionIgtfCobro => ({ aplica: false, motivo, porcentaje: null, monto: null, moneda: x.moneda });
  if (!x.agente) return no('La empresa no es agente de percepción de IGTF.');
  if (x.moneda === 'VES') return no('El cobro es en bolívares.');
  if (!x.genera) return no('El instrumento de pago no genera IGTF.');
  const { rows: p } = await db.query<{ pct: string }>(`select fn_parametro_fiscal('IGTF', $1::date)::text as pct`, [d.fecha]);
  const pct = new Decimal(p[0].pct);
  return { aplica: true, motivo: null, porcentaje: pct.toString(), monto: dos(new Decimal(d.monto).times(pct).dividedBy(100)).toFixed(2), moneda: x.moneda };
}

/** Al registrar el cobro: guarda el IGTF percibido y genera su asiento (banco contra IGTF por enterar). Devuelve null si no aplica. */
export async function registrarIgtfCobro(tx: Db, cobroId: string, usuarioId: string): Promise<{ monto: string; asiento: string } | null> {
  const { rows } = await tx.query<{
    cliente_id: string; instrumento_id: string; cuenta_bancaria_id: string; fecha: string; monto: string; moneda: string; tasa: string; cuenta_contable_id: string; numero: string;
  }>(
    `select c.cliente_id, c.instrumento_id, c.cuenta_bancaria_id, c.fecha::text, c.monto::text, c.moneda, c.tasa::text, cb.cuenta_contable_id, c.numero::text
       from cobro c join cuenta_bancaria cb on cb.id = c.cuenta_bancaria_id where c.id = $1`, [cobroId]);
  const c = rows[0];
  if (!c) return null;
  const e = await estimarIgtfCobro(tx, { cuentaBancariaId: c.cuenta_bancaria_id, instrumentoId: c.instrumento_id, fecha: c.fecha, monto: c.monto });
  if (!e.aplica || !e.monto || new Decimal(e.monto).lte(0)) return null;

  const { rows: u } = await tx.query<{ usd: string }>(`select fn_tasa('USD', $1::date)::text as usd`, [c.fecha]);
  const ves = dos(new Decimal(e.monto).times(c.tasa));
  const usd = c.moneda === 'USD' ? new Decimal(e.monto) : dos(ves.dividedBy(u[0].usd));
  const { rows: ig } = await tx.query<{ id: string }>(
    `insert into igtf_cobro (cobro_id, fecha, moneda, tasa, base, porcentaje, monto, monto_ves, monto_usd) values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [cobroId, c.fecha, c.moneda, c.tasa, c.monto, e.porcentaje, e.monto, ves.toFixed(2), usd.toFixed(2)]);
  const a = await contabilizar(tx, {
    evento: 'igtf_percibido', fecha: c.fecha, descripcion: `IGTF percibido del cobro N° ${c.numero}`, origen: { tipo: 'igtf_cobro', id: ig[0].id }, moneda: c.moneda,
    importes: { monto: e.monto }, cuentas: { banco: c.cuenta_contable_id }, terceroId: c.cliente_id, usuarioId,
  });
  return { monto: e.monto, asiento: a.numero };
}

/** Al anular el cobro: reversa el asiento del IGTF y lo marca revertido. */
export async function revertirIgtfCobro(tx: Db, cobroId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string; revertido: boolean }>('select id, revertido from igtf_cobro where cobro_id = $1 for update', [cobroId]);
  if (!rows[0] || rows[0].revertido) return;
  const { rows: a } = await tx.query<{ id: string }>(`select id from asiento where origen_tipo = 'igtf_cobro' and origen_id = $1 and tipo = 'automatico'`, [rows[0].id]);
  if (a[0]) await tx.query(`select fn_reversar_asiento($1, ((now() at time zone 'America/Caracas')::date), $2)`, [a[0].id, 'Anulación del cobro: se revierte el IGTF percibido']);
  await tx.query('update igtf_cobro set revertido = true where id = $1', [rows[0].id]);
}

export interface IgtfDelCobro { monto: string; porcentaje: string; base: string; moneda: string; asiento: string | null; revertido: boolean }

export async function igtfDeCobro(db: Db, cobroId: string): Promise<IgtfDelCobro | null> {
  const { rows } = await db.query<IgtfDelCobro>(
    `select i.monto::text, i.porcentaje::text, i.base::text, i.moneda, a.numero::text as asiento, i.revertido
       from igtf_cobro i left join asiento a on a.origen_tipo = 'igtf_cobro' and a.origen_id = i.id and a.tipo = 'automatico' where i.cobro_id = $1`, [cobroId]);
  return rows[0] ?? null;
}

export interface FilaIgtf { fecha: string; documento: string; tercero: string; rif: string; moneda: string; base: string; porcentaje: string; monto: string; monto_ves: string; revertido: boolean }

export interface ReporteIgtf {
  percibido: FilaIgtf[]; pagado: FilaIgtf[];
  totalPercibidoVes: string; totalPagadoVes: string;
  /** Saldo de «IGTF percibido por enterar» (2.1.06) en el mayor, al cierre del mes. */
  porEnterarVes: string;
}

/** Reporte propio del IGTF del mes (§11.3): lo percibido en cobros, lo pagado a proveedores y el saldo por enterar. */
export async function reporteIgtf(db: Db, anio: number, mes: number): Promise<ReporteIgtf> {
  const periodo = [anio, mes];
  const { rows: per } = await db.query<FilaIgtf>(
    `select i.fecha::text, 'Cobro N° ' || c.numero as documento, t.razon_social as tercero, t.rif, i.moneda, i.base::text, i.porcentaje::text, i.monto::text,
            (case when i.revertido then 0 else i.monto_ves end)::text as monto_ves, i.revertido
       from igtf_cobro i join cobro c on c.id = i.cobro_id join tercero t on t.id = c.cliente_id
      where date_trunc('month', i.fecha) = make_date($1, $2, 1) order by i.fecha, c.numero`, periodo);
  const { rows: pag } = await db.query<FilaIgtf>(
    `select i.fecha::text, 'Pago N° ' || p.numero as documento, t.razon_social as tercero, t.rif, i.moneda, i.base::text, i.porcentaje::text, i.monto::text,
            (case when i.revertido then 0 else i.monto_ves end)::text as monto_ves, i.revertido
       from igtf_pago i join pago p on p.id = i.pago_id join tercero t on t.id = p.proveedor_id
      where date_trunc('month', i.fecha) = make_date($1, $2, 1) order by i.fecha, p.numero`, periodo);
  const { rows: s } = await db.query<{ saldo: string }>(
    `select coalesce(sum(l.haber_ves - l.debe_ves), 0)::text as saldo
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id
      where c.codigo = '2.1.06' and a.fecha < (make_date($1, $2, 1) + interval '1 month')::date`, periodo);
  const suma = (f: FilaIgtf[]) => f.reduce((t, x) => t.plus(x.monto_ves), new Decimal(0)).toFixed(2);
  return { percibido: per, pagado: pag, totalPercibidoVes: suma(per), totalPagadoVes: suma(pag), porEnterarVes: new Decimal(s[0].saldo).toFixed(2) };
}
