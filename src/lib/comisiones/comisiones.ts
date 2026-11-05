import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar, tasasDelDia } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Comisiones de venta con base cobrada (spec §9; migración 0053; decisión 6).
 *
 *   Plan: reglas por grupo de producto y marca (la más específica gana), con porcentaje. Lo aprueba Gerencia. Cada vendedor comercial tiene el plan
 *         que se le asigna por fechas; cuenta el vigente en la fecha de la factura.
 *   Devengo: al aplicar un cobro a una factura. Base = lo cobrado sin IVA ni IGTF (USD a la tasa de la factura), repartida entre las líneas de la factura
 *         según su base; cada línea toma el porcentaje de su regla.
 *   Reversión: al emitir una nota de crédito sobre la factura (proporcional a lo ya devengado) o al anular el cobro. Se revierte al mismo valor en VES
 *         del devengo, así que no genera diferencial cambiario.
 *   Liquidación mensual por vendedor → aprobación de Gerencia (no el beneficiario) → pago de Tesorería. Un vendedor externo necesita retención de ISLR
 *         sobre su comisión: hasta que ese cálculo exista, su pago se bloquea en lugar de pagarse sin retener.
 */

export const ROLES_PLANES = ['gerencia', 'supervisor_ventas'] as const satisfies readonly Rol[];
export const ROLES_LIQUIDAN = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_PAGAN_COMISIONES = ['tesoreria', 'gerencia'] as const satisfies readonly Rol[];
/** Ven todo el estado de comisiones. Un vendedor (rol Ventas) ve solo el suyo. */
export const ROLES_VEN_TODO_COMISIONES = ['gerencia', 'supervisor_ventas', 'contabilidad', 'jefe_contabilidad', 'tesoreria', 'auditor'] as const satisfies readonly Rol[];
export const ROLES_VEN_COMISIONES = [...ROLES_VEN_TODO_COMISIONES, 'ventas'] as const satisfies readonly Rol[];

export type UsuarioCom = { id: string; roles: readonly string[] };
const tiene = (u: UsuarioCom, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));
const exigir = (u: UsuarioCom, roles: readonly string[], texto: string) => { if (!tiene(u, roles)) throw new ErrorMaestro(texto); };

const dos = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;

const hoyCaracas = async (db: Db) => (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;

// ---------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------

export interface ReglaEntrada { grupoId?: string; marcaId?: string; porcentaje: string }

/** Las reglas se ordenan de la más específica a la más general: grupo y marca, solo grupo, solo marca, y la regla general. */
export function ordenarReglas(reglas: ReglaEntrada[]): ReglaEntrada[] {
  const peso = (r: ReglaEntrada) => (r.grupoId && r.marcaId ? 0 : r.grupoId ? 1 : r.marcaId ? 2 : 3);
  return [...reglas].sort((a, b) => peso(a) - peso(b));
}

export async function crearPlan(tx: Db, u: UsuarioCom, d: { nombre: string; reglas: ReglaEntrada[] }): Promise<string> {
  exigir(u, ROLES_PLANES, 'Solo Gerencia o el Supervisor de ventas crean planes de comisión.');
  const nombre = d.nombre.trim();
  if (nombre.length < 3) throw new ErrorMaestro('Indique el nombre del plan.');
  if (!d.reglas.length) throw new ErrorMaestro('Agregue al menos una regla.');
  const vistas = new Set<string>();
  for (const r of d.reglas) {
    if (!PORCENTAJE.test(r.porcentaje.trim()) || new Decimal(r.porcentaje).gt(100)) throw new ErrorMaestro('El porcentaje de cada regla debe estar entre 0 y 100, con hasta 2 decimales.');
    if ((r.grupoId && !UUID.test(r.grupoId)) || (r.marcaId && !UUID.test(r.marcaId))) throw new ErrorMaestro('Grupo o marca inválidos.');
    const clave = `${r.grupoId ?? ''}|${r.marcaId ?? ''}`;
    if (vistas.has(clave)) throw new ErrorMaestro('Dos reglas tienen el mismo grupo y la misma marca: la segunda nunca se aplicaría.');
    vistas.add(clave);
  }
  const { rows } = await tx.query<{ id: string }>('insert into plan_comision (nombre, creado_por) values ($1, $2) returning id', [nombre, u.id]);
  let prioridad = 0;
  for (const r of ordenarReglas(d.reglas)) {
    await tx.query(
      'insert into plan_comision_regla (plan_id, prioridad, grupo_producto_id, marca_id, porcentaje) values ($1, $2, $3, $4, $5)',
      [rows[0].id, ++prioridad, r.grupoId || null, r.marcaId || null, r.porcentaje.trim()]);
  }
  return rows[0].id;
}

/** Quien creó el plan lo envía a Gerencia. */
export async function enviarPlan(tx: Db, u: UsuarioCom, id: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string; creado_por: string }>('select estado, creado_por from plan_comision where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El plan no existe.');
  if (rows[0].creado_por !== u.id) throw new ErrorMaestro('Solo quien creó el plan lo envía a aprobación.');
  if (rows[0].estado !== 'borrador') throw new ErrorMaestro('El plan ya fue enviado.');
  await tx.query(`update plan_comision set estado = 'pendiente' where id = $1`, [id]);
  await solicitarAprobacion(tx, { tipo: 'plan_comision', objetoId: id, solicitanteId: u.id });
}

/** Los llama el motor de aprobaciones. */
export async function aprobarPlan(tx: Db, id: string, aprobador: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from plan_comision where id = $1 for update', [id]);
  if (rows[0]?.estado !== 'pendiente') throw new ErrorMaestro('El plan no está pendiente de aprobación.');
  await tx.query(`update plan_comision set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id, aprobador]);
}
export async function rechazarPlan(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from plan_comision where id = $1 for update', [id]);
  if (rows[0]?.estado !== 'pendiente') throw new ErrorMaestro('El plan no está pendiente de aprobación.');
  await tx.query(`update plan_comision set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

/** Asigna un plan aprobado a un vendedor desde una fecha; cierra la asignación anterior el día previo. */
export async function asignarPlan(tx: Db, u: UsuarioCom, d: { vendedorId: string; planId: string; desde: string }): Promise<void> {
  exigir(u, ROLES_PLANES, 'Solo Gerencia o el Supervisor de ventas asignan planes de comisión.');
  if (!UUID.test(d.vendedorId) || !UUID.test(d.planId)) throw new ErrorMaestro('Seleccione el vendedor y el plan.');
  if (!FECHA.test(d.desde)) throw new ErrorMaestro('Indique desde cuándo rige el plan.');
  await tx.query(
    `update vendedor_plan set vigente_hasta = $2::date - 1 where vendedor_id = $1 and vigente_hasta is null and vigente_desde < $2::date`, [d.vendedorId, d.desde]);
  await tx.query('insert into vendedor_plan (vendedor_id, plan_id, vigente_desde, asignado_por) values ($1, $2, $3::date, $4)', [d.vendedorId, d.planId, d.desde, u.id]);
}

export interface FilaPlan { id: string; nombre: string; estado: string; reglas: number; creador: string; vendedores: number }
export async function listarPlanes(db: Db): Promise<FilaPlan[]> {
  const { rows } = await db.query<FilaPlan>(
    `select p.id, p.nombre, p.estado, (select count(*)::int from plan_comision_regla r where r.plan_id = p.id) as reglas, u.nombre as creador,
            (select count(*)::int from vendedor_plan vp where vp.plan_id = p.id and vp.vigente_hasta is null) as vendedores
       from plan_comision p join usuario u on u.id = p.creado_por order by p.created_at desc`);
  return rows;
}

export interface DetallePlan {
  plan: { id: string; nombre: string; estado: string; creador: string; creado_por: string; rechazo_motivo: string | null; aprobador: string | null };
  reglas: { prioridad: number; grupo: string | null; marca: string | null; porcentaje: string }[];
}
export async function detallePlan(db: Db, id: string): Promise<DetallePlan | null> {
  const { rows } = await db.query<DetallePlan['plan']>(
    `select p.id, p.nombre, p.estado, u.nombre as creador, p.creado_por, p.rechazo_motivo, a.nombre as aprobador
       from plan_comision p join usuario u on u.id = p.creado_por left join usuario a on a.id = p.aprobado_por where p.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: reglas } = await db.query<DetallePlan['reglas'][number]>(
    `select r.prioridad, g.nombre as grupo, m.nombre as marca, r.porcentaje::text from plan_comision_regla r
       left join grupo_producto g on g.id = r.grupo_producto_id left join marca m on m.id = r.marca_id where r.plan_id = $1 order by r.prioridad`, [id]);
  return { plan: rows[0], reglas };
}

export interface FilaAsignacion { id: string; vendedor: string; codigo: string; plan: string; desde: string; hasta: string | null }
export async function asignaciones(db: Db): Promise<FilaAsignacion[]> {
  const { rows } = await db.query<FilaAsignacion>(
    `select vp.id, v.nombre as vendedor, v.codigo, p.nombre as plan, vp.vigente_desde::text as desde, vp.vigente_hasta::text as hasta
       from vendedor_plan vp join vendedor v on v.id = vp.vendedor_id join plan_comision p on p.id = vp.plan_id order by v.codigo, vp.vigente_desde desc`);
  return rows;
}

// ---------------------------------------------------------------------
// Cálculo (puro)
// ---------------------------------------------------------------------

export interface LineaFactura { baseUsd: Decimal; grupoId: string | null; marcaId: string | null; grupo: string; marca: string }
export interface ReglaPlan { grupoId: string | null; marcaId: string | null; porcentaje: Decimal }
export interface DetalleCalculo { grupo: string; marca: string; baseUsd: string; porcentaje: string; montoUsd: string }

/** La regla de una línea: la primera, por prioridad, cuyo grupo y marca coinciden (o están vacíos). */
export function reglaDe(l: { grupoId: string | null; marcaId: string | null }, reglas: ReglaPlan[]): ReglaPlan | null {
  return reglas.find((r) => (r.grupoId === null || r.grupoId === l.grupoId) && (r.marcaId === null || r.marcaId === l.marcaId)) ?? null;
}

/**
 * Comisión de lo cobrado de una factura: la base cobrada se reparte entre las líneas según su base y cada una toma el porcentaje de su regla.
 * `reglas` viene en orden de prioridad. Una línea sin regla no comisiona.
 */
export function calcularComision(baseCobrada: Decimal, lineas: LineaFactura[], reglas: ReglaPlan[]): { monto: Decimal; porcentaje: string; detalle: DetalleCalculo[] } {
  const total = lineas.reduce((s, l) => s.plus(l.baseUsd), new Decimal(0));
  if (total.lte(0) || baseCobrada.lte(0)) return { monto: new Decimal(0), porcentaje: '0.0000', detalle: [] };
  let suma = new Decimal(0);
  const detalle: DetalleCalculo[] = [];
  for (const l of lineas) {
    const parte = baseCobrada.times(l.baseUsd).dividedBy(total);
    const r = reglaDe(l, reglas);
    const monto = r ? parte.times(r.porcentaje).dividedBy(100) : new Decimal(0);
    suma = suma.plus(monto);
    detalle.push({ grupo: l.grupo, marca: l.marca, baseUsd: dos(parte).toFixed(2), porcentaje: (r?.porcentaje ?? new Decimal(0)).toFixed(2), montoUsd: dos(monto).toFixed(2) });
  }
  const monto = dos(suma);
  return { monto, porcentaje: monto.dividedBy(baseCobrada).times(100).toFixed(4), detalle };
}

// ---------------------------------------------------------------------
// Devengo y reversión
// ---------------------------------------------------------------------

async function vesDeComisionesPorPagar(tx: Db, asientoId: string): Promise<Decimal> {
  const { rows } = await tx.query<{ v: string }>(
    `select coalesce(sum(l.haber_ves - l.debe_ves), 0)::text as v from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id where l.asiento_id = $1 and c.codigo = '2.1.07'`, [asientoId]);
  return new Decimal(rows[0].v);
}

/** Devenga la comisión de cada aplicación de cobro a una factura. Idempotente: una aplicación devenga una sola vez. Devuelve cuántas devengó. */
export async function devengarAplicaciones(tx: Db, u: { id: string }, aplicacionIds: string[]): Promise<number> {
  let n = 0;
  for (const id of aplicacionIds) {
    const { rows } = await tx.query<{
      fecha: string; usd_partida: string; factura_id: string; vendedor_id: string | null; vtipo: string | null; apertura: boolean; fecha_factura: string; numero: string; serie: string;
    }>(
      `select a.fecha::text, a.usd_partida::text, d.id as factura_id, d.vendedor_id, v.tipo as vtipo, d.apertura,
              ((d.fecha_emision at time zone 'America/Caracas')::date)::text as fecha_factura, d.numero::text, d.serie
         from aplicacion_cobro a join partida_cxc p on p.id = a.partida_id join documento_venta d on d.id = p.documento_id left join vendedor v on v.id = d.vendedor_id
        where a.id = $1 and not a.revertida`, [id]);
    const a = rows[0];
    if (!a || a.apertura || !a.vendedor_id || !a.vtipo || !['interno', 'externo'].includes(a.vtipo) || a.fecha_factura === null) continue;
    if ((await tx.query('select 1 from comision_movimiento where tipo = $1 and origen_tipo = $2 and origen_id = $3', ['devengo', 'aplicacion_cobro', id])).rows.length) continue;

    const { rows: plan } = await tx.query<{ plan_id: string }>(
      `select vp.plan_id from vendedor_plan vp join plan_comision pc on pc.id = vp.plan_id and pc.estado = 'aprobado'
        where vp.vendedor_id = $1 and $2::date between vp.vigente_desde and coalesce(vp.vigente_hasta, 'infinity'::date)`, [a.vendedor_id, a.fecha_factura]);
    if (!plan[0]) continue;                                   // sin plan en la fecha de la factura no hay comisión

    const { rows: doc } = await tx.query<{ base_usd: string; total_usd: string }>('select base_usd::text, total_usd::text from vw_venta_documento where id = $1', [a.factura_id]);
    if (!doc[0] || new Decimal(doc[0].total_usd).lte(0)) continue;
    // Lo cobrado sin IVA: la parte de la factura que corresponde a la base, a la tasa de la factura.
    const baseCobrada = dos(new Decimal(a.usd_partida).times(doc[0].base_usd).dividedBy(doc[0].total_usd));
    const { rows: lineas } = await tx.query<{ base_usd: string; grupo_id: string | null; marca_id: string | null; grupo: string | null; marca: string | null }>(
      `select l.base_usd::text, l.grupo_id, l.marca_id, g.nombre as grupo, m.nombre as marca from vw_venta_linea l
         left join grupo_producto g on g.id = l.grupo_id left join marca m on m.id = l.marca_id where l.documento_id = $1`, [a.factura_id]);
    const { rows: reglas } = await tx.query<{ grupo_producto_id: string | null; marca_id: string | null; porcentaje: string }>(
      'select grupo_producto_id, marca_id, porcentaje::text from plan_comision_regla where plan_id = $1 order by prioridad', [plan[0].plan_id]);

    const c = calcularComision(
      baseCobrada,
      lineas.map((l) => ({ baseUsd: new Decimal(l.base_usd), grupoId: l.grupo_id, marcaId: l.marca_id, grupo: l.grupo ?? 'Sin grupo', marca: l.marca ?? 'Sin marca' })),
      reglas.map((r) => ({ grupoId: r.grupo_producto_id, marcaId: r.marca_id, porcentaje: new Decimal(r.porcentaje) })));
    if (c.monto.lte(0)) continue;

    const ref = crypto.randomUUID();
    const as = await contabilizar(tx, {
      evento: 'comision_devengada', fecha: a.fecha, descripcion: `Comisión devengada · factura ${a.serie}-${a.numero}`, origen: { tipo: 'comision_movimiento', id: ref },
      moneda: 'USD', importes: { monto: c.monto.toFixed(2) }, usuarioId: u.id,
    });
    const ves = await vesDeComisionesPorPagar(tx, as.asientoId);
    await tx.query(
      `insert into comision_movimiento (ref, vendedor_id, fecha, tipo, origen_tipo, origen_id, factura_id, base_usd, porcentaje, monto_usd, monto_ves, calculo, asiento_id, created_by)
       values ($1, $2, $3::date, 'devengo', 'aplicacion_cobro', $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [ref, a.vendedor_id, a.fecha, id, a.factura_id, baseCobrada.toFixed(2), c.porcentaje, c.monto.toFixed(2), ves.toFixed(2), JSON.stringify({ baseCobradaUsd: baseCobrada.toFixed(2), lineas: c.detalle }), as.asientoId, u.id]);
    n++;
  }
  return n;
}

async function registrarReversion(
  tx: Db, u: { id: string },
  d: { vendedorId: string; fecha: string; origenTipo: 'aplicacion_cobro' | 'nota_credito'; origenId: string; facturaId: string; baseUsd: Decimal; usd: Decimal; ves: Decimal; porcentaje: Decimal; calculo: object; descripcion: string },
): Promise<void> {
  const ref = crypto.randomUUID();
  const as = await contabilizar(tx, {
    evento: 'comision_reversada', fecha: d.fecha, descripcion: d.descripcion, origen: { tipo: 'comision_movimiento', id: ref }, moneda: 'USD', importes: {},
    importesDobles: { monto: { ves: dos(d.ves).toFixed(2), usd: dos(d.usd).toFixed(2) } }, usuarioId: u.id,
  });
  await tx.query(
    `insert into comision_movimiento (ref, vendedor_id, fecha, tipo, origen_tipo, origen_id, factura_id, base_usd, porcentaje, monto_usd, monto_ves, calculo, asiento_id, created_by)
     values ($1, $2, $3::date, 'reversion', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
    [ref, d.vendedorId, d.fecha, d.origenTipo, d.origenId, d.facturaId, dos(d.baseUsd).toFixed(2), d.porcentaje.toFixed(4), dos(d.usd).negated().toFixed(2), dos(d.ves).negated().toFixed(2),
     JSON.stringify(d.calculo), as.asientoId, u.id]);
}

async function baseDeFactura(tx: Db, facturaId: string): Promise<Decimal> {
  const { rows } = await tx.query<{ s: string }>('select coalesce(sum(base_usd), 0)::text as s from vw_venta_linea where documento_id = $1', [facturaId]);
  return new Decimal(rows[0].s);
}

/** Una nota de crédito emitida sobre una factura que ya comisionó revierte la parte proporcional de lo devengado. */
export async function revertirPorNota(tx: Db, u: { id: string }, notaId: string): Promise<boolean> {
  const { rows: n } = await tx.query<{ factura_id: string; hoy: string; nota: string }>(
    `select d.documento_origen_id as factura_id, ((now() at time zone 'America/Caracas')::date)::text as hoy, d.serie || '-' || d.numero as nota
       from documento_venta d where d.id = $1 and d.tipo = 'nota_credito' and d.estado = 'emitido'`, [notaId]);
  if (!n[0]) return false;
  const { rows: dev } = await tx.query<{ vendedor_id: string; usd: string; ves: string }>(
    `select vendedor_id, sum(monto_usd)::text as usd, sum(monto_ves)::text as ves from comision_movimiento where factura_id = $1 group by vendedor_id`, [n[0].factura_id]);
  if (!dev[0] || new Decimal(dev[0].usd).lte(0)) return false;
  const venta = await baseDeFactura(tx, n[0].factura_id);
  const { rows: nc } = await tx.query<{ esta: string; previas: string }>(
    `select coalesce(sum(x.base_usd) filter (where x.documento_id = $2), 0)::text as esta,
            coalesce(sum(x.base_usd) filter (where x.documento_id <> $2 and dn.fecha_emision < (select fecha_emision from documento_venta where id = $2)), 0)::text as previas
       from vw_nota_credito_linea x join documento_venta dn on dn.id = x.documento_id where x.factura_id = $1`, [n[0].factura_id, notaId]);
  const esta = new Decimal(nc[0].esta);
  const vigente = venta.minus(nc[0].previas);                 // lo que valía la venta antes de esta nota
  const ratio = vigente.lte(0) ? new Decimal(1) : Decimal.min(1, esta.dividedBy(vigente));
  const usd = dos(new Decimal(dev[0].usd).times(ratio));
  const ves = dos(new Decimal(dev[0].ves).times(ratio));
  if (usd.lte(0)) return false;
  await registrarReversion(tx, u, {
    vendedorId: dev[0].vendedor_id, fecha: n[0].hoy, origenTipo: 'nota_credito', origenId: notaId, facturaId: n[0].factura_id, baseUsd: esta, usd, ves, porcentaje: ratio.times(100),
    calculo: { motivo: 'Nota de crédito sobre una factura que ya comisionó', notaBaseUsd: esta.toFixed(2), ventaVigenteUsd: vigente.toFixed(2), proporcion: ratio.toFixed(6), devengadoNetoUsd: dev[0].usd },
    descripcion: `Reversión de comisión · nota de crédito ${n[0].nota}`,
  });
  return true;
}

/** Al anular un cobro se revierte lo devengado por sus aplicaciones (menos lo que ya revirtió una nota de crédito posterior). */
export async function revertirDevengosDeCobro(tx: Db, u: { id: string }, cobroId: string): Promise<number> {
  const { rows } = await tx.query<{ id: string; vendedor_id: string; factura_id: string; origen_id: string; usd: string; ves: string; creado: string; hoy: string }>(
    `select m.id::text, m.vendedor_id, m.factura_id, m.origen_id, m.monto_usd::text as usd, m.monto_ves::text as ves, m.created_at::text as creado,
            ((now() at time zone 'America/Caracas')::date)::text as hoy
       from comision_movimiento m
      where m.tipo = 'devengo' and m.origen_tipo = 'aplicacion_cobro' and m.origen_id in (select id from aplicacion_cobro where cobro_id = $1)
        and not exists (select 1 from comision_movimiento r where r.tipo = 'reversion' and r.origen_tipo = 'aplicacion_cobro' and r.origen_id = m.origen_id)`, [cobroId]);
  let n = 0;
  for (const m of rows) {
    const venta = await baseDeFactura(tx, m.factura_id);
    const { rows: nc } = await tx.query<{ ahora: string; antes: string }>(
      `select coalesce(sum(x.base_usd), 0)::text as ahora, coalesce(sum(x.base_usd) filter (where dn.fecha_emision <= $2::timestamptz), 0)::text as antes
         from vw_nota_credito_linea x join documento_venta dn on dn.id = x.documento_id where x.factura_id = $1`, [m.factura_id, m.creado]);
    const antes = venta.minus(nc[0].antes);
    const k = antes.lte(0) ? new Decimal(0) : Decimal.max(0, Decimal.min(1, venta.minus(nc[0].ahora).dividedBy(antes)));
    const usd = dos(new Decimal(m.usd).times(k));
    const ves = dos(new Decimal(m.ves).times(k));
    if (usd.lte(0)) continue;
    await registrarReversion(tx, u, {
      vendedorId: m.vendedor_id, fecha: m.hoy, origenTipo: 'aplicacion_cobro', origenId: m.origen_id, facturaId: m.factura_id, baseUsd: usd, usd, ves, porcentaje: k.times(100),
      calculo: { motivo: 'Cobro anulado', devengoOriginalUsd: m.usd, proporcionVigente: k.toFixed(6) }, descripcion: 'Reversión de comisión · cobro anulado',
    });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------
// Liquidaciones
// ---------------------------------------------------------------------

export interface ResultadoGeneracion {
  creadas: { id: string; vendedor: string; netoUsd: string }[];
  /** Vendedores con saldo no positivo: sus movimientos esperan a la próxima liquidación. */
  arrastres: { vendedor: string; netoUsd: string; meses: number; alerta: boolean }[];
}

function finDeMes(periodo: string): string {
  const [a, m] = periodo.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}
const mesesEntre = (desde: string, periodo: string) => (Number(periodo.slice(0, 4)) - Number(desde.slice(0, 4))) * 12 + (Number(periodo.slice(5, 7)) - Number(desde.slice(5, 7)));

/** Arma las liquidaciones de un mes ya terminado con los movimientos sin liquidar de cada vendedor. El saldo negativo no se arrastra más de dos periodos sin alerta. */
export async function generarLiquidaciones(tx: Db, u: UsuarioCom, periodo: string): Promise<ResultadoGeneracion> {
  exigir(u, ROLES_LIQUIDAN, 'Solo Contabilidad o Gerencia arman liquidaciones de comisiones.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw new ErrorMaestro('Indique el mes de la liquidación.');
  const fin = finDeMes(periodo);
  if (fin >= (await hoyCaracas(tx))) throw new ErrorMaestro('Solo se liquida un mes ya terminado.');
  const { rows: vend } = await tx.query<{ vendedor_id: string; nombre: string; usd: string; ves: string; dev: string; rev: string; primero: string }>(
    `select m.vendedor_id, v.nombre, sum(m.monto_usd)::text as usd, sum(m.monto_ves)::text as ves,
            coalesce(sum(m.monto_usd) filter (where m.tipo = 'devengo'), 0)::text as dev, coalesce(sum(m.monto_usd) filter (where m.tipo = 'reversion'), 0)::text as rev,
            min(m.fecha)::text as primero
       from comision_movimiento m join vendedor v on v.id = m.vendedor_id
      where m.liquidacion_id is null and m.fecha <= $1::date
        and not exists (select 1 from liquidacion_comision l where l.vendedor_id = m.vendedor_id and l.periodo = $2 and l.estado <> 'rechazada')
      group by m.vendedor_id, v.nombre order by v.nombre`, [fin, periodo]);
  const out: ResultadoGeneracion = { creadas: [], arrastres: [] };
  for (const v of vend) {
    const neto = new Decimal(v.usd);
    if (neto.lte(0)) {
      const meses = mesesEntre(v.primero, periodo);
      out.arrastres.push({ vendedor: v.nombre, netoUsd: neto.toFixed(2), meses, alerta: meses > 2 });
      continue;
    }
    const { rows } = await tx.query<{ id: string }>(
      `insert into liquidacion_comision (vendedor_id, periodo, total_devengado_usd, total_reversiones_usd, neto_usd, neto_ves, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [v.vendedor_id, periodo, v.dev, v.rev, neto.toFixed(2), new Decimal(v.ves).toFixed(2), u.id]);
    await tx.query(`update comision_movimiento set liquidacion_id = $1 where vendedor_id = $2 and liquidacion_id is null and fecha <= $3::date`, [rows[0].id, v.vendedor_id, fin]);
    await solicitarAprobacion(tx, { tipo: 'liquidacion_comision', objetoId: rows[0].id, solicitanteId: u.id, contexto: { valor_usd: Number(neto.toFixed(2)) } });
    out.creadas.push({ id: rows[0].id, vendedor: v.nombre, netoUsd: neto.toFixed(2) });
  }
  return out;
}

export async function aprobarLiquidacion(tx: Db, id: string, aprobador: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string; usuario_id: string | null }>(
    `select l.estado, v.usuario_id from liquidacion_comision l join vendedor v on v.id = l.vendedor_id where l.id = $1 for update of l`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La liquidación no existe.');
  if (rows[0].estado !== 'pendiente') throw new ErrorMaestro('La liquidación no está pendiente de aprobación.');
  if (rows[0].usuario_id === aprobador) throw new ErrorMaestro('No puede aprobar su propia liquidación de comisiones.');
  await tx.query(`update liquidacion_comision set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, aprobador]);
}

/** Rechazada, la liquidación libera sus movimientos para armarse de nuevo. */
export async function rechazarLiquidacion(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from liquidacion_comision where id = $1 for update', [id]);
  if (rows[0]?.estado !== 'pendiente') throw new ErrorMaestro('La liquidación no está pendiente de aprobación.');
  await tx.query(`update liquidacion_comision set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
  await tx.query('update comision_movimiento set liquidacion_id = null where liquidacion_id = $1', [id]);
}

/** Tesorería paga una liquidación aprobada: sale del banco, se salda comisiones por pagar y la diferencia contra el valor en libros es diferencial cambiario. */
export async function pagarLiquidacion(tx: Db, u: UsuarioCom, id: string, d: { cuentaBancariaId: string; fecha: string; referencia?: string }): Promise<{ asiento: string }> {
  exigir(u, ROLES_PAGAN_COMISIONES, 'Solo Tesorería o Gerencia pagan comisiones.');
  if (!UUID.test(d.cuentaBancariaId)) throw new ErrorMaestro('Seleccione la cuenta de donde sale el pago.');
  if (!FECHA.test(d.fecha)) throw new ErrorMaestro('Indique la fecha del pago.');
  const { rows } = await tx.query<{ estado: string; neto_usd: string; neto_ves: string; tipo: string; nombre: string; periodo: string; numero: string }>(
    `select l.estado, l.neto_usd::text, l.neto_ves::text, v.tipo, v.nombre, l.periodo, l.numero::text from liquidacion_comision l join vendedor v on v.id = l.vendedor_id where l.id = $1 for update of l`, [id]);
  const l = rows[0];
  if (!l) throw new ErrorMaestro('La liquidación no existe.');
  if (l.estado !== 'aprobada') throw new ErrorMaestro(l.estado === 'pagada' ? 'La liquidación ya está pagada.' : 'Solo se paga una liquidación aprobada por Gerencia.');
  if (l.tipo === 'externo') {
    throw new ErrorMaestro('Un vendedor externo necesita retención de ISLR sobre su comisión y ese cálculo todavía no está construido: no se paga sin retener. Avise a Contabilidad.');
  }
  if (d.fecha > (await hoyCaracas(tx))) throw new ErrorMaestro('La fecha del pago no puede ser futura.');
  const { rows: c } = await tx.query<{ cuenta_contable_id: string; moneda: string; activa: boolean; tipo: string }>(
    'select cuenta_contable_id, moneda, activa, tipo from cuenta_bancaria where id = $1', [d.cuentaBancariaId]);
  if (!c[0] || !c[0].activa || !['VES', 'USD'].includes(c[0].moneda)) throw new ErrorMaestro('Seleccione una cuenta activa en bolívares o dólares.');

  const tasa = (await tasasDelDia(tx, 'USD', d.fecha)).usd;
  const netoUsd = new Decimal(l.neto_usd);
  const netoVes = new Decimal(l.neto_ves);
  const pagoVes = dos(netoUsd.times(tasa));
  const dif = netoVes.minus(pagoVes);                                   // positivo: se debía más (en libros) de lo que sale del banco
  const bancoOriginal = c[0].moneda === 'USD' ? netoUsd : pagoVes;
  const r = await contabilizar(tx, {
    evento: 'pago_comision', fecha: d.fecha, descripcion: `Pago de comisiones N° ${l.numero} · ${l.nombre} · ${l.periodo}`, origen: { tipo: 'liquidacion_comision', id },
    moneda: c[0].moneda, importes: {}, cuentas: { banco: c[0].cuenta_contable_id }, usuarioId: u.id,
    importesDobles: {
      comision: { ves: dos(netoVes).toFixed(2), usd: dos(netoUsd).toFixed(2), original: dos(netoUsd).toFixed(2) },
      banco: { ves: pagoVes.toFixed(2), usd: dos(netoUsd).toFixed(2), original: dos(bancoOriginal).toFixed(2) },
      dif_ganancia_ves: { ves: (dif.isPositive() ? dif : new Decimal(0)).toFixed(2), usd: '0.00' },
      dif_perdida_ves: { ves: (dif.isNegative() ? dif.abs() : new Decimal(0)).toFixed(2), usd: '0.00' },
    },
  });
  await tx.query(
    `update liquidacion_comision set estado = 'pagada', pagada_por = $2, fecha_pago = $3::date, cuenta_bancaria_id = $4, referencia = $5, tasa_pago = $6, asiento_pago_id = $7 where id = $1`,
    [id, u.id, d.fecha, d.cuentaBancariaId, d.referencia?.trim() || null, tasa.toFixed(6), r.asientoId]);
  return { asiento: r.numero };
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/** Un vendedor (solo Ventas) ve únicamente lo suyo; el resto de los roles ve todo. */
const restringido = (u: UsuarioCom) => !tiene(u, ROLES_VEN_TODO_COMISIONES);

export interface FilaMovimiento {
  id: string; fecha: string; vendedor: string; tipo: 'devengo' | 'reversion'; factura: string; baseUsd: string; porcentaje: string; montoUsd: string;
  origen: string; liquidacion: string | null; calculo: unknown;
}

export async function movimientosDe(db: Db, u: UsuarioCom, f: { vendedorId?: string; periodo?: string } = {}, limite = 300): Promise<FilaMovimiento[]> {
  if (!tiene(u, ROLES_VEN_COMISIONES)) return [];
  const { rows } = await db.query<{
    id: string; fecha: string; vendedor: string; tipo: 'devengo' | 'reversion'; factura: string; base: string; porcentaje: string; monto: string; origen_tipo: string; liq: string | null; calculo: unknown;
  }>(
    `select m.id::text, m.fecha::text, v.nombre as vendedor, m.tipo, d.serie || '-' || d.numero as factura, m.base_usd::text as base, m.porcentaje::text, m.monto_usd::text as monto,
            m.origen_tipo, l.numero::text as liq, m.calculo
       from comision_movimiento m join vendedor v on v.id = m.vendedor_id join documento_venta d on d.id = m.factura_id left join liquidacion_comision l on l.id = m.liquidacion_id
      where ($1::uuid is null or m.vendedor_id = $1) and ($2::text is null or to_char(m.fecha, 'YYYY-MM') = $2) and ($3::uuid is null or v.usuario_id = $3)
      order by m.fecha desc, m.id desc limit ${Math.min(limite, 1000)}`,
    [f.vendedorId || null, f.periodo || null, restringido(u) ? u.id : null]);
  return rows.map((r) => ({
    id: r.id, fecha: r.fecha, vendedor: r.vendedor, tipo: r.tipo, factura: r.factura, baseUsd: r.base, porcentaje: r.porcentaje, montoUsd: r.monto,
    origen: r.origen_tipo === 'nota_credito' ? 'Nota de crédito' : r.tipo === 'devengo' ? 'Cobro aplicado' : 'Cobro anulado', liquidacion: r.liq, calculo: r.calculo,
  }));
}

export interface ResumenVendedor { vendedor: string; devengadoUsd: string; reversionesUsd: string; netoUsd: string; porLiquidarUsd: string; liquidadoUsd: string; pagadoUsd: string }

export async function resumenPorVendedor(db: Db, u: UsuarioCom, periodo?: string): Promise<ResumenVendedor[]> {
  if (!tiene(u, ROLES_VEN_COMISIONES)) return [];
  const { rows } = await db.query<{ vendedor: string; dev: string; rev: string; neto: string; pend: string; liq: string; pag: string }>(
    `select v.nombre as vendedor,
            coalesce(sum(m.monto_usd) filter (where m.tipo = 'devengo'), 0)::text as dev, coalesce(sum(m.monto_usd) filter (where m.tipo = 'reversion'), 0)::text as rev,
            coalesce(sum(m.monto_usd), 0)::text as neto, coalesce(sum(m.monto_usd) filter (where m.liquidacion_id is null), 0)::text as pend,
            coalesce(sum(m.monto_usd) filter (where l.estado in ('pendiente', 'aprobada')), 0)::text as liq, coalesce(sum(m.monto_usd) filter (where l.estado = 'pagada'), 0)::text as pag
       from comision_movimiento m join vendedor v on v.id = m.vendedor_id left join liquidacion_comision l on l.id = m.liquidacion_id
      where ($1::text is null or to_char(m.fecha, 'YYYY-MM') = $1) and ($2::uuid is null or v.usuario_id = $2)
      group by v.nombre order by v.nombre`, [periodo || null, restringido(u) ? u.id : null]);
  return rows.map((r) => ({ vendedor: r.vendedor, devengadoUsd: r.dev, reversionesUsd: r.rev, netoUsd: r.neto, porLiquidarUsd: r.pend, liquidadoUsd: r.liq, pagadoUsd: r.pag }));
}

export interface FilaLiquidacion { id: string; numero: string; vendedor: string; periodo: string; netoUsd: string; estado: string }
export async function listarLiquidaciones(db: Db, u: UsuarioCom): Promise<FilaLiquidacion[]> {
  if (!tiene(u, ROLES_VEN_COMISIONES)) return [];
  const { rows } = await db.query<FilaLiquidacion>(
    `select l.id, l.numero::text, v.nombre as vendedor, l.periodo, l.neto_usd::text as "netoUsd", l.estado
       from liquidacion_comision l join vendedor v on v.id = l.vendedor_id where ($1::uuid is null or v.usuario_id = $1) order by l.periodo desc, l.numero desc limit 200`,
    [restringido(u) ? u.id : null]);
  return rows;
}

export interface DetalleLiquidacion {
  liquidacion: {
    id: string; numero: string; vendedor: string; vendedor_tipo: string; vendedor_usuario: string | null; periodo: string; total_devengado_usd: string; total_reversiones_usd: string; neto_usd: string;
    neto_ves: string; estado: string; creador: string; aprobador: string | null; rechazo_motivo: string | null; fecha_pago: string | null; referencia: string | null; tasa_pago: string | null; cuenta: string | null;
  };
  movimientos: FilaMovimiento[];
}
export async function detalleLiquidacion(db: Db, u: UsuarioCom, id: string): Promise<DetalleLiquidacion | null> {
  const { rows } = await db.query<DetalleLiquidacion['liquidacion']>(
    `select l.id, l.numero::text, v.nombre as vendedor, v.tipo as vendedor_tipo, v.usuario_id as vendedor_usuario, l.periodo, l.total_devengado_usd::text, l.total_reversiones_usd::text,
            l.neto_usd::text, l.neto_ves::text, l.estado, c.nombre as creador, a.nombre as aprobador, l.rechazo_motivo, l.fecha_pago::text, l.referencia, l.tasa_pago::text, cb.nombre as cuenta
       from liquidacion_comision l join vendedor v on v.id = l.vendedor_id join usuario c on c.id = l.created_by left join usuario a on a.id = l.aprobado_por
       left join cuenta_bancaria cb on cb.id = l.cuenta_bancaria_id where l.id = $1`, [id]);
  const l = rows[0];
  if (!l || !tiene(u, ROLES_VEN_COMISIONES) || (restringido(u) && l.vendedor_usuario !== u.id)) return null;
  const { rows: m } = await db.query<{ id: string; fecha: string; tipo: 'devengo' | 'reversion'; factura: string; base: string; porcentaje: string; monto: string; origen_tipo: string; calculo: unknown }>(
    `select m.id::text, m.fecha::text, m.tipo, d.serie || '-' || d.numero as factura, m.base_usd::text as base, m.porcentaje::text, m.monto_usd::text as monto, m.origen_tipo, m.calculo
       from comision_movimiento m join documento_venta d on d.id = m.factura_id where m.liquidacion_id = $1 order by m.fecha, m.id`, [id]);
  return {
    liquidacion: l,
    movimientos: m.map((r) => ({ id: r.id, fecha: r.fecha, vendedor: l.vendedor, tipo: r.tipo, factura: r.factura, baseUsd: r.base, porcentaje: r.porcentaje, montoUsd: r.monto,
      origen: r.origen_tipo === 'nota_credito' ? 'Nota de crédito' : r.tipo === 'devengo' ? 'Cobro aplicado' : 'Cobro anulado', liquidacion: l.numero, calculo: r.calculo })),
  };
}

/** Auxiliar de «Comisiones por pagar» (2.1.07): lo devengado y revertido menos lo ya pagado, en VES (valor en libros) y en USD. */
export async function saldoAuxiliarComisiones(db: Db): Promise<{ ves: Decimal; usd: Decimal }> {
  const { rows } = await db.query<{ ves: string; usd: string }>(
    `select (coalesce((select sum(monto_ves) from comision_movimiento), 0) - coalesce((select sum(neto_ves) from liquidacion_comision where estado = 'pagada'), 0))::text as ves,
            (coalesce((select sum(monto_usd) from comision_movimiento), 0) - coalesce((select sum(neto_usd) from liquidacion_comision where estado = 'pagada'), 0))::text as usd`);
  return { ves: new Decimal(rows[0].ves), usd: new Decimal(rows[0].usd) };
}

export interface Arrastre { vendedor: string; netoUsd: string; desde: string }
/** Vendedores con comisiones sin liquidar de meses ya terminados. */
export async function pendientesDeLiquidar(db: Db): Promise<Arrastre[]> {
  const { rows } = await db.query<Arrastre>(
    `select v.nombre as vendedor, sum(m.monto_usd)::text as "netoUsd", min(m.fecha)::text as desde
       from comision_movimiento m join vendedor v on v.id = m.vendedor_id where m.liquidacion_id is null group by v.nombre order by v.nombre`);
  return rows;
}
