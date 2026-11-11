import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import type { Usuario } from './pedidos';

/**
 * Retenciones de IVA e ISLR que nos practican los clientes (§6.3, §11.2; migración 0059; decisiones del 10-11-2026).
 *
 * El cliente agente de retención paga el documento neto y entrega su comprobante, a veces días después. El comprobante se registra
 * aquí como un documento propio aplicado a una factura o nota de débito: reduce su cuenta por cobrar a su valor histórico y genera el
 * asiento Debe 1.2.04 IVA retenido por clientes (o 1.2.05 ISLR) / Haber 1.2.01 CxC. El IVA retenido se descuenta en la declaración
 * del mes del comprobante (o del mes en que se registra, si aquel ya estaba declarado); lo que sobra se traslada al mes siguiente.
 * Un cobro aplicado a un documento que tendrá retención se registra sin «liquidar»: el saldo que queda es lo que se retendrá.
 */

export const ROLES_REGISTRAN_RETENCIONES = ['cobranzas', 'contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_RETENCIONES = [...ROLES_REGISTRAN_RETENCIONES, 'tesoreria', 'supervisor_ventas', 'auditor'] as const satisfies readonly Rol[];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^\d{1,13}(\.\d{1,2})?$/;
const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;
/** Número del comprobante de retención de IVA: AAAAMM + correlativo de 8 dígitos. */
const COMPROBANTE_IVA = /^\d{14}$/;

export type Impuesto = 'iva' | 'islr';

export interface DatosRetencion {
  documentoId: string;
  impuesto: Impuesto;
  numeroComprobante: string;
  /** 'AAAA-MM-DD' */
  fechaComprobante: string;
  /** Bs: IVA sujeto (IVA; por omisión, todo el IVA del documento) o base imponible retenida (ISLR). */
  base?: string;
  porcentaje: string;
  /** Solo ISLR: lo que retuvo el cliente. En IVA lo calcula la base. */
  monto?: string;
  observaciones?: string;
}

const numero = (v: string | undefined, etiqueta: string, patron = MONTO): string => {
  const t = (v ?? '').trim().replace(',', '.');
  if (!patron.test(t) || new Decimal(t).lte(0)) throw new ErrorMaestro(`${etiqueta}: escriba un número mayor que cero, con hasta 2 decimales.`);
  return t;
};

export async function registrarRetencion(tx: Db, u: Usuario, d: DatosRetencion): Promise<{ id: string; numero: string; monto: string }> {
  if (d.impuesto !== 'iva' && d.impuesto !== 'islr') throw new ErrorMaestro('Seleccione el impuesto retenido.');
  const comprobante = d.numeroComprobante.trim();
  if (d.impuesto === 'iva' && !COMPROBANTE_IVA.test(comprobante)) {
    throw new ErrorMaestro('El número del comprobante de retención de IVA tiene 14 dígitos: año, mes y correlativo (por ejemplo 20261100000123).');
  }
  if (!comprobante) throw new ErrorMaestro('Indique el número del comprobante.');
  if (!FECHA.test(d.fechaComprobante)) throw new ErrorMaestro('Indique la fecha del comprobante.');
  const { rows: doc } = await tx.query<{ cliente_id: string; iva: string; tipo: string; numero: string | null; razon: string }>(
    `select d.cliente_id, d.iva::text, d.tipo, d.numero::text, t.razon_social as razon
       from documento_venta d join tercero t on t.id = d.cliente_id where d.id = $1`, [d.documentoId]);
  if (!doc[0]) throw new ErrorMaestro('Seleccione la factura o nota de débito retenida.');
  const porcentaje = numero(d.porcentaje, 'Porcentaje', PORCENTAJE);
  const base = d.impuesto === 'iva' && !d.base?.trim() ? doc[0].iva : numero(d.base, d.impuesto === 'iva' ? 'IVA sujeto a retención' : 'Base retenida');
  if (new Decimal(base).lte(0)) throw new ErrorMaestro('El documento no tiene IVA que retener.');
  const monto = d.impuesto === 'islr' ? numero(d.monto, 'ISLR retenido') : base;   // en IVA la base recalcula el monto

  const { rows } = await tx.query<{ id: string; numero: string; monto: string; usd: string; periodo: string }>(
    `insert into retencion_venta (impuesto, cliente_id, documento_id, partida_id, numero_comprobante, fecha_comprobante, periodo,
                                  base, porcentaje, monto, observaciones, created_by)
     values ($1, $2, $3, (select id from partida_cxc where documento_id = $3), $4, $5::date, date_trunc('month', $5::date)::date,
             $6, $7, $8, $9, $10)
     returning id, numero::text, monto::text, usd::text, periodo::text`,
    [d.impuesto, doc[0].cliente_id, d.documentoId, comprobante, d.fechaComprobante, base, porcentaje, monto, d.observaciones?.trim() || null, u.id]);
  const r = rows[0];
  const hoy = (await tx.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;
  const tipoDoc = doc[0].tipo === 'factura' ? 'factura' : 'nota de débito';
  // El asiento va con la fecha en que se recibe y registra el comprobante.
  await contabilizar(tx, {
    evento: d.impuesto === 'iva' ? 'retencion_venta_iva' : 'retencion_venta_islr', fecha: hoy,
    descripcion: `Retención de ${d.impuesto.toUpperCase()} del cliente · comprobante ${comprobante} · ${tipoDoc} ${doc[0].numero} · ${doc[0].razon}`,
    origen: { tipo: 'retencion_venta', id: r.id }, moneda: 'VES', importes: {},
    importesDobles: { monto: { ves: r.monto, usd: r.usd, original: r.monto } }, terceroId: doc[0].cliente_id, usuarioId: u.id,
  });
  return { id: r.id, numero: r.numero, monto: r.monto };
}

/** Anula una retención (no si su IVA ya se declaró): el documento recupera su saldo y el asiento se reversa. */
export async function anularRetencion(tx: Db, u: Usuario, id: string, motivo: string): Promise<void> {
  const texto = motivo.trim();
  if (texto.length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  const { rows } = await tx.query<{ estado: string }>('select estado from retencion_venta where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La retención no existe.');
  if (rows[0].estado !== 'registrada') throw new ErrorMaestro('La retención ya está anulada.');
  await tx.query(`update retencion_venta set estado = 'anulada', anulado_por = $2, anulado_motivo = $3 where id = $1`, [id, u.id, texto]);
  const { rows: a } = await tx.query<{ id: string }>(
    `select id from asiento where origen_tipo = 'retencion_venta' and origen_id = $1 and tipo = 'automatico'`, [id]);
  if (!a[0]) throw new ErrorMaestro('La retención no tiene asiento: avise al administrador.');
  await tx.query(`select fn_reversar_asiento($1, ((now() at time zone 'America/Caracas')::date), $2)`, [a[0].id, `Anulación de la retención recibida: ${texto}`]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaRetencion {
  id: string; numero: string; impuesto: Impuesto; cliente_id: string; cliente_codigo: string; rif: string; cliente: string;
  documento_id: string; documento_tipo: string; documento_numero: string; numero_control: string | null; documento_fecha: string;
  numero_comprobante: string; fecha_comprobante: string; periodo: string; base: string; porcentaje: string; monto: string; estado: string;
  anulado_motivo: string | null;
}

/** Retenciones recibidas. `periodo` 'AAAA-MM' filtra por el mes en que se declaran. */
export async function listarRetenciones(db: Db, filtro: { periodo?: string; impuesto?: string; clienteId?: string } = {}, limite = 300): Promise<FilaRetencion[]> {
  const periodo = filtro.periodo && /^\d{4}-\d{2}$/.test(filtro.periodo) ? `${filtro.periodo}-01` : null;
  const { rows } = await db.query<FilaRetencion>(
    `select id, numero::text, impuesto, cliente_id, cliente_codigo, rif, cliente, documento_id, documento_tipo, documento_numero::text,
            numero_control, to_char(documento_fecha, 'DD-MM-YYYY') as documento_fecha, numero_comprobante,
            to_char(fecha_comprobante, 'DD-MM-YYYY') as fecha_comprobante, to_char(periodo, 'MM-YYYY') as periodo,
            base::text, porcentaje::text, monto::text, estado, anulado_motivo
       from vw_retencion_venta
      where ($1::date is null or periodo = $1::date)
        and ($2 = '' or impuesto = $2)
        and ($3::uuid is null or cliente_id = $3)
      order by numero desc limit $4`, [periodo, filtro.impuesto ?? '', filtro.clienteId || null, limite]);
  return rows;
}

export interface DocumentoRetenible {
  id: string; etiqueta: string; iva: string; base: string; saldo: string; retenido_iva: boolean; retenido_islr: boolean;
}

/** Facturas y notas de débito emitidas del cliente con saldo por cobrar en bolívares, para registrarles la retención. */
export async function documentosRetenibles(db: Db, clienteId: string): Promise<DocumentoRetenible[]> {
  const { rows } = await db.query<DocumentoRetenible>(
    `select d.id, case d.tipo when 'factura' then 'Factura ' else 'Nota de débito ' end || d.numero::text || ' · '
              || to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as etiqueta,
            d.iva::text, (d.base_imponible + d.exento)::text as base, p.saldo::text,
            exists (select 1 from retencion_venta r where r.documento_id = d.id and r.impuesto = 'iva' and r.estado = 'registrada') as retenido_iva,
            exists (select 1 from retencion_venta r where r.documento_id = d.id and r.impuesto = 'islr' and r.estado = 'registrada') as retenido_islr
       from documento_venta d join partida_cxc p on p.documento_id = d.id
      where d.cliente_id = $1 and d.tipo in ('factura', 'nota_debito') and d.estado = 'emitido' and p.estado = 'abierta' and p.moneda = 'VES'
      order by d.fecha_emision`, [clienteId]);
  return rows;
}

/** Porcentajes de retención de IVA vigentes hoy (parámetros fiscales). */
export async function porcentajesIva(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ g: string; t: string }>(
    `select fn_parametro_fiscal('RET_IVA_GENERAL', ((now() at time zone 'America/Caracas')::date))::text as g,
            fn_parametro_fiscal('RET_IVA_TOTAL', ((now() at time zone 'America/Caracas')::date))::text as t`);
  return [rows[0].g, rows[0].t].map((v) => new Decimal(v).toFixed(2));
}
