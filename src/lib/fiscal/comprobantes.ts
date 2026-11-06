import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { validarPeriodo } from './libros';

/**
 * Comprobantes de retención de IVA e ISLR (spec §11.2; migración 0045). Uno por retención de un documento, con número de 14 caracteres
 * (AAAAMM del periodo de la retención + correlativo de 8 dígitos por impuesto y periodo, sin huecos). Contabilidad o Gerencia los emiten
 * por lotes del mes. Las retenciones que revierte una nota de crédito del proveedor no se numeran todavía: son «ajustes por emitir».
 */

export const ROLES_EMITEN_COMPROBANTES = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_COMPROBANTES = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor', 'tesoreria', 'compras'] as const satisfies readonly Rol[];

export type UsuarioComp = { id: string; roles: readonly string[] };
export type Impuesto = 'iva' | 'islr';
export const NOMBRE_IMPUESTO: Record<Impuesto, string> = { iva: 'IVA', islr: 'ISLR' };

/**
 * Último día para entregar el comprobante de un periodo: el 2.º día hábil (lunes a viernes) del mes siguiente (§11.2). No conoce feriados:
 * si hay uno, el plazo real se corre y esta fecha queda del lado prudente.
 */
export function plazoComprobante(anio: number, mes: number): string {
  const d = new Date(Date.UTC(anio, mes, 1));                          // día 1 del mes siguiente
  let habiles = 0;
  for (;;) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) habiles++;
    if (habiles === 2) return d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export interface FilaPendiente {
  retencion_id: string; impuesto: Impuesto; fecha: string; proveedor: string; rif: string; documento: string; moneda: string; base: string; monto: string;
}

const SQL_DOC = `coalesce(f.numero_factura, g.numero_factura, gp.numero_factura)`;
const JOIN_DOC = `left join factura_compra f on f.id = r.factura_id left join gasto_importacion g on g.id = r.gasto_id left join gasto_proveedor gp on gp.id = r.gasto_proveedor_id`;

/** Retenciones del mes que todavía no tienen comprobante. */
export async function pendientes(db: Db, anio: number, mes: number): Promise<FilaPendiente[]> {
  validarPeriodo(anio, mes);
  const { rows } = await db.query<FilaPendiente>(
    `select r.id as retencion_id, r.impuesto, r.fecha::text, t.razon_social as proveedor, t.rif, ${SQL_DOC} as documento, r.moneda, r.base::text, r.monto::text
       from retencion_compra r join tercero t on t.id = r.proveedor_id ${JOIN_DOC}
      where r.nota_id is null and r.signo = 1 and to_char(r.fecha, 'YYYYMM') = $1 and not exists (select 1 from comprobante_retencion c where c.retencion_id = r.id)
      order by r.impuesto, r.fecha, r.created_at, r.id`, [`${anio}${String(mes).padStart(2, '0')}`]);
  return rows;
}

export interface FilaAjuste { retencion_id: string; impuesto: Impuesto; fecha: string; proveedor: string; documento: string; moneda: string; monto: string }

/** Retenciones revertidas por notas de crédito del proveedor: no se numeran hasta que el contador confirme cómo se documentan. */
export async function ajustesPorEmitir(db: Db, anio: number, mes: number): Promise<FilaAjuste[]> {
  validarPeriodo(anio, mes);
  const { rows } = await db.query<FilaAjuste>(
    `select r.id as retencion_id, r.impuesto, r.fecha::text, t.razon_social as proveedor, n.numero_documento as documento, r.moneda, (r.monto * r.signo)::text as monto
       from retencion_compra r join tercero t on t.id = r.proveedor_id join nota_proveedor n on n.id = r.nota_id
      where r.nota_id is not null and to_char(r.fecha, 'YYYYMM') = $1 order by r.impuesto, r.fecha`, [`${anio}${String(mes).padStart(2, '0')}`]);
  return rows;
}

/** Emite los comprobantes pendientes del mes, en orden de fecha: sus números salen correlativos y todo o nada. */
export async function emitirPeriodo(tx: Db, u: UsuarioComp, anio: number, mes: number): Promise<{ emitidos: number; porImpuesto: Record<Impuesto, number> }> {
  if (!u.roles.some((r) => (ROLES_EMITEN_COMPROBANTES as readonly string[]).includes(r))) throw new ErrorMaestro('Solo Contabilidad o Gerencia emiten comprobantes de retención.');
  const lista = await pendientes(tx, anio, mes);
  if (!lista.length) throw new ErrorMaestro('No hay retenciones pendientes de comprobante en ese mes.');
  const porImpuesto: Record<Impuesto, number> = { iva: 0, islr: 0 };
  for (const p of lista) {
    await tx.query(
      `insert into comprobante_retencion (retencion_id, impuesto, periodo, numero, proveedor_id, fecha_emision, emitido_por)
       values ($1, $2, '000000', '00000000000000', $3, (now() at time zone 'America/Caracas')::date, $4)`,
      [p.retencion_id, p.impuesto, (await tx.query<{ id: string }>('select proveedor_id as id from retencion_compra where id = $1', [p.retencion_id])).rows[0].id, u.id]);
    porImpuesto[p.impuesto]++;
  }
  return { emitidos: lista.length, porImpuesto };
}

export interface FilaComprobante {
  id: string; numero: string; impuesto: Impuesto; periodo: string; fecha_emision: string; proveedor: string; rif: string; documento: string; moneda: string; base: string; monto: string;
}

export async function listarComprobantes(db: Db, anio: number, mes: number, impuesto: '' | Impuesto = ''): Promise<FilaComprobante[]> {
  validarPeriodo(anio, mes);
  const { rows } = await db.query<FilaComprobante>(
    `select c.id, c.numero, c.impuesto, c.periodo, to_char(c.fecha_emision, 'DD-MM-YYYY') as fecha_emision, t.razon_social as proveedor, t.rif, ${SQL_DOC} as documento,
            r.moneda, r.base::text, r.monto::text
       from comprobante_retencion c join retencion_compra r on r.id = c.retencion_id join tercero t on t.id = c.proveedor_id ${JOIN_DOC}
      where c.periodo = $1 and ($2 = '' or c.impuesto = $2) order by c.impuesto, c.numero`, [`${anio}${String(mes).padStart(2, '0')}`, impuesto]);
  return rows;
}

export interface DetalleComprobante extends FilaComprobante {
  fecha_retencion: string; porcentaje: string; sustraendo: string; iva_total: boolean; concepto: string | null; tasa: string;
  numero_control: string | null; fecha_documento: string; iva_documento: string | null;
  agente_rif: string; agente_razon: string; agente_domicilio: string; sujeto_direccion: string | null; emitido_por: string;
}

export async function detalleComprobante(db: Db, id: string): Promise<DetalleComprobante | null> {
  const { rows } = await db.query<DetalleComprobante>(
    `select c.id, c.numero, c.impuesto, c.periodo, to_char(c.fecha_emision, 'DD-MM-YYYY') as fecha_emision, t.razon_social as proveedor, t.rif, ${SQL_DOC} as documento,
            r.moneda, r.base::text, r.monto::text, to_char(r.fecha, 'DD-MM-YYYY') as fecha_retencion, r.porcentaje::text, r.sustraendo::text, r.iva_total,
            ct.codigo || ' · ' || ct.descripcion as concepto, r.tasa::text,
            coalesce(f.numero_control, g.numero_control, gp.numero_control) as numero_control,
            to_char(coalesce(f.fecha_factura, g.fecha_factura, gp.fecha_factura), 'DD-MM-YYYY') as fecha_documento,
            coalesce(f.iva, g.iva, gp.iva)::text as iva_documento,
            e.rif as agente_rif, e.razon_social as agente_razon, e.domicilio_fiscal as agente_domicilio, t.direccion_fiscal as sujeto_direccion, u.nombre as emitido_por
       from comprobante_retencion c join retencion_compra r on r.id = c.retencion_id join tercero t on t.id = c.proveedor_id ${JOIN_DOC}
       left join concepto_islr_tarifa ctf on ctf.id = r.tarifa_id left join concepto_islr ct on ct.id = ctf.concepto_id
       cross join empresa e join usuario u on u.id = c.emitido_por where c.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Resumen del mes: lo retenido, lo ya numerado y lo pendiente, por impuesto, y el plazo de entrega. */
export async function resumenComprobantes(db: Db, anio: number, mes: number) {
  const pend = await pendientes(db, anio, mes);
  const emitidos = await listarComprobantes(db, anio, mes);
  const ajustes = await ajustesPorEmitir(db, anio, mes);
  return { pendientes: pend, emitidos, ajustes, plazo: plazoComprobante(anio, mes) };
}
