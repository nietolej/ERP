import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Libros de ventas y de compras (spec §11.4; migración 0044). Salen de las vistas vw_libro_ventas y vw_libro_compras: una sola fuente.
 * Importes en bolívares, grano documento × alícuota; las notas de crédito restan. El periodo es el mes calendario de la fecha del documento.
 */

export const ROLES_VEN_LIBROS = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];

const dec = (v: Decimal.Value) => new Decimal(v);

export function validarPeriodo(anio: number, mes: number) {
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) throw new ErrorMaestro('Indique un mes y un año válidos.');
}

export interface FilaLibroVentas {
  fecha: string; tipo: string; estado: string; incluido: boolean; numero_documento: string; numero_control: string | null; contingencia: boolean;
  fecha_anulacion: string | null; documento_afectado: string | null; rif: string; razon_social: string; alicuota_pct: string; tipo_libro: string;
  base_ves: string; iva_ves: string;
}

export interface ResumenAlicuota { alicuota_pct: string; tipo_libro: string; base: string; iva: string; credito?: string }

export interface LibroVentas {
  filas: FilaLibroVentas[];
  resumen: ResumenAlicuota[];
  /** Débito fiscal: el IVA de las facturas y notas emitidas del mes. */
  debito: string;
  base: string;
}

export async function libroVentas(db: Db, anio: number, mes: number): Promise<LibroVentas> {
  validarPeriodo(anio, mes);
  const { rows } = await db.query<FilaLibroVentas>(
    `select fecha::text, tipo, estado, incluido, numero_documento, numero_control, contingencia, fecha_anulacion::text, documento_afectado, rif, razon_social,
            alicuota_pct::text, tipo_libro, base_ves::text, iva_ves::text
       from vw_libro_ventas where periodo = make_date($1, $2, 1) order by fecha, numero_documento, alicuota_pct desc`, [anio, mes]);
  const incl = rows.filter((f) => f.incluido);
  const porAlicuota = new Map<string, ResumenAlicuota>();
  for (const f of incl) {
    const k = `${f.alicuota_pct}|${f.tipo_libro}`;
    const r = porAlicuota.get(k) ?? { alicuota_pct: f.alicuota_pct, tipo_libro: f.tipo_libro, base: '0', iva: '0' };
    r.base = dec(r.base).plus(f.base_ves).toFixed(2);
    r.iva = dec(r.iva).plus(f.iva_ves).toFixed(2);
    porAlicuota.set(k, r);
  }
  const resumen = [...porAlicuota.values()].sort((a, b) => Number(b.alicuota_pct) - Number(a.alicuota_pct));
  return {
    filas: rows, resumen,
    debito: incl.reduce((s, f) => s.plus(f.iva_ves), dec(0)).toFixed(2),
    base: incl.reduce((s, f) => s.plus(f.base_ves), dec(0)).toFixed(2),
  };
}

export interface FilaLibroCompras {
  fecha: string; origen: string; tipo: string; documento_id: string; numero_documento: string; numero_control: string; documento_afectado: string | null;
  rif: string; razon_social: string; alicuota_pct: string; tipo_libro: string; base_ves: string; iva_ves: string; credito_ves: string;
  /** Retención de IVA del documento (en su primera fila; las demás van en blanco para no duplicarla). */
  retencion_iva_ves: string; retencion_islr_ves: string;
}

export interface LibroCompras {
  filas: FilaLibroCompras[];
  resumen: ResumenAlicuota[];
  /** Crédito fiscal: el IVA con derecho a crédito de las compras, gastos y notas del mes. */
  credito: string;
  base: string;
  retencionIva: string;
  retencionIslr: string;
}

export async function libroCompras(db: Db, anio: number, mes: number): Promise<LibroCompras> {
  validarPeriodo(anio, mes);
  const { rows } = await db.query<Omit<FilaLibroCompras, 'retencion_iva_ves' | 'retencion_islr_ves'>>(
    `select fecha::text, origen, tipo, documento_id::text, numero_documento, numero_control, documento_afectado, rif, razon_social, alicuota_pct::text, tipo_libro,
            base_ves::text, iva_ves::text, credito_ves::text
       from vw_libro_compras where periodo = make_date($1, $2, 1) order by fecha, numero_documento, alicuota_pct desc`, [anio, mes]);
  const { rows: ret } = await db.query<{ documento_id: string; impuesto: string; monto: string }>(
    `select documento_id::text, impuesto, sum(monto_ves)::text as monto from vw_libro_compras_retencion where periodo = make_date($1, $2, 1) group by documento_id, impuesto`, [anio, mes]);
  const retDe = new Map<string, { iva: string; islr: string }>();
  for (const r of ret) {
    const x = retDe.get(r.documento_id) ?? { iva: '0.00', islr: '0.00' };
    if (r.impuesto === 'iva') x.iva = dec(r.monto).toFixed(2); else x.islr = dec(r.monto).toFixed(2);
    retDe.set(r.documento_id, x);
  }
  const vistos = new Set<string>();
  const filas = rows.map<FilaLibroCompras>((f) => {
    const primera = !vistos.has(f.documento_id);
    vistos.add(f.documento_id);
    const r = retDe.get(f.documento_id);
    return { ...f, retencion_iva_ves: primera && r ? r.iva : '0.00', retencion_islr_ves: primera && r ? r.islr : '0.00' };
  });
  const porAlicuota = new Map<string, ResumenAlicuota>();
  for (const f of filas) {
    const k = `${f.alicuota_pct}|${f.tipo_libro}`;
    const r = porAlicuota.get(k) ?? { alicuota_pct: f.alicuota_pct, tipo_libro: f.tipo_libro, base: '0', iva: '0', credito: '0' };
    r.base = dec(r.base).plus(f.base_ves).toFixed(2);
    r.iva = dec(r.iva).plus(f.iva_ves).toFixed(2);
    r.credito = dec(r.credito ?? 0).plus(f.credito_ves).toFixed(2);
    porAlicuota.set(k, r);
  }
  return {
    filas,
    resumen: [...porAlicuota.values()].sort((a, b) => Number(b.alicuota_pct) - Number(a.alicuota_pct)),
    credito: filas.reduce((s, f) => s.plus(f.credito_ves), dec(0)).toFixed(2),
    base: filas.reduce((s, f) => s.plus(f.base_ves), dec(0)).toFixed(2),
    retencionIva: filas.reduce((s, f) => s.plus(f.retencion_iva_ves), dec(0)).toFixed(2),
    retencionIslr: filas.reduce((s, f) => s.plus(f.retencion_islr_ves), dec(0)).toFixed(2),
  };
}
