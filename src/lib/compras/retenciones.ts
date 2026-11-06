import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';

/**
 * Retenciones de IVA e ISLR al contabilizar una factura de compra o un gasto de importación (spec §7.2 regla 4, §11.0, §11.2).
 * Migración 0037. Ningún porcentaje vive aquí: el IVA sale de parametro_fiscal (con vigencia por fecha), la Unidad Tributaria
 * también y el ISLR de concepto_islr_tarifa, que carga Contabilidad. Solo retiene una empresa marcada como agente (§11.0).
 */

const dos = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface Retencion {
  impuesto: 'iva' | 'islr';
  /** IVA: el IVA de la factura. ISLR: la base sin IVA. */
  base: Decimal;
  porcentaje: Decimal;
  sustraendo: Decimal;
  monto: Decimal;
  /** IVA retenido al 100 %. */
  ivaTotal: boolean;
  tarifaId: string | null;
}

export interface DatosRetencion {
  proveedorId: string;
  /** 'AAAA-MM-DD': fecha de la factura, que fija las vigencias. */
  fecha: string;
  /** VES por unidad de la moneda de la factura (1 si es VES). */
  tasa: string;
  /** Base gravada + exenta (sin IVA). */
  baseSinIva: string;
  iva: string;
  ivaTotal: boolean;
}

/** Calcula las retenciones que corresponden (puede no haber ninguna). No escribe nada. */
export async function calcularRetenciones(db: Db, d: DatosRetencion): Promise<Retencion[]> {
  const { rows: emp } = await db.query<{ iva: boolean; islr: boolean }>('select agente_retencion_iva as iva, agente_retencion_islr as islr from empresa limit 1');
  const agente = emp[0] ?? { iva: false, islr: false };
  const resultado: Retencion[] = [];

  const iva = new Decimal(d.iva);
  if (agente.iva && iva.gt(0)) {
    const codigo = d.ivaTotal ? 'RET_IVA_TOTAL' : 'RET_IVA_GENERAL';
    const { rows } = await db.query<{ pct: string }>('select fn_parametro_fiscal($1, $2::date)::text as pct', [codigo, d.fecha]);
    const pct = new Decimal(rows[0].pct);
    const monto = dos(iva.times(pct).dividedBy(100));
    if (monto.gt(0)) resultado.push({ impuesto: 'iva', base: iva, porcentaje: pct, sustraendo: new Decimal(0), monto, ivaTotal: d.ivaTotal, tarifaId: null });
  }

  if (agente.islr) {
    const { rows: prov } = await db.query<{ concepto_id: string | null; concepto: string | null; tipo_persona: 'N' | 'J'; domiciliado: boolean }>(
      `select p.concepto_islr_id as concepto_id, c.codigo as concepto, t.tipo_persona, t.domiciliado
         from proveedor p join tercero t on t.id = p.tercero_id left join concepto_islr c on c.id = p.concepto_islr_id where p.tercero_id = $1`, [d.proveedorId]);
    const p = prov[0];
    if (p?.concepto_id) {
      const { rows: tar } = await db.query<{ id: string; pct: string; minimo: string; sustraendo: string }>(
        `select id, porcentaje::text as pct, base_minima_ut::text as minimo, sustraendo_ut::text as sustraendo from concepto_islr_tarifa
          where concepto_id = $1 and tipo_persona = $2 and domiciliado = $3 and vigente_desde <= $4::date
            and (vigente_hasta is null or vigente_hasta >= $4::date)`, [p.concepto_id, p.tipo_persona, p.domiciliado, d.fecha]);
      if (!tar[0]) {
        throw new ErrorMaestro(
          `Falta la tarifa de ISLR vigente al ${d.fecha} del concepto ${p.concepto} para ${p.tipo_persona === 'N' ? 'persona natural' : 'persona jurídica'} ` +
          `${p.domiciliado ? 'domiciliada' : 'no domiciliada'}. Contabilidad debe cargarla en Configuración → Conceptos de ISLR antes de contabilizar.`);
      }
      const { rows: ut } = await db.query<{ ut: string }>(`select fn_parametro_fiscal('UNIDAD_TRIBUTARIA', $1::date)::text as ut`, [d.fecha]);
      const utMoneda = new Decimal(ut[0].ut).dividedBy(d.tasa);          // la UT está en bolívares: se lleva a la moneda de la factura
      const base = new Decimal(d.baseSinIva);
      const t = tar[0];
      if (base.gte(new Decimal(t.minimo).times(utMoneda))) {
        const sustraendo = dos(new Decimal(t.sustraendo).times(utMoneda));
        const monto = dos(base.times(t.pct).dividedBy(100)).minus(sustraendo);
        if (monto.gt(0)) resultado.push({ impuesto: 'islr', base, porcentaje: new Decimal(t.pct), sustraendo, monto, ivaTotal: false, tarifaId: t.id });
      }
    }
  }
  return resultado;
}

export const sumaRetenciones = (r: Retencion[], impuesto: 'iva' | 'islr'): Decimal =>
  r.filter((x) => x.impuesto === impuesto).reduce((s, x) => s.plus(x.monto), new Decimal(0));

/** Guarda las retenciones practicadas (inmutables) con su equivalente en USD. */
export async function guardarRetenciones(
  tx: Db, origen: { facturaId?: string; gastoId?: string; gastoProveedorId?: string }, d: { proveedorId: string; fecha: string; moneda: string; tasa: string },
  retenciones: Retencion[], enUsd: (orig: Decimal) => Decimal,
): Promise<void> {
  for (const r of retenciones) {
    await tx.query(
      `insert into retencion_compra (factura_id, gasto_id, gasto_proveedor_id, proveedor_id, impuesto, fecha, moneda, tasa, base, porcentaje, sustraendo, monto, monto_usd, iva_total, tarifa_id)
       values ($1, $2, $15, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [origen.facturaId ?? null, origen.gastoId ?? null, d.proveedorId, r.impuesto, d.fecha, d.moneda, d.tasa, r.base.toFixed(2), r.porcentaje.toString(),
       r.sustraendo.toFixed(2), r.monto.toFixed(2), enUsd(r.monto).toFixed(2), r.ivaTotal, r.tarifaId, origen.gastoProveedorId ?? null]);
  }
}

export interface FilaRetencion {
  impuesto: 'iva' | 'islr'; base: string; porcentaje: string; sustraendo: string; monto: string; monto_usd: string; iva_total: boolean; concepto: string | null;
}

/** Retenciones practicadas a una factura de compra o a un gasto, para mostrarlas en su detalle. */
export async function retencionesDe(db: Db, origen: { facturaId?: string; gastoId?: string; notaId?: string; gastoProveedorId?: string }): Promise<FilaRetencion[]> {
  const { rows } = await db.query<FilaRetencion>(
    `select r.impuesto, r.base::text, r.porcentaje::text, r.sustraendo::text, r.monto::text, r.monto_usd::text, r.iva_total, c.codigo as concepto
       from retencion_compra r left join concepto_islr_tarifa t on t.id = r.tarifa_id left join concepto_islr c on c.id = t.concepto_id
      where r.factura_id = $1 or r.gasto_id = $2 or r.nota_id = $3 or r.gasto_proveedor_id = $4 order by r.impuesto`,
    [origen.facturaId ?? null, origen.gastoId ?? null, origen.notaId ?? null, origen.gastoProveedorId ?? null]);
  return rows;
}
