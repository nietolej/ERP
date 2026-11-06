import Decimal from 'decimal.js';
import { guardarAdjunto } from '@/lib/adjuntos/adjuntos';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/errores';
import type { Soporte, UsuarioGasto } from './gastos';
import { ROLES_CUSTODIO, ROLES_SOLICITAN_REPOSICION, ROLES_VEN_CAJA } from './roles';

/**
 * Caja chica (spec §10.1; migración 0040): fondo fijo por custodio y moneda.
 *
 *   Gerencia crea el fondo (monto fijo y tope por vale) → se constituye desde un banco con aprobación de Gerencia (distinta de quien lo pidió)
 *   → el custodio registra vales con su soporte (sin aprobación, bajo el tope y sin pasar del saldo) → la reposición reúne los vales aún no
 *   repuestos y devuelve el fondo a su monto fijo, también con aprobación de Gerencia.
 *
 * Cada vale gasta el fondo al registrarse: el saldo de la caja en el mayor es siempre el efectivo que debe haber en el fondo (R-CI, R-CJ).
 */

export { ROLES_CUSTODIO, ROLES_SOLICITAN_REPOSICION, ROLES_VEN_CAJA };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^\d{1,12}(\.\d{1,2})?$/;
const tieneRol = (u: UsuarioGasto, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));

export const NOMBRE_ESTADO_VALE: Record<string, string> = { registrado: 'Registrado', repuesto: 'Repuesto', anulado: 'Anulado' };
export const NOMBRE_ESTADO_REPOSICION: Record<string, string> = { pendiente: 'Pendiente de Gerencia', aprobada: 'Aprobada', rechazada: 'Rechazada' };
export const NOMBRE_TIPO_REPOSICION: Record<string, string> = { constitucion: 'Constitución del fondo', reposicion: 'Reposición' };

/** Las transiciones de un vale las permite la base solo con este indicador (R-CJ). */
async function modoCaja(tx: Db): Promise<void> {
  await tx.query(`select set_config('app.caja_interno', '1', true)`);
}

// ---------------------------------------------------------------------
// Fondo
// ---------------------------------------------------------------------

export interface DatosFondo { nombre: string; custodioId: string; cuentaBancariaId: string; montoFijo: string; topeVale: string }

export async function crearFondo(tx: Db, u: UsuarioGasto, d: DatosFondo): Promise<{ id: string; codigo: string }> {
  if (!tieneRol(u, ['gerencia'])) throw new ErrorMaestro('Solo Gerencia crea fondos de caja chica.');
  if (d.nombre.trim().length < 3) throw new ErrorMaestro('Indique el nombre del fondo.');
  if (!d.custodioId) throw new ErrorMaestro('Seleccione el custodio.');
  if (!d.cuentaBancariaId) throw new ErrorMaestro('Seleccione la caja donde estará el efectivo.');
  if (!MONTO.test(d.montoFijo.trim()) || new Decimal(d.montoFijo).lte(0)) throw new ErrorMaestro('El monto del fondo debe ser mayor que cero, con hasta 2 decimales.');
  if (!MONTO.test(d.topeVale.trim()) || new Decimal(d.topeVale).lte(0)) throw new ErrorMaestro('El tope por vale debe ser mayor que cero, con hasta 2 decimales.');
  if (new Decimal(d.topeVale).gt(d.montoFijo)) throw new ErrorMaestro('El tope por vale no puede pasar del monto del fondo.');
  const { rows: rol } = await tx.query('select 1 from usuario_rol where usuario_id = $1 and rol = any($2::text[])', [d.custodioId, [...ROLES_CUSTODIO]]);
  if (!rol.length) throw new ErrorMaestro('El custodio necesita el rol de Tesorería, Contabilidad o Gerencia para manejar su fondo.');
  const { rows } = await tx.query<{ id: string; codigo: string }>(
    `insert into fondo_caja (nombre, custodio_id, cuenta_bancaria_id, monto_fijo, tope_vale, moneda, created_by) values ($1, $2, $3, $4, $5, 'VES', $6) returning id, codigo`,
    [d.nombre.trim(), d.custodioId, d.cuentaBancariaId, d.montoFijo.trim(), d.topeVale.trim(), u.id]);
  return rows[0];
}

export async function cambiarEstadoFondo(tx: Db, u: UsuarioGasto, id: string, activo: boolean): Promise<void> {
  if (!tieneRol(u, ['gerencia'])) throw new ErrorMaestro('Solo Gerencia activa o inactiva fondos de caja chica.');
  if (!activo) {
    const { rows } = await tx.query<{ saldo: string; por_reponer: string; en_reposicion: string }>(
      'select saldo::text, por_reponer::text, en_reposicion::text from vw_fondo_caja_saldo where fondo_id = $1', [id]);
    if (rows[0] && (new Decimal(rows[0].saldo).gt(0) || new Decimal(rows[0].por_reponer).gt(0) || new Decimal(rows[0].en_reposicion).gt(0))) {
      throw new ErrorMaestro('Cierre el fondo cuando no tenga efectivo ni vales pendientes de reposición.');
    }
  }
  const { rows } = await tx.query('update fondo_caja set activo = $2 where id = $1 returning id', [id, activo]);
  if (!rows[0]) throw new ErrorMaestro('El fondo no existe.');
}

export interface FilaFondo {
  id: string; codigo: string; nombre: string; custodio_id: string; custodio: string; moneda: string; monto_fijo: string; tope_vale: string; activo: boolean;
  saldo: string; por_reponer: string; en_reposicion: string; constituido: boolean;
}

const SQL_FONDO = `select f.id, f.codigo, f.nombre, f.custodio_id, cu.nombre as custodio, f.moneda, f.monto_fijo::text, f.tope_vale::text, f.activo,
       s.saldo::text, s.por_reponer::text, s.en_reposicion::text,
       exists (select 1 from reposicion_caja r where r.fondo_id = f.id and r.tipo = 'constitucion' and r.estado = 'aprobada') as constituido
  from fondo_caja f join vw_fondo_caja_saldo s on s.fondo_id = f.id join usuario cu on cu.id = f.custodio_id`;

/** Un custodio ve su fondo; Tesorería, Contabilidad, Auditor y Gerencia ven todos. */
export function veFondo(u: UsuarioGasto, f: { custodio_id: string }): boolean {
  return tieneRol(u, ROLES_VEN_CAJA) || f.custodio_id === u.id;
}

export async function listarFondos(db: Db, u: UsuarioGasto): Promise<FilaFondo[]> {
  const { rows } = await db.query<FilaFondo>(`${SQL_FONDO} order by f.activo desc, f.codigo`);
  return rows.filter((f) => veFondo(u, f));
}

export async function detalleFondo(db: Db, id: string): Promise<FilaFondo | null> {
  const { rows } = await db.query<FilaFondo>(`${SQL_FONDO} where f.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function cajasLibres(db: Db): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(
    `select cb.id, cb.codigo || ' · ' || cb.nombre || ' · ' || cb.moneda as texto from cuenta_bancaria cb
      where cb.tipo = 'caja' and cb.activa and not exists (select 1 from fondo_caja f where f.cuenta_bancaria_id = cb.id) order by cb.codigo`);
  return rows;
}

export async function cuentasOrigen(db: Db, moneda: string): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(
    `select cb.id, cb.codigo || ' · ' || cb.nombre as texto from cuenta_bancaria cb where cb.tipo <> 'caja' and cb.activa and cb.moneda = $1 order by cb.codigo`, [moneda]);
  return rows;
}

export async function custodiosPosibles(db: Db): Promise<{ id: string; texto: string }[]> {
  const { rows } = await db.query<{ id: string; texto: string }>(
    `select distinct u.id, u.nombre as texto from usuario u join usuario_rol r on r.usuario_id = u.id where u.activo and r.rol = any($1::text[]) order by u.nombre`, [[...ROLES_CUSTODIO]]);
  return rows;
}

// ---------------------------------------------------------------------
// Vales
// ---------------------------------------------------------------------

export interface DatosVale {
  fondoId: string;
  fecha: string;
  categoriaId: string;
  beneficiario: string;
  descripcion: string;
  comprobante?: string;
  /** Con número de control (factura fiscal) el IVA es crédito fiscal si la categoría lo permite. */
  control?: string;
  /** Monto sin IVA. */
  base: string;
  alicuotaIvaId: string;
}

/** Registra un vale con su soporte: gasta el fondo y se contabiliza al instante (sin aprobación, bajo el tope). */
export async function registrarVale(tx: Db, u: UsuarioGasto, d: DatosVale, soporte: Soporte): Promise<{ id: string; numero: string; asiento: string }> {
  if (!FECHA.test(d.fecha)) throw new ErrorMaestro('Indique la fecha del vale.');
  if (!d.categoriaId) throw new ErrorMaestro('Seleccione la categoría del gasto.');
  if (d.beneficiario.trim().length < 3) throw new ErrorMaestro('Indique a quién se le pagó.');
  if (d.descripcion.trim().length < 3) throw new ErrorMaestro('Describa el gasto.');
  if ((d.comprobante ?? '').trim().length > 40 || (d.control ?? '').trim().length > 40) throw new ErrorMaestro('El comprobante y el control admiten hasta 40 caracteres.');
  if (!MONTO.test(d.base.trim()) || new Decimal(d.base).lte(0)) throw new ErrorMaestro('El monto debe ser mayor que cero, con hasta 2 decimales.');
  if (!d.alicuotaIvaId) throw new ErrorMaestro('Seleccione la alícuota de IVA (use la exenta si el comprobante no discrimina IVA).');
  if (!soporte?.bytes?.length) throw new ErrorMaestro('Adjunte el soporte del vale (PDF o imagen).');

  const { rows } = await tx.query<{
    id: string; numero: string; fecha: string; moneda: string; base: string; iva: string; total: string; iva_credito: boolean;
    cuenta_gasto: string; centro_costo_id: string | null; cuenta_caja: string; categoria: string;
  }>(
    `with nuevo as (
       insert into vale_caja (fondo_id, fecha, categoria_id, beneficiario, descripcion, comprobante, control, base, alicuota_iva_id, created_by,
                              moneda, tasa, alicuota_pct, iva, total, total_usd, iva_credito)
       values ($1, $2::date, $3, $4, $5, nullif(trim($6), ''), nullif(trim($7), ''), $8, $9, $10, 'VES', 1, 0, 0, 0, 0, false)
       returning id, numero, fecha, moneda, base, iva, total, iva_credito, categoria_id, fondo_id)
     select n.id, n.numero::text, n.fecha::text, n.moneda, n.base::text, n.iva::text, n.total::text, n.iva_credito,
            k.cuenta_contable_id as cuenta_gasto, k.centro_costo_id, cb.cuenta_contable_id as cuenta_caja, k.nombre as categoria
       from nuevo n join categoria_gasto k on k.id = n.categoria_id join fondo_caja f on f.id = n.fondo_id join cuenta_bancaria cb on cb.id = f.cuenta_bancaria_id`,
    [d.fondoId, d.fecha, d.categoriaId, d.beneficiario.trim(), d.descripcion.trim(), d.comprobante ?? '', d.control ?? '', d.base.trim(), d.alicuotaIvaId, u.id]);
  const v = rows[0];
  await guardarAdjunto(tx, soporte.almacen, u.id, { tipo: 'vale_caja', entidadId: v.id, nombre: soporte.nombre, bytes: soporte.bytes });

  const gasto = v.iva_credito ? new Decimal(v.base) : new Decimal(v.total);
  const r = await contabilizar(tx, {
    evento: 'vale_caja', fecha: v.fecha, descripcion: `Vale de caja chica ${v.numero} · ${d.beneficiario.trim()} · ${v.categoria}`,
    origen: { tipo: 'vale_caja', id: v.id }, moneda: v.moneda,
    importes: { gasto: gasto.toFixed(2), iva: v.iva_credito ? v.iva : '0.00', total: v.total },
    cuentas: { gasto: v.cuenta_gasto, caja: v.cuenta_caja }, centroCostoId: v.centro_costo_id ?? undefined, usuarioId: u.id,
  });
  return { id: v.id, numero: v.numero, asiento: r.numero };
}

/** Anula un vale que no esté en una reposición: reversa el asiento y el fondo recupera el efectivo. */
export async function anularVale(tx: Db, u: UsuarioGasto, id: string, motivo: string): Promise<void> {
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  const { rows } = await tx.query<{ estado: string; reposicion_id: string | null; custodio_id: string }>(
    `select v.estado, v.reposicion_id, f.custodio_id from vale_caja v join fondo_caja f on f.id = v.fondo_id where v.id = $1 for update of v`, [id]);
  if (!rows[0]) throw new ErrorMaestro('El vale no existe.');
  if (rows[0].custodio_id !== u.id && !tieneRol(u, ['gerencia'])) throw new ErrorMaestro('Solo el custodio del fondo o Gerencia anulan vales.');
  if (rows[0].estado !== 'registrado' || rows[0].reposicion_id) throw new ErrorMaestro('Solo se anula un vale que todavía no esté en una reposición.');
  const { rows: a } = await tx.query<{ id: string }>(`select id from asiento where origen_tipo = 'vale_caja' and origen_id = $1 and tipo = 'automatico'`, [id]);
  if (!a[0]) throw new ErrorMaestro('El vale no tiene asiento: avise al administrador.');
  await modoCaja(tx);
  await tx.query(`update vale_caja set estado = 'anulado', anulado_motivo = $2, anulado_por = $3 where id = $1`, [id, motivo.trim(), u.id]);
  await tx.query(`select fn_reversar_asiento($1, ((now() at time zone 'America/Caracas')::date), $2)`, [a[0].id, `Anulación del vale de caja chica: ${motivo.trim()}`]);
}

// ---------------------------------------------------------------------
// Constitución y reposición
// ---------------------------------------------------------------------

async function fondoBloqueado(tx: Db, id: string) {
  const { rows } = await tx.query<{ id: string; custodio_id: string; monto_fijo: string; moneda: string; activo: boolean }>(
    'select id, custodio_id, monto_fijo::text, moneda, activo from fondo_caja where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El fondo no existe.');
  return rows[0];
}

function exigirSolicitante(u: UsuarioGasto, custodioId: string) {
  if (!tieneRol(u, ROLES_SOLICITAN_REPOSICION) && u.id !== custodioId) throw new ErrorMaestro('Solo Tesorería, Gerencia o el custodio piden la constitución o la reposición del fondo.');
}

/** Pide el dinero para constituir el fondo por su monto fijo; Gerencia (distinta de quien lo pide) lo aprueba. */
export async function solicitarConstitucion(tx: Db, u: UsuarioGasto, fondoId: string, cuentaOrigenId: string, referencia?: string): Promise<{ id: string; numero: string }> {
  const f = await fondoBloqueado(tx, fondoId);
  exigirSolicitante(u, f.custodio_id);
  if (!cuentaOrigenId) throw new ErrorMaestro('Seleccione la cuenta de donde sale el dinero.');
  const { rows } = await tx.query<{ id: string; numero: string }>(
    `insert into reposicion_caja (fondo_id, tipo, cuenta_origen_id, monto, moneda, referencia, created_by) values ($1, 'constitucion', $2, $3, $4, nullif(trim($5), ''), $6)
     returning id, numero::text`, [fondoId, cuentaOrigenId, f.monto_fijo, f.moneda, referencia ?? '', u.id]);
  await solicitarAprobacion(tx, { tipo: 'reposicion_caja', objetoId: rows[0].id, solicitanteId: u.id, contexto: { monto: new Decimal(f.monto_fijo).toNumber() } });
  return rows[0];
}

/** Pide la reposición de todos los vales aún no repuestos: su monto es exactamente lo gastado (R-CJ). */
export async function solicitarReposicion(tx: Db, u: UsuarioGasto, fondoId: string, cuentaOrigenId: string, referencia?: string): Promise<{ id: string; numero: string; monto: string }> {
  const f = await fondoBloqueado(tx, fondoId);
  exigirSolicitante(u, f.custodio_id);
  if (!cuentaOrigenId) throw new ErrorMaestro('Seleccione la cuenta de donde sale el dinero.');
  const { rows: cons } = await tx.query(`select 1 from reposicion_caja where fondo_id = $1 and tipo = 'constitucion' and estado = 'aprobada'`, [fondoId]);
  if (!cons.length) throw new ErrorMaestro('El fondo todavía no se ha constituido.');
  const { rows: v } = await tx.query<{ id: string; total: string }>(
    `select id, total::text from vale_caja where fondo_id = $1 and estado = 'registrado' and reposicion_id is null order by numero for update`, [fondoId]);
  if (!v.length) throw new ErrorMaestro('No hay vales por reponer.');
  const monto = v.reduce((s, x) => s.plus(x.total), new Decimal(0));
  const { rows } = await tx.query<{ id: string; numero: string }>(
    `insert into reposicion_caja (fondo_id, tipo, cuenta_origen_id, monto, moneda, referencia, created_by) values ($1, 'reposicion', $2, $3, $4, nullif(trim($5), ''), $6)
     returning id, numero::text`, [fondoId, cuentaOrigenId, monto.toFixed(2), f.moneda, referencia ?? '', u.id]);
  await modoCaja(tx);
  await tx.query('update vale_caja set reposicion_id = $2 where id = any($1::uuid[])', [v.map((x) => x.id), rows[0].id]);
  await solicitarAprobacion(tx, { tipo: 'reposicion_caja', objetoId: rows[0].id, solicitanteId: u.id, contexto: { monto: monto.toNumber() } });
  return { ...rows[0], monto: monto.toFixed(2) };
}

/** Lo llama el motor de flujo cuando Gerencia aprueba: el dinero entra a la caja, los vales quedan repuestos y se contabiliza. */
export async function aprobarReposicion(tx: Db, id: string, aprobador: string): Promise<{ asiento: string }> {
  const { rows } = await tx.query<{
    estado: string; tipo: string; fondo_id: string; monto: string; moneda: string; numero: string; cuenta_caja: string; cuenta_banco: string; codigo: string;
  }>(
    `select r.estado, r.tipo, r.fondo_id, r.monto::text, r.moneda, r.numero::text, cc.cuenta_contable_id as cuenta_caja, co.cuenta_contable_id as cuenta_banco, f.codigo
       from reposicion_caja r join fondo_caja f on f.id = r.fondo_id join cuenta_bancaria cc on cc.id = f.cuenta_bancaria_id
       join cuenta_bancaria co on co.id = r.cuenta_origen_id where r.id = $1 for update of r`, [id]);
  const r = rows[0];
  if (!r) throw new ErrorMaestro('La reposición no existe.');
  if (r.estado !== 'pendiente') throw new ErrorMaestro('La reposición no está pendiente de aprobación.');
  await tx.query(`update reposicion_caja set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, aprobador]);
  if (r.tipo === 'reposicion') {
    await modoCaja(tx);
    await tx.query(`update vale_caja set estado = 'repuesto' where reposicion_id = $1 and estado = 'registrado'`, [id]);
  }
  const { rows: h } = await tx.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`);
  const a = await contabilizar(tx, {
    evento: 'reposicion_caja', fecha: h[0].hoy, descripcion: `${NOMBRE_TIPO_REPOSICION[r.tipo]} de caja chica ${r.codigo} · ${r.numero}`,
    origen: { tipo: 'reposicion_caja', id }, moneda: r.moneda, importes: { monto: r.monto },
    cuentas: { caja: r.cuenta_caja, banco: r.cuenta_banco }, usuarioId: aprobador,
  });
  return { asiento: a.numero };
}

export async function rechazarReposicion(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from reposicion_caja where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La reposición no existe.');
  if (rows[0].estado !== 'pendiente') throw new ErrorMaestro('La reposición no está pendiente de aprobación.');
  await tx.query(`update reposicion_caja set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
  await modoCaja(tx);
  await tx.query(`update vale_caja set reposicion_id = null where reposicion_id = $1 and estado = 'registrado'`, [id]);   // los vales vuelven a estar por reponer
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaVale {
  id: string; numero: string; fecha: string; categoria: string; beneficiario: string; descripcion: string; comprobante: string | null; moneda: string;
  total: string; iva: string; iva_credito: boolean; estado: string; reposicion: string | null; anulado_motivo: string | null; creador: string; asiento: string | null;
}

export async function valesDeFondo(db: Db, fondoId: string, limite = 200): Promise<FilaVale[]> {
  const { rows } = await db.query<FilaVale>(
    `select v.id, v.numero::text, to_char(v.fecha, 'DD-MM-YYYY') as fecha, k.nombre as categoria, v.beneficiario, v.descripcion, v.comprobante, v.moneda,
            v.total::text, v.iva::text, v.iva_credito, v.estado, r.numero::text as reposicion, v.anulado_motivo, cr.nombre as creador, a.numero::text as asiento
       from vale_caja v join categoria_gasto k on k.id = v.categoria_id join usuario cr on cr.id = v.created_by
       left join reposicion_caja r on r.id = v.reposicion_id
       left join asiento a on a.origen_tipo = 'vale_caja' and a.origen_id = v.id and a.tipo = 'automatico'
      where v.fondo_id = $1 order by v.numero desc limit $2`, [fondoId, limite]);
  return rows;
}

export interface FilaReposicion {
  id: string; numero: string; tipo: string; estado: string; monto: string; moneda: string; cuenta_origen: string; referencia: string | null;
  creador_id: string; creador: string; creado: string; aprobado_por: string | null; aprobado: string | null; rechazo_motivo: string | null;
  fondo_id: string; fondo: string; asiento: string | null; vales: number;
}

const SQL_REPOSICION = `select r.id, r.numero::text, r.tipo, r.estado, r.monto::text, r.moneda, cb.codigo || ' · ' || cb.nombre as cuenta_origen, r.referencia,
       r.created_by as creador_id, cr.nombre as creador, to_char(r.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creado,
       ap.nombre as aprobado_por, to_char(r.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado, r.rechazo_motivo,
       r.fondo_id, f.codigo || ' · ' || f.nombre as fondo, a.numero::text as asiento, (select count(*)::int from vale_caja v where v.reposicion_id = r.id) as vales
  from reposicion_caja r join fondo_caja f on f.id = r.fondo_id join cuenta_bancaria cb on cb.id = r.cuenta_origen_id join usuario cr on cr.id = r.created_by
  left join usuario ap on ap.id = r.aprobado_por left join asiento a on a.origen_tipo = 'reposicion_caja' and a.origen_id = r.id and a.tipo = 'automatico'`;

export async function reposicionesDeFondo(db: Db, fondoId: string): Promise<FilaReposicion[]> {
  const { rows } = await db.query<FilaReposicion>(`${SQL_REPOSICION} where r.fondo_id = $1 order by r.numero desc`, [fondoId]);
  return rows;
}

export async function detalleReposicion(db: Db, id: string): Promise<FilaReposicion | null> {
  const { rows } = await db.query<FilaReposicion>(`${SQL_REPOSICION} where r.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function valesDeReposicion(db: Db, id: string): Promise<FilaVale[]> {
  const { rows } = await db.query<FilaVale>(
    `select v.id, v.numero::text, to_char(v.fecha, 'DD-MM-YYYY') as fecha, k.nombre as categoria, v.beneficiario, v.descripcion, v.comprobante, v.moneda,
            v.total::text, v.iva::text, v.iva_credito, v.estado, null::text as reposicion, v.anulado_motivo, cr.nombre as creador, null::text as asiento
       from vale_caja v join categoria_gasto k on k.id = v.categoria_id join usuario cr on cr.id = v.created_by where v.reposicion_id = $1 order by v.numero`, [id]);
  return rows;
}

export interface CuadreFondo { fondo_id: string; codigo: string; moneda: string; auxiliar: string; mayor: string; cuadra: boolean }

/** El saldo de cada fondo contra el saldo de su caja en el mayor (en la moneda del fondo). */
export async function cuadreCaja(db: Db): Promise<CuadreFondo[]> {
  const { rows } = await db.query<Omit<CuadreFondo, 'cuadra'>>(
    `select s.fondo_id, s.codigo, s.moneda, s.saldo::text as auxiliar,
            coalesce((select sum(case when s.moneda = 'USD' then l.debe_usd - l.haber_usd else l.debe_ves - l.haber_ves end)
                        from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                       where l.cuenta_id = cb.cuenta_contable_id), 0)::text as mayor
       from vw_fondo_caja_saldo s join fondo_caja f on f.id = s.fondo_id join cuenta_bancaria cb on cb.id = f.cuenta_bancaria_id order by s.codigo`);
  return rows.map((r) => ({ ...r, cuadra: new Decimal(r.auxiliar).equals(r.mayor) }));
}
