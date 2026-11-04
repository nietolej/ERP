import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_VEN_COMPRAS, type Usuario } from './ordenes';

/**
 * Notas de crédito y de débito del proveedor y devolución de mercancía (spec §7.1, §7.2; migración 0039).
 *
 *   registrar (pendiente, no mueve nada) → Gerencia (distinta de quien la registró) aprueba → sale la mercancía devuelta, se ajusta el costo,
 *   se reduce la cuenta por pagar de la factura (o nace la de la nota de débito), se ajustan las retenciones y se contabiliza.
 *
 * La nota conserva la moneda y la tasa de la factura que corrige (R-CE): revierte exactamente lo que ella registró en bolívares y en USD.
 * Una nota de crédito no puede exceder el saldo por pagar de su factura.
 */

export const ROLES_REGISTRAN_NOTA_PROVEEDOR = ['compras', 'contabilidad', 'gerencia'] as const satisfies readonly Rol[];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const MONTO = /^\d{1,14}(\.\d{1,2})?$/;
const dos = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const cero = new Decimal(0);

export type TipoNota = 'nota_credito' | 'nota_debito';
export type ClaseNota = 'devolucion' | 'ajuste_precio';

export const NOMBRE_TIPO_NOTA: Record<TipoNota, string> = { nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito' };
export const NOMBRE_CLASE_NOTA: Record<ClaseNota, string> = { devolucion: 'Devolución de mercancía', ajuste_precio: 'Ajuste de precio' };
export const NOMBRE_ESTADO_NOTA: Record<string, string> = { pendiente: 'Pendiente de Gerencia', aprobada: 'Aprobada', rechazada: 'Rechazada' };

export interface LineaNotaEntrada {
  facturaLineaId: string;
  /** Devolución: unidades que se devuelven. */
  cantidad?: string;
  /** Ajuste de precio: monto sin IVA que se corrige, en la moneda de la factura. */
  monto?: string;
}

export interface DatosNota {
  facturaId: string;
  tipo: TipoNota;
  clase: ClaseNota;
  numeroDocumento: string;
  numeroControl: string;
  /** 'AAAA-MM-DD'; hoy o anterior, y no antes de la factura. */
  fecha: string;
  motivo: string;
  lineas: LineaNotaEntrada[];
}

interface FacturaBase { id: string; estado: string; proveedor_id: string; moneda: string; tasa: string; fecha_factura: string; orden_id: string; numero_factura: string }
interface LineaFactura { id: string; producto_id: string; descripcion: string; cantidad: string; precio_unitario: string; base: string; alicuota_pct: string }
interface Retenido { impuesto: 'iva' | 'islr'; base: string; monto: string; porcentaje: string; iva_total: boolean; tarifa_id: string | null }

async function facturaBloqueada(tx: Db, id: string): Promise<FacturaBase> {
  const { rows } = await tx.query<FacturaBase>(
    `select id, estado, proveedor_id, moneda, tasa::text, fecha_factura::text, orden_id, numero_factura from factura_compra where id = $1 for update`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La factura de compra no existe.');
  if (rows[0].estado !== 'contabilizada') throw new ErrorMaestro('Solo se corrige una factura de compra contabilizada.');
  return rows[0];
}

/** Conversión a USD con las tasas de la factura (mismo redondeo que el motor contable). */
async function convertidor(tx: Db, f: FacturaBase) {
  const { rows } = await tx.query<{ usd: string }>(`select fn_tasa('USD', $1::date)::text as usd`, [f.fecha_factura]);
  const tasaMon = new Decimal(f.tasa);
  const tasaUsd = new Decimal(rows[0].usd);
  const ves = (orig: Decimal.Value) => dos(new Decimal(orig).times(tasaMon));
  const enUsd = (orig: Decimal.Value): Decimal => (f.moneda === 'USD' ? dos(orig) : dos(ves(orig).dividedBy(tasaUsd)));
  const par = (orig: Decimal.Value) => ({ ves: ves(orig).toFixed(2), usd: enUsd(orig).toFixed(2), original: dos(orig).toFixed(2) });
  return { tasaMon, tasaUsd, ves, enUsd, par };
}

/** Retenciones que la factura practicó, para ajustarlas en proporción (R-CF). */
async function retenidoDe(tx: Db, facturaId: string): Promise<Retenido[]> {
  const { rows } = await tx.query<Retenido>(
    `select impuesto, base::text, monto::text, porcentaje::text, iva_total, tarifa_id from retencion_compra where factura_id = $1`, [facturaId]);
  return rows;
}

/**
 * Retención que ajusta una nota: la de la factura en proporción a lo que la nota corrige (IVA con el IVA de la nota; ISLR con su base).
 * Una nota de crédito nunca revierte más de lo que queda retenido por enterar de esa factura.
 */
async function ajusteRetenciones(
  tx: Db, f: FacturaBase, nota: { tipo: TipoNota; iva: Decimal.Value; baseSinIva: Decimal.Value; excluirNota?: string },
): Promise<{ iva: Decimal; islr: Decimal; filas: (Retenido & { monto_nota: Decimal; base_nota: Decimal })[] }> {
  const orig = await retenidoDe(tx, f.id);
  let iva = cero, islr = cero;
  const filas: (Retenido & { monto_nota: Decimal; base_nota: Decimal })[] = [];
  for (const r of orig) {
    const baseNota = new Decimal(r.impuesto === 'iva' ? nota.iva : nota.baseSinIva);
    if (baseNota.lte(0) || new Decimal(r.base).lte(0)) continue;
    let monto = dos(new Decimal(r.monto).times(baseNota).dividedBy(r.base));
    if (nota.tipo === 'nota_credito') {
      const { rows } = await tx.query<{ revertido: string }>(
        `select coalesce(sum(r.monto * r.signo), 0)::text as revertido from retencion_compra r join nota_proveedor n on n.id = r.nota_id
          where n.factura_id = $1 and r.impuesto = $2 and ($3::uuid is null or n.id <> $3)`, [f.id, r.impuesto, nota.excluirNota ?? null]);
      const disponible = new Decimal(r.monto).plus(rows[0].revertido);
      monto = Decimal.min(monto, Decimal.max(disponible, cero));
    }
    if (monto.lte(0)) continue;
    filas.push({ ...r, monto_nota: monto, base_nota: baseNota });
    if (r.impuesto === 'iva') iva = iva.plus(monto); else islr = islr.plus(monto);
  }
  return { iva, islr, filas };
}

async function saldoDeFactura(tx: Db, facturaId: string, bloquear = false) {
  const { rows } = await tx.query<{ id: string; saldo: string; saldo_ves: string; saldo_usd: string; estado: string }>(
    `select id, saldo::text, saldo_ves::text, saldo_usd::text, estado from partida_cxp where factura_id = $1 ${bloquear ? 'for update' : ''}`, [facturaId]);
  return rows[0];
}

/** Registra una nota pendiente de Gerencia: valida contra la factura y lo ya corregido; no mueve nada. */
export async function crearNota(tx: Db, u: Usuario, d: DatosNota): Promise<{ id: string; numero: string }> {
  if (!['nota_credito', 'nota_debito'].includes(d.tipo)) throw new ErrorMaestro('Seleccione el tipo de nota.');
  if (!['devolucion', 'ajuste_precio'].includes(d.clase)) throw new ErrorMaestro('Seleccione la clase de nota.');
  if (d.tipo === 'nota_debito' && d.clase === 'devolucion') throw new ErrorMaestro('Una nota de débito solo ajusta precio.');
  const documento = d.numeroDocumento.trim();
  const control = d.numeroControl.trim();
  if (!documento || documento.length > 40) throw new ErrorMaestro('Indique el número de la nota del proveedor (hasta 40 caracteres).');
  if (!control || control.length > 40) throw new ErrorMaestro('Indique el número de control de la nota del proveedor.');
  if (!FECHA.test(d.fecha)) throw new ErrorMaestro('Indique la fecha de la nota.');
  if (d.motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la nota.');
  if (!d.lineas.length) throw new ErrorMaestro('Indique al menos una línea de la factura.');
  if (new Set(d.lineas.map((l) => l.facturaLineaId)).size !== d.lineas.length) throw new ErrorMaestro('Una línea de la factura no puede aparecer dos veces.');

  const f = await facturaBloqueada(tx, d.facturaId);
  const { rows: lf } = await tx.query<LineaFactura>(
    `select id, producto_id, descripcion, cantidad::text, precio_unitario::text, base::text, alicuota_pct::text from factura_compra_linea where factura_id = $1`, [f.id]);
  const { rows: previas } = await tx.query<{ linea: string; cantidad: string; base: string }>(
    `select l.factura_linea_id as linea, coalesce(sum(case when n.clase = 'devolucion' then l.cantidad else 0 end), 0)::text as cantidad,
            coalesce(sum(l.base), 0)::text as base
       from nota_proveedor_linea l join nota_proveedor n on n.id = l.nota_id
      where n.factura_id = $1 and n.tipo = 'nota_credito' and n.estado in ('pendiente', 'aprobada') group by l.factura_linea_id`, [f.id]);

  const lineas = d.lineas.map((e, i) => {
    const l = lf.find((x) => x.id === e.facturaLineaId);
    if (!l) throw new ErrorMaestro('Alguna línea no pertenece a la factura.');
    const prev = previas.find((p) => p.linea === l.id);
    const yaBase = new Decimal(prev?.base ?? 0);
    let base: Decimal;
    let cantidad: string | null = null;
    if (d.clase === 'devolucion') {
      const c = (e.cantidad ?? '').trim();
      if (!CANTIDAD.test(c) || new Decimal(c).lte(0)) throw new ErrorMaestro('La cantidad devuelta debe ser un número mayor que cero, con hasta 4 decimales.');
      const restante = new Decimal(l.cantidad).minus(prev?.cantidad ?? 0);
      if (new Decimal(c).gt(restante)) throw new ErrorMaestro(`De ${l.descripcion} solo se pueden devolver ${restante.toString()} unidades (facturadas ${l.cantidad}, ya corregidas ${prev?.cantidad ?? '0'}).`);
      cantidad = new Decimal(c).toString();
      base = Decimal.min(dos(new Decimal(c).times(l.precio_unitario)), new Decimal(l.base).minus(yaBase));
    } else {
      const m = (e.monto ?? '').trim().replace(',', '.');
      if (!MONTO.test(m) || new Decimal(m).lte(0)) throw new ErrorMaestro('El monto del ajuste debe ser mayor que cero, con hasta 2 decimales.');
      base = new Decimal(m);
      if (d.tipo === 'nota_credito' && base.gt(new Decimal(l.base).minus(yaBase))) {
        throw new ErrorMaestro(`El crédito de ${l.descripcion} no puede pasar de ${new Decimal(l.base).minus(yaBase).toFixed(2)} (lo facturado menos lo ya acreditado).`);
      }
    }
    if (base.lte(0)) throw new ErrorMaestro(`${l.descripcion} ya está acreditada por completo.`);
    return { linea: i + 1, l, cantidad, base, pct: new Decimal(l.alicuota_pct), iva: dos(base.times(l.alicuota_pct).dividedBy(100)) };
  });

  const gravado = lineas.filter((x) => x.pct.gt(0)).reduce((s, x) => s.plus(x.base), cero);
  const exento = lineas.filter((x) => x.pct.lte(0)).reduce((s, x) => s.plus(x.base), cero);
  const iva = lineas.reduce((s, x) => s.plus(x.iva), cero);
  const total = gravado.plus(exento).plus(iva);
  const conv = await convertidor(tx, f);
  const totalUsd = conv.enUsd(total);

  if (d.tipo === 'nota_credito') {
    const r = await ajusteRetenciones(tx, f, { tipo: d.tipo, iva, baseSinIva: gravado.plus(exento) });
    const neto = total.minus(r.iva).minus(r.islr);
    const p = await saldoDeFactura(tx, f.id);
    if (!p || p.estado !== 'abierta' || neto.gt(p.saldo)) {
      throw new ErrorMaestro(`La nota (${f.moneda} ${neto.toFixed(2)} netos) excede el saldo por pagar de la factura (${f.moneda} ${p?.saldo ?? '0.00'}). Si ya se pagó, el reembolso del proveedor no está construido todavía.`);
    }
  }

  const { rows } = await tx.query<{ id: string; numero: string }>(
    `insert into nota_proveedor (tipo, clase, factura_id, proveedor_id, numero_documento, numero_control, fecha, motivo, moneda, tasa,
                                 base_imponible, exento, iva, total, total_usd, created_by)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id, numero::text`,
    [d.tipo, d.clase, f.id, f.proveedor_id, documento, control, d.fecha, d.motivo.trim(), f.moneda, f.tasa, gravado.toFixed(2), exento.toFixed(2),
     iva.toFixed(2), total.toFixed(2), totalUsd.toFixed(2), u.id]);
  for (const x of lineas) {
    await tx.query(
      `insert into nota_proveedor_linea (nota_id, linea, factura_linea_id, producto_id, descripcion, cantidad, base, alicuota_pct, iva)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [rows[0].id, x.linea, x.l.id, x.l.producto_id, x.l.descripcion, x.cantidad, x.base.toFixed(2), x.pct.toFixed(2), x.iva.toFixed(2)]);
  }
  await solicitarAprobacion(tx, { tipo: 'nota_proveedor', objetoId: rows[0].id, solicitanteId: u.id, contexto: { valor_usd: totalUsd.toNumber() } });
  return rows[0];
}

export interface ResultadoNota { asiento: string }

/**
 * Lo llama el motor de flujo cuando Gerencia aprueba la nota: la marca aprobada (la base exige que apruebe Gerencia y no quien la registró),
 * y en la misma transacción mueve inventario y costo, ajusta la cuenta por pagar y las retenciones, y genera el asiento.
 */
export async function aprobarNota(tx: Db, id: string, aprobador: string): Promise<ResultadoNota> {
  const { rows } = await tx.query<{
    estado: string; tipo: TipoNota; clase: ClaseNota; factura_id: string; proveedor_id: string; fecha: string; numero: string; numero_documento: string;
    base_imponible: string; exento: string; iva: string; total: string;
  }>(
    `select estado, tipo, clase, factura_id, proveedor_id, fecha::text, numero::text, numero_documento, base_imponible::text, exento::text, iva::text, total::text
       from nota_proveedor where id = $1 for update`, [id]);
  const n = rows[0];
  if (!n) throw new ErrorMaestro('La nota no existe.');
  if (n.estado !== 'pendiente') throw new ErrorMaestro('La nota no está pendiente de aprobación.');
  await tx.query(`update nota_proveedor set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, aprobador]);

  const f = await facturaBloqueada(tx, n.factura_id);
  const conv = await convertidor(tx, f);
  const { rows: lineas } = await tx.query<{ producto_id: string; cantidad: string | null; base: string; cant_factura: string }>(
    `select l.producto_id, l.cantidad::text, l.base::text, fl.cantidad::text as cant_factura
       from nota_proveedor_linea l join factura_compra_linea fl on fl.id = l.factura_linea_id where l.nota_id = $1 order by l.linea`, [id]);
  const credito = n.tipo === 'nota_credito';
  const baseSinIva = new Decimal(n.base_imponible).plus(n.exento);
  const total = new Decimal(n.total);

  // Retenciones que ajusta la nota (R-CF).
  const ret = await ajusteRetenciones(tx, f, { tipo: n.tipo, iva: n.iva, baseSinIva, excluirNota: id });
  for (const r of ret.filas) {
    await tx.query(
      `insert into retencion_compra (nota_id, proveedor_id, impuesto, fecha, moneda, tasa, base, porcentaje, sustraendo, monto, monto_usd, iva_total, tarifa_id, signo)
       values ($1, $2, $3, $4::date, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13)`,
      [id, n.proveedor_id, r.impuesto, n.fecha, f.moneda, f.tasa, r.base_nota.toFixed(2), r.porcentaje, r.monto_nota.toFixed(2), conv.enUsd(r.monto_nota).toFixed(2),
       r.iva_total, r.tarifa_id, credito ? -1 : 1]);
  }
  const neto = total.minus(ret.iva).minus(ret.islr);

  // Inventario y costo.
  const { rows: alm } = await tx.query<{ almacen_id: string }>('select almacen_id from documento_compra where id = $1', [f.orden_id]);
  let invMon = cero, invUsd = cero;                       // lo que se acredita (devolución) o ajusta (precio) del inventario, en la moneda y en USD
  let cvHaber = cero, cvDebe = cero;                      // diferencia contra el costo de ventas
  if (n.clase === 'devolucion') {
    for (const l of lineas) {
      const { rows: m } = await tx.query<{ costo: string }>(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
         values ('devolucion_proveedor', $1, $2, $3, 0, 'nota_proveedor', $4, $5) returning abs(costo_total_usd)::text as costo`,
        [l.producto_id, alm[0].almacen_id, new Decimal(l.cantidad ?? 0).negated().toString(), id, aprobador]);
      invUsd = invUsd.plus(m[0].costo);
    }
    invMon = f.moneda === 'USD' ? invUsd : dos(dos(invUsd.times(conv.tasaUsd)).dividedBy(conv.tasaMon));
    const dif = baseSinIva.minus(invMon);
    if (dif.gte(0)) cvHaber = dif; else cvDebe = dif.negated();
  } else {
    // Ajuste de precio: lo que corresponde a las unidades que siguen en existencia ajusta el costo del inventario; el resto, el costo de ventas.
    const ajustes: { productoId: string; usd: Decimal }[] = [];
    let invTotalMon = cero;
    for (const l of lineas) {
      const { rows: st } = await tx.query<{ q: string }>('select coalesce((select cantidad from producto_costo where producto_id = $1), 0)::text as q', [l.producto_id]);
      const enStock = Decimal.min(l.cant_factura, st[0].q);
      const inv = dos(new Decimal(l.base).times(enStock).dividedBy(l.cant_factura));
      invTotalMon = invTotalMon.plus(inv);
      if (inv.gt(0)) ajustes.push({ productoId: l.producto_id, usd: conv.enUsd(inv).times(credito ? -1 : 1) });
    }
    // El inventario en USD debe sumar lo mismo que el asiento: el residuo de redondeo va a la línea mayor.
    const objetivo = conv.enUsd(invTotalMon).times(credito ? -1 : 1);
    const actual = ajustes.reduce((s, a) => s.plus(a.usd), cero);
    if (ajustes.length && !objetivo.equals(actual)) {
      const mayor = ajustes.reduce((m, a) => (a.usd.abs().gt(m.usd.abs()) ? a : m));
      mayor.usd = mayor.usd.plus(objetivo.minus(actual));
    }
    for (const a of ajustes) {
      if (a.usd.isZero()) continue;
      await tx.query(
        `insert into ajuste_costo (producto_id, valor_usd, origen_tipo, origen_id, created_by) values ($1, $2, 'nota_proveedor', $3, $4)`,
        [a.productoId, a.usd.toFixed(2), id, aprobador]);
    }
    invMon = invTotalMon;
    invUsd = ajustes.reduce((s, a) => s.plus(a.usd.abs()), cero);
    cvHaber = baseSinIva.minus(invMon);                   // se usa como "costo de ventas" en ambos tipos
  }

  // Cuenta por pagar.
  const previo = coalesce(await tx.query<{ v: string | null }>(`select current_setting('app.cxp_interno', true) as v`));
  let cxp = conv.par(neto);
  if (credito) {
    const p = await saldoDeFactura(tx, f.id, true);
    if (!p || p.estado !== 'abierta' || neto.gt(p.saldo)) {
      throw new ErrorMaestro(`La nota (${f.moneda} ${neto.toFixed(2)} netos) excede el saldo por pagar de la factura (${f.moneda} ${p?.saldo ?? '0.00'}).`);
    }
    const todo = neto.equals(p.saldo);
    const vesParte = todo ? new Decimal(p.saldo_ves) : dos(new Decimal(p.saldo_ves).times(neto).dividedBy(p.saldo));
    const usdParte = todo ? new Decimal(p.saldo_usd) : dos(new Decimal(p.saldo_usd).times(neto).dividedBy(p.saldo));
    await tx.query(`select set_config('app.cxp_interno', '1', true)`);
    await tx.query(
      `update partida_cxp set saldo = saldo - $2, saldo_ves = saldo_ves - $3, saldo_usd = saldo_usd - $4,
              estado = case when saldo - $2 = 0 then 'cancelada' else 'abierta' end where id = $1`,
      [p.id, neto.toFixed(2), vesParte.toFixed(2), usdParte.toFixed(2)]);
    await tx.query(`select set_config('app.cxp_interno', $1, true)`, [previo]);
    cxp = { ves: vesParte.toFixed(2), usd: usdParte.toFixed(2), original: neto.toFixed(2) };
  } else {
    await tx.query(
      `insert into partida_cxp (proveedor_id, nota_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
       select $1, $2, $3::date, $3::date + coalesce(cp.dias, 0), $4, $5, $6, $7, $6
         from proveedor p left join condicion_pago cp on cp.id = p.condicion_pago_id where p.tercero_id = $1`,
      [n.proveedor_id, id, n.fecha, f.moneda, f.tasa, neto.toFixed(2), conv.enUsd(neto).toFixed(2)]);
  }

  const par = conv.par;
  const invImporte = { ves: conv.ves(invMon).toFixed(2), usd: invUsd.toFixed(2), original: invMon.toFixed(2) };
  const importesDobles: Record<string, { ves: string; usd: string; original?: string }> = credito
    ? {
      cxp, ret_iva: par(ret.iva), ret_islr: par(ret.islr), cv_debe: par(cvDebe), cv_haber: par(cvHaber), inventario: invImporte, iva: par(n.iva),
    }
    : {
      neto: par(neto), ret_iva: par(ret.iva), ret_islr: par(ret.islr), costo_ventas: par(cvHaber), inventario: invImporte, iva: par(n.iva),
    };
  const r = await contabilizar(tx, {
    evento: credito ? 'nota_credito_proveedor' : 'nota_debito_proveedor', fecha: n.fecha,
    descripcion: `${NOMBRE_TIPO_NOTA[n.tipo]} del proveedor ${n.numero_documento} · factura ${f.numero_factura}`,
    origen: { tipo: 'nota_proveedor', id }, moneda: f.moneda, importes: {}, importesDobles, terceroId: n.proveedor_id, usuarioId: aprobador,
  });
  return { asiento: r.numero };
}

/** Pequeña ayuda: el valor previo de un parámetro de sesión (vacío si no estaba). */
function coalesce(r: { rows: { v: string | null }[] }): string {
  return r.rows[0]?.v ?? '';
}

/** Lo llama el motor de flujo cuando Gerencia rechaza la nota: no mueve nada. */
export async function rechazarNota(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from nota_proveedor where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La nota no existe.');
  if (rows[0].estado !== 'pendiente') throw new ErrorMaestro('La nota no está pendiente de aprobación.');
  await tx.query(`update nota_proveedor set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

const puedeVer = (u: Usuario) => u.roles.some((r) => (ROLES_VEN_COMPRAS as readonly string[]).includes(r));

export interface FilaNota {
  id: string; numero: string; tipo: TipoNota; clase: ClaseNota; numero_documento: string; proveedor: string; factura: string; factura_id: string;
  fecha: string; moneda: string; total: string; estado: string;
}

export async function buscarNotas(db: Db, u: Usuario, filtro: { estado?: string; texto?: string; facturaId?: string } = {}, limite = 100): Promise<FilaNota[]> {
  if (!puedeVer(u)) return [];
  const { rows } = await db.query<FilaNota>(
    `select n.id, n.numero::text, n.tipo, n.clase, n.numero_documento, p.codigo || ' · ' || t.razon_social as proveedor, f.numero_factura as factura,
            n.factura_id, n.fecha::text, n.moneda, n.total::text, n.estado
       from nota_proveedor n join factura_compra f on f.id = n.factura_id
       join proveedor p on p.tercero_id = n.proveedor_id join tercero t on t.id = n.proveedor_id
      where ($1 = '' or n.estado = $1) and ($3::uuid is null or n.factura_id = $3)
        and ($2 = '' or upper(n.numero_documento) like '%' || upper($2) || '%' or upper(f.numero_factura) like '%' || upper($2) || '%'
             or p.codigo ilike '%' || $2 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($2) || '%')
      order by n.created_at desc limit $4`, [filtro.estado ?? '', (filtro.texto ?? '').trim(), filtro.facturaId ?? null, limite]);
  return rows;
}

export interface LineaNotaDetalle {
  linea: number; codigo: string; descripcion: string; cantidad: string | null; base: string; alicuota_pct: string; iva: string;
}
export interface DetalleNota extends FilaNota {
  proveedor_id: string; numero_control: string; motivo: string; tasa: string; base_imponible: string; exento: string; iva: string; total_usd: string;
  creador_id: string; creador: string; creado: string; aprobado_por: string | null; aprobado: string | null; rechazo_motivo: string | null;
  asiento: string | null; lineas: LineaNotaDetalle[]; saldo_factura: string | null;
}

export async function detalleNota(db: Db, id: string): Promise<DetalleNota | null> {
  const { rows } = await db.query<Omit<DetalleNota, 'lineas' | 'saldo_factura'>>(
    `select n.id, n.numero::text, n.tipo, n.clase, n.numero_documento, p.codigo || ' · ' || t.razon_social as proveedor, f.numero_factura as factura,
            n.factura_id, n.fecha::text, n.moneda, n.total::text, n.estado, n.proveedor_id, n.numero_control, n.motivo, n.tasa::text,
            n.base_imponible::text, n.exento::text, n.iva::text, n.total_usd::text, n.created_by as creador_id, cr.nombre as creador,
            to_char(n.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creado, ap.nombre as aprobado_por,
            to_char(n.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado, n.rechazo_motivo, a.numero::text as asiento
       from nota_proveedor n join factura_compra f on f.id = n.factura_id
       join proveedor p on p.tercero_id = n.proveedor_id join tercero t on t.id = n.proveedor_id
       join usuario cr on cr.id = n.created_by left join usuario ap on ap.id = n.aprobado_por
       left join asiento a on a.origen_tipo = 'nota_proveedor' and a.origen_id = n.id and a.tipo = 'automatico'
      where n.id = $1`, [id]);
  if (!rows[0]) return null;
  const [lineas, saldo] = await Promise.all([
    db.query<LineaNotaDetalle>(
      `select l.linea, p.codigo, l.descripcion, l.cantidad::text, l.base::text, l.alicuota_pct::text, l.iva::text
         from nota_proveedor_linea l join producto p on p.id = l.producto_id where l.nota_id = $1 order by l.linea`, [id]),
    db.query<{ saldo: string }>('select saldo::text from partida_cxp where factura_id = $1', [rows[0].factura_id]),
  ]);
  return { ...rows[0], lineas: lineas.rows, saldo_factura: saldo.rows[0]?.saldo ?? null };
}

export interface LineaCorregible {
  id: string; codigo: string; descripcion: string; cantidad: string; precio_unitario: string; base: string; devuelto: string; acreditado: string;
}

/** Líneas de una factura con lo ya devuelto y acreditado (notas de crédito pendientes o aprobadas), para armar una nota nueva. */
export async function lineasCorregibles(db: Db, facturaId: string): Promise<LineaCorregible[]> {
  const { rows } = await db.query<LineaCorregible>(
    `select l.id, p.codigo, l.descripcion, l.cantidad::text, l.precio_unitario::text, l.base::text,
            coalesce(x.devuelto, 0)::text as devuelto, coalesce(x.acreditado, 0)::text as acreditado
       from factura_compra_linea l join producto p on p.id = l.producto_id
       left join lateral (select sum(case when n.clase = 'devolucion' then nl.cantidad else 0 end) as devuelto, sum(nl.base) as acreditado
                            from nota_proveedor_linea nl join nota_proveedor n on n.id = nl.nota_id
                           where nl.factura_linea_id = l.id and n.tipo = 'nota_credito' and n.estado in ('pendiente', 'aprobada')) x on true
      where l.factura_id = $1 order by l.linea`, [facturaId]);
  return rows;
}
