import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/errores';

/**
 * Arranque en producción: saldos iniciales como operaciones (spec §14; migración 0048).
 *
 *   Gerencia fija la fecha de arranque → cada responsable registra sus documentos de apertura (pendientes, sin mover nada)
 *   → Gerencia, distinta de quien los registró, los aprueba: nace el saldo y su asiento contra «Saldos de apertura» (3.9.01), con la fecha de arranque
 *   → el contador registra el asiento de apertura del resto del balance → con 3.9.01 en cero y el mayor cuadrado, Gerencia cierra la apertura.
 */

export const ROLES_APERTURA_BANCO = ['tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_APERTURA_CXC = ['cobranzas', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_APERTURA_CXP = ['compras', 'tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_APERTURA = ['tesoreria', 'cobranzas', 'compras', 'gerencia', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

export type UsuarioApertura = { id: string; roles: readonly string[] };
export type TipoApertura = 'banco' | 'cxc' | 'cxp' | 'inventario';
const tiene = (u: UsuarioApertura, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^\d{1,12}(\.\d{1,2})?$/;
const TASA = /^\d{1,10}(\.\d{1,6})?$/;
const NUMERO = /^\d{1,15}$/;
const dos = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const NOMBRE_ESTADO_APERTURA: Record<string, string> = { pendiente: 'Pendiente de Gerencia', aprobado: 'Aprobado', rechazado: 'Rechazado' };
export const NOMBRE_TIPO_APERTURA: Record<TipoApertura, string> = { banco: 'Saldo de banco o caja', cxc: 'Factura de venta pendiente', cxp: 'Factura de compra pendiente', inventario: 'Inventario inicial (conteo)' };

function exigirRol(u: UsuarioApertura, roles: readonly string[], texto: string) {
  if (!tiene(u, roles)) throw new ErrorMaestro(texto);
}

// ---------------------------------------------------------------------
// Fecha de arranque y cierre
// ---------------------------------------------------------------------

export async function estadoArranque(db: Db): Promise<{ fecha: string | null; fijadaPor: string | null; cerrada: boolean; cerradaPor: string | null; cerradaEl: string | null }> {
  const { rows } = await db.query<{ fecha: string | null; fijada_por: string | null; cerrada: boolean; cerrada_por: string | null; cerrada_el: string | null }>(
    `select a.fecha_arranque::text as fecha, u.nombre as fijada_por, (a.cerrada_at is not null) as cerrada, c.nombre as cerrada_por,
            to_char(a.cerrada_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as cerrada_el
       from arranque a left join usuario u on u.id = a.fijada_por left join usuario c on c.id = a.cerrada_por where a.id = 1`);
  const r = rows[0];
  return { fecha: r.fecha, fijadaPor: r.fijada_por, cerrada: r.cerrada, cerradaPor: r.cerrada_por, cerradaEl: r.cerrada_el };
}

/** Gerencia fija la fecha de arranque, una sola vez. El periodo contable de esa fecha debe existir y estar abierto, y debe haber tasa BCV. */
export async function fijarFechaArranque(tx: Db, u: UsuarioApertura, fecha: string): Promise<void> {
  exigirRol(u, ['gerencia'], 'Solo Gerencia fija la fecha de arranque.');
  if (!FECHA.test(fecha)) throw new ErrorMaestro('Indique la fecha de arranque.');
  const { rows: p } = await tx.query<{ estado: string }>('select estado from periodo_contable where $1::date between inicio and fin and mes <= 12 limit 1', [fecha]);
  if (!p[0]) throw new ErrorMaestro('No existe el periodo contable de esa fecha: créelo en Contabilidad → Periodos.');
  if (p[0].estado !== 'abierto') throw new ErrorMaestro('El periodo contable de la fecha de arranque debe estar abierto.');
  const { rows: t } = await tx.query('select 1 from tasa_cambio where moneda = \'USD\' and fecha <= $1::date limit 1', [fecha]);
  if (!t.length) throw new ErrorMaestro('Registre la tasa BCV del dólar de esa fecha antes de fijarla.');
  const { rows } = await tx.query('update arranque set fecha_arranque = $1::date, fijada_por = $2 where id = 1 and fecha_arranque is null returning id', [fecha, u.id]);
  if (!rows[0]) throw new ErrorMaestro('La fecha de arranque ya está fijada y no se cambia.');
}

export interface ControlApertura {
  saldoPuenteVes: string; saldoPuenteUsd: string; pendientes: number; mayorCuadra: boolean; puedeCerrar: boolean; impedimentos: string[];
  totales: { tipo: TipoApertura; documentos: number; ves: string; usd: string }[];
}

/** Lo que exige el cierre (§14.3): «Saldos de apertura» en cero, el mayor cuadrado y nada pendiente. */
export async function controlApertura(db: Db): Promise<ControlApertura> {
  const e = await estadoArranque(db);
  const { rows: s } = await db.query<{ ves: string; usd: string }>(
    `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves, coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01'`);
  const { rows: p } = await db.query<{ n: number }>(
    `select ((select count(*) from apertura_banco where estado = 'pendiente') + (select count(*) from apertura_cxc where estado = 'pendiente')
           + (select count(*) from apertura_cxp where estado = 'pendiente') + (select count(*) from apertura_inventario where estado in ('borrador', 'pendiente')))::int as n`);
  const { rows: c } = await db.query<{ dif: string }>('select (abs(diferencia_ves) + abs(diferencia_usd))::text as dif from vw_control_cuadre');
  const { rows: t } = await db.query<{ tipo: TipoApertura; documentos: number; ves: string; usd: string }>(
    `select 'banco' as tipo, count(*)::int as documentos, coalesce(sum(saldo_ves), 0)::text as ves, coalesce(sum(saldo_usd), 0)::text as usd from apertura_banco where estado = 'aprobado'
     union all select 'cxc', count(*)::int, coalesce(sum(saldo), 0)::text, coalesce(sum(saldo_usd), 0)::text from apertura_cxc where estado = 'aprobado'
     union all select 'cxp', count(*)::int, coalesce(sum(saldo_ves), 0)::text, coalesce(sum(saldo_usd), 0)::text from apertura_cxp where estado = 'aprobado'
     union all select 'inventario', count(*)::int,
            coalesce(sum((select sum(round(l.cantidad * l.costo_unitario_usd, 2)) from apertura_inventario_linea l where l.apertura_id = o.id)), 0)::text,
            coalesce(sum((select sum(round(l.cantidad * l.costo_unitario_usd, 2)) from apertura_inventario_linea l where l.apertura_id = o.id)), 0)::text from apertura_inventario o where estado = 'aprobado'`);
  const mayorCuadra = new Decimal(c[0]?.dif ?? 0).isZero();
  const impedimentos: string[] = [];
  if (!e.fecha) impedimentos.push('Falta fijar la fecha de arranque.');
  if (e.cerrada) impedimentos.push('La apertura ya está cerrada.');
  if (p[0].n > 0) impedimentos.push(`Hay ${p[0].n} documentos de apertura sin aprobar (incluye conteos de inventario en borrador).`);
  // En bolívares: el residuo en dólares sale de mezclar tasas históricas con la del arranque; se informa pero no impide el cierre.
  if (!new Decimal(s[0].ves).isZero()) {
    impedimentos.push(`«Saldos de apertura» no está en cero (Bs ${dos(s[0].ves)}): falta el asiento de apertura del contador.`);
  }
  if (!mayorCuadra) impedimentos.push('El mayor no cuadra.');
  return { saldoPuenteVes: dos(s[0].ves), saldoPuenteUsd: dos(s[0].usd), pendientes: p[0].n, mayorCuadra, puedeCerrar: impedimentos.length === 0, impedimentos, totales: t };
}

export async function cerrarApertura(tx: Db, u: UsuarioApertura): Promise<void> {
  exigirRol(u, ['gerencia'], 'Solo Gerencia cierra la apertura.');
  const c = await controlApertura(tx);
  if (!c.puedeCerrar) throw new ErrorMaestro(c.impedimentos[0]);
  await tx.query('update arranque set cerrada_por = $1 where id = 1', [u.id]);
}

// ---------------------------------------------------------------------
// Registro (pendiente)
// ---------------------------------------------------------------------

function leerMonto(v: string, nombre: string): string {
  const t = v.trim().replace(',', '.');
  if (!MONTO.test(t) || new Decimal(t).lte(0)) throw new ErrorMaestro(`${nombre} debe ser mayor que cero, con hasta 2 decimales.`);
  return t;
}
function leerTasa(v: string, nombre: string): string {
  const t = v.trim().replace(',', '.');
  if (!TASA.test(t) || new Decimal(t).lte(0)) throw new ErrorMaestro(`${nombre} debe ser mayor que cero.`);
  return t;
}
function leerFecha(v: string, nombre: string): string {
  if (!FECHA.test(v)) throw new ErrorMaestro(`Indique ${nombre}.`);
  return v;
}

/** La factura pendiente es anterior al arranque: su fecha original va antes de la fecha de arranque y su vencimiento no antes que ella. */
async function validarFechas(tx: Db, original: string, vencimiento: string): Promise<void> {
  const e = await estadoArranque(tx);
  if (!e.fecha) throw new ErrorMaestro('Gerencia debe fijar primero la fecha de arranque.');
  if (original >= e.fecha) throw new ErrorMaestro(`La fecha original de la factura debe ser anterior a la fecha de arranque (${e.fecha}).`);
  if (vencimiento < original) throw new ErrorMaestro('El vencimiento no puede ser anterior a la fecha de la factura.');
}

async function solicitar(tx: Db, tipo: string, id: string, u: UsuarioApertura, valorUsd: string) {
  await solicitarAprobacion(tx, { tipo, objetoId: id, solicitanteId: u.id, contexto: { valor_usd: new Decimal(valorUsd).toNumber() } });
}

export async function registrarBanco(tx: Db, u: UsuarioApertura, d: { cuentaBancariaId: string; saldo: string; referencia?: string }): Promise<{ id: string; numero: string }> {
  exigirRol(u, ROLES_APERTURA_BANCO, 'Solo Tesorería registra los saldos iniciales de bancos y cajas.');
  if (!d.cuentaBancariaId) throw new ErrorMaestro('Seleccione la cuenta bancaria o la caja.');
  const { rows } = await tx.query<{ id: string; numero: string; saldo_usd: string }>(
    `insert into apertura_banco (cuenta_bancaria_id, saldo, referencia, created_by, fecha, moneda, tasa, saldo_ves, saldo_usd)
     values ($1, $2, nullif(trim($3), ''), $4, current_date, 'VES', 1, 0, 0) returning id, numero::text, saldo_usd::text`,
    [d.cuentaBancariaId, leerMonto(d.saldo, 'El saldo'), d.referencia ?? '', u.id]);
  await solicitar(tx, 'apertura_banco', rows[0].id, u, rows[0].saldo_usd);
  return rows[0];
}

export interface DatosApertura {
  clienteId: string; sucursalId: string; numeroOriginal: string; numeroControl?: string; fechaOriginal: string; vencimiento: string; saldo: string; tasa: string;
}

export async function registrarCxc(tx: Db, u: UsuarioApertura, d: DatosApertura): Promise<{ id: string; numero: string }> {
  exigirRol(u, ROLES_APERTURA_CXC, 'Solo Cobranzas registra las facturas pendientes de clientes.');
  if (!d.clienteId) throw new ErrorMaestro('Seleccione el cliente.');
  if (!d.sucursalId) throw new ErrorMaestro('Seleccione la sucursal de la factura.');
  if (!NUMERO.test(d.numeroOriginal.trim())) throw new ErrorMaestro('El número original de la factura debe ser numérico (sin letras ni guiones).');
  await validarFechas(tx, leerFecha(d.fechaOriginal, 'la fecha original de la factura'), leerFecha(d.vencimiento, 'el vencimiento'));
  const { rows } = await tx.query<{ id: string; numero: string; saldo_usd: string }>(
    `insert into apertura_cxc (cliente_id, sucursal_id, numero_original, numero_control, fecha_original, vencimiento, saldo, tasa, created_by, fecha, saldo_usd)
     values ($1, $2, $3, nullif(trim($4), ''), $5::date, $6::date, $7, $8, $9, current_date, 0) returning id, numero::text, saldo_usd::text`,
    [d.clienteId, d.sucursalId, d.numeroOriginal.trim(), d.numeroControl ?? '', leerFecha(d.fechaOriginal, 'la fecha original de la factura'), leerFecha(d.vencimiento, 'el vencimiento'),
     leerMonto(d.saldo, 'El saldo'), leerTasa(d.tasa, 'La tasa'), u.id]);
  await solicitar(tx, 'apertura_cxc', rows[0].id, u, rows[0].saldo_usd);
  return rows[0];
}

export interface DatosAperturaCxp {
  proveedorId: string; numeroDocumento: string; numeroControl?: string; fechaOriginal: string; vencimiento: string; moneda: string; saldo: string; tasaUsd: string;
}

export async function registrarCxp(tx: Db, u: UsuarioApertura, d: DatosAperturaCxp): Promise<{ id: string; numero: string }> {
  exigirRol(u, ROLES_APERTURA_CXP, 'Solo Compras o Tesorería registran las facturas pendientes de proveedores.');
  if (!d.proveedorId) throw new ErrorMaestro('Seleccione el proveedor.');
  if (!['VES', 'USD'].includes(d.moneda)) throw new ErrorMaestro('La moneda de una factura pendiente es bolívares o dólares.');
  if (!d.numeroDocumento.trim() || d.numeroDocumento.trim().length > 40) throw new ErrorMaestro('Indique el número de la factura del proveedor (hasta 40 caracteres).');
  await validarFechas(tx, leerFecha(d.fechaOriginal, 'la fecha original de la factura'), leerFecha(d.vencimiento, 'el vencimiento'));
  const { rows } = await tx.query<{ id: string; numero: string; saldo_usd: string }>(
    `insert into apertura_cxp (proveedor_id, numero_documento, numero_control, fecha_original, vencimiento, moneda, saldo, tasa_usd, created_by, fecha, tasa, saldo_ves, saldo_usd)
     values ($1, $2, nullif(trim($3), ''), $4::date, $5::date, $6, $7, $8, $9, current_date, 1, 0, 0) returning id, numero::text, saldo_usd::text`,
    [d.proveedorId, d.numeroDocumento.trim(), d.numeroControl ?? '', leerFecha(d.fechaOriginal, 'la fecha original de la factura'), leerFecha(d.vencimiento, 'el vencimiento'), d.moneda,
     leerMonto(d.saldo, 'El saldo'), leerTasa(d.tasaUsd, 'La tasa del dólar'), u.id]);
  await solicitar(tx, 'apertura_cxp', rows[0].id, u, rows[0].saldo_usd);
  return rows[0];
}

// ---------------------------------------------------------------------
// Aprobación (la llama el motor de flujo)
// ---------------------------------------------------------------------

async function rechazar(tx: Db, tabla: string, id: string, motivo: string) {
  const { rows } = await tx.query<{ estado: string }>(`select estado from ${tabla} where id = $1 for update`, [id]);
  if (!rows[0]) throw new ErrorMaestro('El documento de apertura no existe.');
  if (rows[0].estado !== 'pendiente') throw new ErrorMaestro('El documento de apertura no está pendiente de aprobación.');
  await tx.query(`update ${tabla} set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}
export const rechazarBanco = (tx: Db, id: string, _u: string, motivo: string) => rechazar(tx, 'apertura_banco', id, motivo);
export const rechazarCxc = (tx: Db, id: string, _u: string, motivo: string) => rechazar(tx, 'apertura_cxc', id, motivo);
export const rechazarCxp = (tx: Db, id: string, _u: string, motivo: string) => rechazar(tx, 'apertura_cxp', id, motivo);

export async function aprobarBanco(tx: Db, id: string, aprobador: string): Promise<{ asiento: string }> {
  const { rows } = await tx.query<{ estado: string; fecha: string; moneda: string; saldo: string; numero: string; cuenta_contable_id: string; nombre: string }>(
    `select o.estado, o.fecha::text, o.moneda, o.saldo::text, o.numero::text, cb.cuenta_contable_id, cb.nombre
       from apertura_banco o join cuenta_bancaria cb on cb.id = o.cuenta_bancaria_id where o.id = $1 for update of o`, [id]);
  const o = rows[0];
  if (!o) throw new ErrorMaestro('El documento de apertura no existe.');
  if (o.estado !== 'pendiente') throw new ErrorMaestro('El documento de apertura no está pendiente de aprobación.');
  await tx.query(`update apertura_banco set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id, aprobador]);
  const a = await contabilizar(tx, {
    evento: 'apertura_banco', fecha: o.fecha, descripcion: `Saldo inicial de ${o.nombre} · apertura ${o.numero}`, origen: { tipo: 'apertura_banco', id }, moneda: o.moneda,
    importes: { monto: o.saldo }, cuentas: { banco: o.cuenta_contable_id }, usuarioId: aprobador,
  });
  return { asiento: a.numero };
}

export async function aprobarCxc(tx: Db, id: string, aprobador: string): Promise<{ asiento: string; documentoId: string }> {
  const { rows } = await tx.query<{
    estado: string; cliente_id: string; sucursal_id: string; numero_original: string; numero_control: string | null; fecha_original: string; vencimiento: string; fecha: string;
    saldo: string; tasa: string; saldo_usd: string; numero: string; created_by: string; vendedor_id: string | null;
  }>(
    `select o.estado, o.cliente_id, o.sucursal_id, o.numero_original::text, o.numero_control, o.fecha_original::text, o.vencimiento::text, o.fecha::text, o.saldo::text, o.tasa::text,
            o.saldo_usd::text, o.numero::text, o.created_by, c.vendedor_id
       from apertura_cxc o join cliente c on c.tercero_id = o.cliente_id where o.id = $1 for update of o`, [id]);
  const o = rows[0];
  if (!o) throw new ErrorMaestro('El documento de apertura no existe.');
  if (o.estado !== 'pendiente') throw new ErrorMaestro('El documento de apertura no está pendiente de aprobación.');
  const { rows: alm } = await tx.query<{ id: string }>('select id from almacen where sucursal_id = $1 and activo order by codigo limit 1', [o.sucursal_id]);
  if (!alm[0]) throw new ErrorMaestro('La sucursal no tiene un almacén activo: una factura necesita sucursal y almacén.');

  // La factura de apertura: nace en borrador y se emite con su número, control y fecha originales (sin líneas).
  const { rows: doc } = await tx.query<{ id: string }>(
    `insert into documento_venta (tipo, serie, estado, sucursal_id, almacen_id, cliente_id, vendedor_id, moneda, tasa, total, total_ves, total_usd, fecha_vencimiento,
                                  numero_control, apertura, observaciones, created_by)
     values ('factura', 'AP', 'borrador', $1, $2, $3, $4, 'VES', $5, $6, $6, $7, $8::date, $9, true, $10, $11) returning id`,
    [o.sucursal_id, alm[0].id, o.cliente_id, o.vendedor_id, o.tasa, o.saldo, o.saldo_usd, o.vencimiento, o.numero_control, `Factura pendiente de apertura ${o.numero}`, o.created_by]);
  await tx.query(
    `update documento_venta set estado = 'emitido', numero = $2, fecha_emision = ($3::date + time '12:00') at time zone 'America/Caracas' where id = $1`,
    [doc[0].id, o.numero_original, o.fecha_original]);
  await tx.query(
    `insert into partida_cxc (cliente_id, documento_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
     values ($1, $2, $3::date, $4::date, 'VES', $5, $6, $7, $6)`, [o.cliente_id, doc[0].id, o.fecha_original, o.vencimiento, o.tasa, o.saldo, o.saldo_usd]);
  await tx.query(`update apertura_cxc set estado = 'aprobado', aprobado_por = $2, documento_id = $3 where id = $1`, [id, aprobador, doc[0].id]);
  const a = await contabilizar(tx, {
    evento: 'apertura_cxc', fecha: o.fecha, descripcion: `Factura pendiente AP-${o.numero_original} · apertura ${o.numero}`, origen: { tipo: 'apertura_cxc', id }, moneda: 'VES',
    importes: {}, importesDobles: { monto: { ves: dos(o.saldo), usd: dos(o.saldo_usd), original: dos(o.saldo) } }, terceroId: o.cliente_id, usuarioId: aprobador,
  });
  return { asiento: a.numero, documentoId: doc[0].id };
}

export async function aprobarCxp(tx: Db, id: string, aprobador: string): Promise<{ asiento: string }> {
  const { rows } = await tx.query<{
    estado: string; proveedor_id: string; numero_documento: string; fecha_original: string; vencimiento: string; fecha: string; moneda: string; saldo: string; tasa: string;
    saldo_ves: string; saldo_usd: string; numero: string;
  }>(
    `select estado, proveedor_id, numero_documento, fecha_original::text, vencimiento::text, fecha::text, moneda, saldo::text, tasa::text, saldo_ves::text, saldo_usd::text, numero::text
       from apertura_cxp where id = $1 for update`, [id]);
  const o = rows[0];
  if (!o) throw new ErrorMaestro('El documento de apertura no existe.');
  if (o.estado !== 'pendiente') throw new ErrorMaestro('El documento de apertura no está pendiente de aprobación.');
  await tx.query(`update apertura_cxp set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id, aprobador]);
  await tx.query(
    `insert into partida_cxp (proveedor_id, apertura_cxp_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
     values ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $7)`, [o.proveedor_id, id, o.fecha_original, o.vencimiento, o.moneda, o.tasa, o.saldo, o.saldo_usd]);
  const a = await contabilizar(tx, {
    evento: 'apertura_cxp', fecha: o.fecha, descripcion: `Factura pendiente ${o.numero_documento} · apertura ${o.numero}`, origen: { tipo: 'apertura_cxp', id }, moneda: o.moneda,
    importes: {}, importesDobles: { monto: { ves: dos(o.saldo_ves), usd: dos(o.saldo_usd), original: dos(o.saldo) } }, terceroId: o.proveedor_id, usuarioId: aprobador,
  });
  return { asiento: a.numero };
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaApertura {
  id: string; numero: string; tipo: TipoApertura; estado: string; descripcion: string; tercero: string | null; moneda: string; saldo: string; saldo_usd: string;
  creador: string; creado: string; aprobado_por: string | null; rechazo_motivo: string | null; asiento: string | null;
}

export async function buscarAperturas(db: Db, estado = ''): Promise<FilaApertura[]> {
  const { rows } = await db.query<FilaApertura>(
    `select * from (
       select o.id, o.numero::text, 'banco'::text as tipo, o.estado, cb.codigo || ' · ' || cb.nombre as descripcion, null::text as tercero, o.moneda, o.saldo::text, o.saldo_usd::text,
              cr.nombre as creador, to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as creado, ap.nombre as aprobado_por, o.rechazo_motivo, a.numero::text as asiento, o.created_at
         from apertura_banco o join cuenta_bancaria cb on cb.id = o.cuenta_bancaria_id join usuario cr on cr.id = o.created_by left join usuario ap on ap.id = o.aprobado_por
         left join asiento a on a.origen_tipo = 'apertura_banco' and a.origen_id = o.id and a.tipo = 'automatico'
       union all
       select o.id, o.numero::text, 'cxc', o.estado, 'Factura AP-' || o.numero_original || ' del ' || to_char(o.fecha_original, 'DD-MM-YYYY'), t.razon_social, 'VES', o.saldo::text, o.saldo_usd::text,
              cr.nombre, to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY'), ap.nombre, o.rechazo_motivo, a.numero::text, o.created_at
         from apertura_cxc o join tercero t on t.id = o.cliente_id join usuario cr on cr.id = o.created_by left join usuario ap on ap.id = o.aprobado_por
         left join asiento a on a.origen_tipo = 'apertura_cxc' and a.origen_id = o.id and a.tipo = 'automatico'
       union all
       select o.id, o.numero::text, 'cxp', o.estado, 'Factura ' || o.numero_documento || ' del ' || to_char(o.fecha_original, 'DD-MM-YYYY'), t.razon_social, o.moneda, o.saldo::text, o.saldo_usd::text,
              cr.nombre, to_char(o.created_at at time zone 'America/Caracas', 'DD-MM-YYYY'), ap.nombre, o.rechazo_motivo, a.numero::text, o.created_at
         from apertura_cxp o join tercero t on t.id = o.proveedor_id join usuario cr on cr.id = o.created_by left join usuario ap on ap.id = o.aprobado_por
         left join asiento a on a.origen_tipo = 'apertura_cxp' and a.origen_id = o.id and a.tipo = 'automatico'
     ) x where ($1 = '' or x.estado = $1) order by x.created_at desc limit 300`, [estado]);
  return rows;
}
