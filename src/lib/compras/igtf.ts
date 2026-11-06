import Decimal from 'decimal.js';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { dos } from '@/lib/dinero';

/**
 * IGTF pagado en los pagos a proveedores (spec §11.3; migración 0042).
 *
 * Se causa cuando el pago es en divisas, el instrumento genera IGTF y el proveedor es contribuyente especial (agente de percepción). Es un
 * gasto financiero que se paga aparte: el banco sale por el pago más el IGTF y la deuda con el proveedor baja solo por el pago.
 * El porcentaje sale de parametro_fiscal (IGTF) con su vigencia a la fecha del pago.
 */


export interface EstimacionIgtf {
  aplica: boolean;
  motivo: string | null;
  porcentaje: string | null;
  monto: string | null;
  moneda: string;
}

/** ¿Causa IGTF este pago y de cuánto? (sin escribir nada). `motivo` explica por qué no, si no aplica. */
export async function estimarIgtf(
  db: Db, d: { proveedorId: string; instrumentoId: string; cuentaBancariaId: string; fecha: string; monto: string },
): Promise<EstimacionIgtf> {
  const { rows } = await db.query<{ moneda: string; genera: boolean; especial: boolean }>(
    `select cb.moneda, i.genera_igtf as genera, t.contribuyente_especial as especial
       from cuenta_bancaria cb, instrumento_pago i, tercero t where cb.id = $1 and i.id = $2 and t.id = $3`,
    [d.cuentaBancariaId, d.instrumentoId, d.proveedorId]);
  const x = rows[0];
  if (!x) return { aplica: false, motivo: null, porcentaje: null, monto: null, moneda: 'VES' };
  const no = (motivo: string): EstimacionIgtf => ({ aplica: false, motivo, porcentaje: null, monto: null, moneda: x.moneda });
  if (x.moneda === 'VES') return no('El pago es en bolívares.');
  if (!x.genera) return no('El instrumento de pago no genera IGTF.');
  if (!x.especial) return no('El proveedor no es contribuyente especial (agente de percepción).');
  const { rows: p } = await db.query<{ pct: string }>(`select fn_parametro_fiscal('IGTF', $1::date)::text as pct`, [d.fecha]);
  const pct = new Decimal(p[0].pct);
  return { aplica: true, motivo: null, porcentaje: pct.toString(), monto: dos(new Decimal(d.monto).times(pct).dividedBy(100)).toFixed(2), moneda: x.moneda };
}

/** Al aprobar el pago: guarda el IGTF y genera su asiento (gasto financiero contra el banco). Devuelve null si no aplica. */
export async function registrarIgtfPago(tx: Db, pagoId: string, aprobador: string): Promise<{ monto: string; asiento: string } | null> {
  const { rows } = await tx.query<{
    proveedor_id: string; instrumento_id: string; cuenta_bancaria_id: string; fecha: string; monto: string; moneda: string; tasa: string; cuenta_contable_id: string; numero: string;
  }>(
    `select p.proveedor_id, p.instrumento_id, p.cuenta_bancaria_id, p.fecha::text, p.monto::text, p.moneda, p.tasa::text, cb.cuenta_contable_id, p.numero::text
       from pago p join cuenta_bancaria cb on cb.id = p.cuenta_bancaria_id where p.id = $1`, [pagoId]);
  const p = rows[0];
  if (!p) return null;
  const e = await estimarIgtf(tx, { proveedorId: p.proveedor_id, instrumentoId: p.instrumento_id, cuentaBancariaId: p.cuenta_bancaria_id, fecha: p.fecha, monto: p.monto });
  if (!e.aplica || !e.monto || new Decimal(e.monto).lte(0)) return null;

  const { rows: u } = await tx.query<{ usd: string }>(`select fn_tasa('USD', $1::date)::text as usd`, [p.fecha]);
  const ves = dos(dos(new Decimal(e.monto).times(p.tasa)));
  const usd = p.moneda === 'USD' ? new Decimal(e.monto) : dos(ves.dividedBy(u[0].usd));
  const { rows: ig } = await tx.query<{ id: string }>(
    `insert into igtf_pago (pago_id, fecha, moneda, tasa, base, porcentaje, monto, monto_ves, monto_usd) values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [pagoId, p.fecha, p.moneda, p.tasa, p.monto, e.porcentaje, e.monto, ves.toFixed(2), usd.toFixed(2)]);
  const a = await contabilizar(tx, {
    evento: 'igtf_pagado', fecha: p.fecha, descripcion: `IGTF del pago N° ${p.numero}`, origen: { tipo: 'igtf_pago', id: ig[0].id }, moneda: p.moneda,
    importes: { monto: e.monto }, cuentas: { banco: p.cuenta_contable_id }, terceroId: p.proveedor_id, usuarioId: aprobador,
  });
  return { monto: e.monto, asiento: a.numero };
}

/** Al anular el pago: reversa el asiento del IGTF y lo marca revertido. */
export async function revertirIgtfPago(tx: Db, pagoId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string; revertido: boolean }>('select id, revertido from igtf_pago where pago_id = $1 for update', [pagoId]);
  if (!rows[0] || rows[0].revertido) return;
  const { rows: a } = await tx.query<{ id: string }>(`select id from asiento where origen_tipo = 'igtf_pago' and origen_id = $1 and tipo = 'automatico'`, [rows[0].id]);
  if (a[0]) await tx.query(`select fn_reversar_asiento($1, ((now() at time zone 'America/Caracas')::date), $2)`, [a[0].id, 'Anulación del pago: se revierte el IGTF']);
  await tx.query('update igtf_pago set revertido = true where id = $1', [rows[0].id]);
}

export interface IgtfDelPago { monto: string; porcentaje: string; base: string; moneda: string; asiento: string | null; revertido: boolean }

export async function igtfDe(db: Db, pagoId: string): Promise<IgtfDelPago | null> {
  const { rows } = await db.query<IgtfDelPago>(
    `select i.monto::text, i.porcentaje::text, i.base::text, i.moneda, a.numero::text as asiento, i.revertido
       from igtf_pago i left join asiento a on a.origen_tipo = 'igtf_pago' and a.origen_id = i.id and a.tipo = 'automatico' where i.pago_id = $1`, [pagoId]);
  return rows[0] ?? null;
}
