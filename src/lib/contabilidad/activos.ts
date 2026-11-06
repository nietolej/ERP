import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { estadoArranque } from '@/lib/apertura/apertura';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/errores';
import { rangoDeMes } from './estados';
import { insertarLineasConvertidas, tasasDelDia, type LineaOriginal } from './motor';
import { dos } from '@/lib/dinero';

/**
 * Activos fijos y depreciación (spec §12.6; migración 0055; decisión 15): línea recta mensual, una sola depreciación, residual cero por defecto.
 *
 *   Alta (esta entrega: activos que ya existen al arranque): Contabilidad o Gerencia lo registran con su costo y su depreciación acumulada al arranque,
 *   Gerencia (otra persona) lo aprueba y se contabiliza contra «Saldos de apertura».
 *   Depreciación del mes: un asiento por mes (gasto contra depreciación acumulada, por categoría). Cuota = (costo − residual − depreciación de apertura) ÷ meses
 *   que le quedan; la última cuota ajusta el resto. En USD sale del costo en USD. No se salta un mes ni se repite.
 *   Baja: con aprobación de Gerencia; saca el costo y la depreciación acumulada y lleva la diferencia a pérdida por baja.
 */

export const ROLES_GESTIONAN_ACTIVOS = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_ACTIVOS = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];
export type UsuarioActivo = { id: string; roles: readonly string[] };

const MONTO = /^\d{1,14}(\.\d{1,2})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const etiquetaMes = (anio: number, mes: number) => `${NOMBRE_MES[mes - 1]} ${anio}`;

function exigir(u: UsuarioActivo) {
  if (!u.roles.some((r) => (ROLES_GESTIONAN_ACTIVOS as readonly string[]).includes(r))) throw new ErrorMaestro('Solo Contabilidad o Gerencia gestionan activos fijos.');
}
const hoyCaracas = async (db: Db) => (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;

/** Meses completos entre el mes de inicio de la depreciación y el mes dado: las cuotas que deben existir antes de ese mes. */
export function mesesDesde(inicio: string, anio: number, mes: number): number {
  return (anio - Number(inicio.slice(0, 4))) * 12 + (mes - Number(inicio.slice(5, 7)));
}

export interface PlanActivo {
  costoVes: Decimal; costoUsd: Decimal; residualVes: Decimal; residualUsd: Decimal; depAperturaVes: Decimal; depAperturaUsd: Decimal;
  vidaUtilMeses: number; mesesApertura: number;
}

/**
 * Cuota del mes de un activo que ya lleva `previas` cuotas posteriores a la apertura y `acumVes/acumUsd` de depreciación posterior a ella.
 * Devuelve null si ya no le quedan meses o importes. La última cuota toma lo que reste para no pasar del valor depreciable.
 */
export function cuotaDelMes(a: PlanActivo, previas: number, acumVes: Decimal, acumUsd: Decimal): { ves: Decimal; usd: Decimal; ultima: boolean } | null {
  const restantesIni = a.vidaUtilMeses - a.mesesApertura;
  const restantes = restantesIni - previas;
  if (restantes <= 0) return null;
  const baseVes = a.costoVes.minus(a.residualVes).minus(a.depAperturaVes);
  const baseUsd = a.costoUsd.minus(a.residualUsd).minus(a.depAperturaUsd);
  const faltaVes = Decimal.max(0, baseVes.minus(acumVes));
  const faltaUsd = Decimal.max(0, baseUsd.minus(acumUsd));
  if (faltaVes.isZero() && faltaUsd.isZero()) return null;
  const ultima = restantes === 1;
  const ves = ultima ? faltaVes : Decimal.min(faltaVes, dos(baseVes.dividedBy(restantesIni)));
  const usd = ultima ? faltaUsd : Decimal.min(faltaUsd, dos(baseUsd.dividedBy(restantesIni)));
  return { ves, usd, ultima };
}

// ---------------------------------------------------------------------
// Asiento directo con importes en VES y USD ya calculados
// ---------------------------------------------------------------------

interface LineaDoble { cuentaId: string; lado: 'D' | 'H'; ves: Decimal; usd: Decimal; glosa: string }

async function asentar(tx: Db, p: { fecha: string; descripcion: string; origen: { tipo: string; id: string }; lineas: LineaDoble[]; creadoPor: string; contabilizadoPor: string }): Promise<{ id: string; numero: string }> {
  const lineas: LineaOriginal[] = p.lineas.filter((l) => !(l.ves.isZero() && l.usd.isZero())).map((l) => ({ cuentaId: l.cuentaId, lado: l.lado, original: l.ves, glosa: l.glosa, explicito: { ves: l.ves, usd: l.usd } }));
  if (!lineas.length) throw new ErrorMaestro('El asiento no tiene importes.');
  const { rows: a } = await tx.query<{ id: string }>(
    `insert into asiento (fecha, tipo, descripcion, origen_tipo, origen_id, created_by) values ($1::date, 'automatico', $2, $3, $4, $5) returning id`,
    [p.fecha, p.descripcion, p.origen.tipo, p.origen.id, p.creadoPor]);
  await insertarLineasConvertidas(tx, a[0].id, 'VES', await tasasDelDia(tx, 'VES', p.fecha), lineas);
  const { rows } = await tx.query<{ numero: string }>(`update asiento set estado = 'contabilizado', contabilizado_por = $2 where id = $1 returning numero::text`, [a[0].id, p.contabilizadoPor]);
  return { id: a[0].id, numero: rows[0].numero };
}

async function cuentaConfigurada(tx: Db, clave: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>('select cuenta_id as id from configuracion_contable where clave = $1', [clave]);
  if (!rows[0]) throw new ErrorMaestro(`Falta configurar la cuenta «${clave}».`);
  return rows[0].id;
}

// ---------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------

export interface FilaCategoria { id: string; codigo: string; nombre: string; cuenta_activo: string; vida_util_meses: number; validada_por: string | null; validada_el: string | null; activos: number }

export async function listarCategorias(db: Db): Promise<FilaCategoria[]> {
  const { rows } = await db.query<FilaCategoria>(
    `select c.id, c.codigo, c.nombre, a.codigo as cuenta_activo, c.vida_util_meses, u.nombre as validada_por,
            to_char(c.validada_at at time zone 'America/Caracas', 'DD-MM-YYYY') as validada_el, (select count(*)::int from activo_fijo f where f.categoria_id = c.id) as activos
       from categoria_activo c join cuenta_contable a on a.id = c.cuenta_activo_id left join usuario u on u.id = c.validada_por where c.activa order by c.codigo`);
  return rows;
}

/** El contador fija o confirma la vida útil de una categoría: queda quién y cuándo. Solo rige para los activos que se registren después. */
export async function confirmarVidaUtil(tx: Db, u: UsuarioActivo, categoriaId: string, vidaUtilMeses: number): Promise<void> {
  exigir(u);
  if (!UUID.test(categoriaId)) throw new ErrorMaestro('Seleccione la categoría.');
  if (!Number.isInteger(vidaUtilMeses) || vidaUtilMeses < 1 || vidaUtilMeses > 1200) throw new ErrorMaestro('La vida útil son meses enteros, entre 1 y 1.200.');
  const { rows } = await tx.query<{ vida_util_meses: number }>('select vida_util_meses from categoria_activo where id = $1 for update', [categoriaId]);
  if (!rows[0]) throw new ErrorMaestro('La categoría no existe.');
  if (rows[0].vida_util_meses === vidaUtilMeses) {
    await tx.query('update categoria_activo set validada_por = $2, validada_at = now() where id = $1', [categoriaId, u.id]);
  } else {
    await tx.query('update categoria_activo set vida_util_meses = $2 where id = $1', [categoriaId, vidaUtilMeses]);   // el disparador deja al usuario y la fecha
  }
}

// ---------------------------------------------------------------------
// Alta (activos existentes al arranque)
// ---------------------------------------------------------------------

export interface DatosActivo {
  descripcion: string; categoriaId: string; fechaAdquisicion: string; ubicacion?: string; responsable?: string;
  costoVes: string; costoUsd: string; residualVes?: string; residualUsd?: string; mesesDepreciados?: number; depAperturaVes?: string; depAperturaUsd?: string;
}

export async function registrarActivoApertura(tx: Db, u: UsuarioActivo, d: DatosActivo): Promise<string> {
  exigir(u);
  if (d.descripcion.trim().length < 3) throw new ErrorMaestro('Describa el activo.');
  if (!UUID.test(d.categoriaId)) throw new ErrorMaestro('Seleccione la categoría.');
  if (!FECHA.test(d.fechaAdquisicion)) throw new ErrorMaestro('Indique la fecha de adquisición.');
  for (const [v, n] of [[d.costoVes, 'El costo en bolívares'], [d.costoUsd, 'El costo en dólares']] as const) {
    if (!MONTO.test(v.trim()) || new Decimal(v).lte(0)) throw new ErrorMaestro(`${n} debe ser un monto mayor que cero, con hasta 2 decimales.`);
  }
  for (const [v, n] of [[d.residualVes, 'El valor residual en bolívares'], [d.residualUsd, 'El valor residual en dólares'], [d.depAperturaVes, 'La depreciación acumulada en bolívares'], [d.depAperturaUsd, 'La depreciación acumulada en dólares']] as const) {
    if (v && v.trim() && !MONTO.test(v.trim())) throw new ErrorMaestro(`${n} debe ser un monto con hasta 2 decimales.`);
  }
  const meses = d.mesesDepreciados ?? 0;
  if (!Number.isInteger(meses) || meses < 0) throw new ErrorMaestro('Los meses ya depreciados son un número entero.');
  const arr = await estadoArranque(tx);
  if (!arr.fecha) throw new ErrorMaestro('Gerencia debe fijar primero la fecha de arranque (Configuración → Apertura).');
  if (arr.cerrada) throw new ErrorMaestro('La apertura está cerrada: ya no se registran activos existentes al arranque.');
  const { rows: cat } = await tx.query<{ vida_util_meses: number }>('select vida_util_meses from categoria_activo where id = $1 and activa', [d.categoriaId]);
  if (!cat[0]) throw new ErrorMaestro('La categoría no existe.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into activo_fijo (descripcion, categoria_id, fecha_adquisicion, ubicacion, responsable, costo_ves, costo_usd, residual_ves, residual_usd, vida_util_meses,
                              meses_depreciados_apertura, dep_apertura_ves, dep_apertura_usd, inicio_depreciacion, created_by)
     values ($1, $2, $3::date, nullif(trim($4), ''), nullif(trim($5), ''), $6, $7, $8, $9, $10, $11, $12, $13, date_trunc('month', $14::date)::date, $15) returning id`,
    [d.descripcion.trim(), d.categoriaId, d.fechaAdquisicion, d.ubicacion ?? '', d.responsable ?? '', d.costoVes.trim(), d.costoUsd.trim(), (d.residualVes || '0').trim(), (d.residualUsd || '0').trim(),
     cat[0].vida_util_meses, meses, (d.depAperturaVes || '0').trim(), (d.depAperturaUsd || '0').trim(), arr.fecha, u.id]);
  await solicitarAprobacion(tx, { tipo: 'activo_fijo', objetoId: rows[0].id, solicitanteId: u.id });
  return rows[0].id;
}

interface FilaActivoCuentas {
  estado: string; codigo: string; descripcion: string; created_by: string; costo_ves: string; costo_usd: string; residual_ves: string; residual_usd: string; dep_apertura_ves: string; dep_apertura_usd: string;
  cuenta_activo_id: string; cuenta_depreciacion_id: string; cuenta_gasto_id: string;
}

/** Lo llama el motor de aprobaciones: contabiliza el costo y la depreciación acumulada contra «Saldos de apertura». */
export async function aprobarActivo(tx: Db, id: string, aprobador: string): Promise<void> {
  const { rows } = await tx.query<FilaActivoCuentas>(
    `select f.estado, f.codigo, f.descripcion, f.created_by, f.costo_ves::text, f.costo_usd::text, f.residual_ves::text, f.residual_usd::text, f.dep_apertura_ves::text, f.dep_apertura_usd::text,
            c.cuenta_activo_id, c.cuenta_depreciacion_id, c.cuenta_gasto_id
       from activo_fijo f join categoria_activo c on c.id = f.categoria_id where f.id = $1 for update of f`, [id]);
  const a = rows[0];
  if (!a) throw new ErrorMaestro('El activo no existe.');
  if (a.estado !== 'pendiente') throw new ErrorMaestro('El activo no está pendiente de aprobación.');
  const arr = await estadoArranque(tx);
  if (!arr.fecha || arr.cerrada) throw new ErrorMaestro('La apertura debe estar abierta (con fecha de arranque) para aprobar un activo existente.');
  const costo = { ves: new Decimal(a.costo_ves), usd: new Decimal(a.costo_usd) };
  const dep = { ves: new Decimal(a.dep_apertura_ves), usd: new Decimal(a.dep_apertura_usd) };
  const asiento = await asentar(tx, {
    fecha: arr.fecha, descripcion: `Activo fijo ${a.codigo} · ${a.descripcion} (apertura)`, origen: { tipo: 'activo_fijo_apertura', id }, creadoPor: a.created_by, contabilizadoPor: aprobador,
    lineas: [
      { cuentaId: a.cuenta_activo_id, lado: 'D', ves: costo.ves, usd: costo.usd, glosa: 'Costo del activo fijo' },
      { cuentaId: a.cuenta_depreciacion_id, lado: 'H', ves: dep.ves, usd: dep.usd, glosa: 'Depreciación acumulada al arranque' },
      { cuentaId: await cuentaConfigurada(tx, 'saldos_apertura'), lado: 'H', ves: costo.ves.minus(dep.ves), usd: costo.usd.minus(dep.usd), glosa: 'Saldos de apertura' },
    ],
  });
  const depreciado = costo.ves.minus(a.residual_ves).minus(dep.ves).isZero() && costo.usd.minus(a.residual_usd).minus(dep.usd).isZero();
  await tx.query(`update activo_fijo set estado = $2, aprobado_por = $3, asiento_alta_id = $4 where id = $1`, [id, depreciado ? 'depreciado' : 'activo', aprobador, asiento.id]);
}

export async function rechazarActivo(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from activo_fijo where id = $1 for update', [id]);
  if (rows[0]?.estado !== 'pendiente') throw new ErrorMaestro('El activo no está pendiente de aprobación.');
  await tx.query(`update activo_fijo set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Depreciación del mes
// ---------------------------------------------------------------------

interface FilaDepreciable extends FilaActivoCuentas {
  id: string; vida_util_meses: number; meses_depreciados_apertura: number; inicio: string; previas: number; prev_ves: string; prev_usd: string;
}

async function depreciables(tx: Db, hasta: string, bloquear: boolean): Promise<FilaDepreciable[]> {
  const { rows } = await tx.query<FilaDepreciable>(
    `select f.id, f.estado, f.codigo, f.descripcion, f.created_by, f.costo_ves::text, f.costo_usd::text, f.residual_ves::text, f.residual_usd::text, f.dep_apertura_ves::text, f.dep_apertura_usd::text,
            f.vida_util_meses, f.meses_depreciados_apertura, f.inicio_depreciacion::text as inicio, c.cuenta_activo_id, c.cuenta_depreciacion_id, c.cuenta_gasto_id,
            (select count(*)::int from depreciacion_activo d where d.activo_id = f.id) as previas,
            (select coalesce(sum(monto_ves), 0)::text from depreciacion_activo d where d.activo_id = f.id) as prev_ves,
            (select coalesce(sum(monto_usd), 0)::text from depreciacion_activo d where d.activo_id = f.id) as prev_usd
       from activo_fijo f join categoria_activo c on c.id = f.categoria_id
      where f.estado = 'activo' and f.inicio_depreciacion <= $1::date order by f.codigo ${bloquear ? 'for update of f' : ''}`, [hasta]);
  return rows;
}

const planDe = (f: FilaDepreciable): PlanActivo => ({
  costoVes: new Decimal(f.costo_ves), costoUsd: new Decimal(f.costo_usd), residualVes: new Decimal(f.residual_ves), residualUsd: new Decimal(f.residual_usd),
  depAperturaVes: new Decimal(f.dep_apertura_ves), depAperturaUsd: new Decimal(f.dep_apertura_usd), vidaUtilMeses: f.vida_util_meses, mesesApertura: f.meses_depreciados_apertura,
});

export interface ResultadoDepreciacion { asiento: string; activos: number; totalVes: string; totalUsd: string }

/** Deprecia un mes terminado: un asiento por mes con el gasto y la depreciación acumulada por categoría. */
export async function depreciarMes(tx: Db, u: UsuarioActivo, anio: number, mes: number): Promise<ResultadoDepreciacion> {
  exigir(u);
  const { hasta } = rangoDeMes(anio, mes);
  if (hasta > (await hoyCaracas(tx))) throw new ErrorMaestro('Solo se deprecia un mes que ya terminó.');
  const { rows: p } = await tx.query<{ id: string; estado: string }>('select id, estado from periodo_contable where anio = $1 and mes = $2', [anio, mes]);
  if (!p[0]) throw new ErrorMaestro('No existe el periodo de ese mes: créelo en Periodos contables.');
  if (p[0].estado !== 'abierto') throw new ErrorMaestro('Solo se deprecia un mes abierto.');
  if ((await tx.query(`select 1 from asiento where origen_tipo = 'depreciacion_mensual' and origen_id = $1 and tipo = 'automatico'`, [p[0].id])).rows.length) {
    throw new ErrorMaestro(`${etiquetaMes(anio, mes)} ya está depreciado.`);
  }
  const filas: { f: FilaDepreciable; cuota: { ves: Decimal; usd: Decimal; ultima: boolean } }[] = [];
  for (const f of await depreciables(tx, hasta, true)) {
    const esperadas = Math.min(mesesDesde(f.inicio, anio, mes), f.vida_util_meses - f.meses_depreciados_apertura);
    if (f.previas < esperadas) throw new ErrorMaestro(`Deprecie primero los meses anteriores: a ${f.codigo} le faltan cuotas.`);
    const cuota = cuotaDelMes(planDe(f), f.previas, new Decimal(f.prev_ves), new Decimal(f.prev_usd));
    if (cuota && !(cuota.ves.isZero() && cuota.usd.isZero())) filas.push({ f, cuota });
  }
  if (!filas.length) throw new ErrorMaestro('No hay activos por depreciar en ese mes.');

  const gasto = new Map<string, { ves: Decimal; usd: Decimal }>();
  const acum = new Map<string, { ves: Decimal; usd: Decimal }>();
  const suma = (m: Map<string, { ves: Decimal; usd: Decimal }>, k: string, ves: Decimal, usd: Decimal) => {
    const x = m.get(k) ?? { ves: new Decimal(0), usd: new Decimal(0) };
    m.set(k, { ves: x.ves.plus(ves), usd: x.usd.plus(usd) });
  };
  for (const { f, cuota } of filas) { suma(gasto, f.cuenta_gasto_id, cuota.ves, cuota.usd); suma(acum, f.cuenta_depreciacion_id, cuota.ves, cuota.usd); }
  const lineas: LineaDoble[] = [
    ...[...gasto].map(([cuentaId, v]): LineaDoble => ({ cuentaId, lado: 'D', ves: v.ves, usd: v.usd, glosa: 'Gasto de depreciación' })),
    ...[...acum].map(([cuentaId, v]): LineaDoble => ({ cuentaId, lado: 'H', ves: v.ves, usd: v.usd, glosa: 'Depreciación acumulada' })),
  ];
  const as = await asentar(tx, { fecha: hasta, descripcion: `Depreciación de ${etiquetaMes(anio, mes)}`, origen: { tipo: 'depreciacion_mensual', id: p[0].id }, lineas, creadoPor: u.id, contabilizadoPor: u.id });
  for (const { f, cuota } of filas) {
    await tx.query('insert into depreciacion_activo (activo_id, periodo_id, monto_ves, monto_usd, asiento_id, created_by) values ($1, $2, $3, $4, $5, $6)',
      [f.id, p[0].id, cuota.ves.toFixed(2), cuota.usd.toFixed(2), as.id, u.id]);
    if (cuota.ultima) await tx.query(`update activo_fijo set estado = 'depreciado' where id = $1`, [f.id]);
  }
  const totalVes = [...gasto.values()].reduce((s, v) => s.plus(v.ves), new Decimal(0));
  const totalUsd = [...gasto.values()].reduce((s, v) => s.plus(v.usd), new Decimal(0));
  return { asiento: as.numero, activos: filas.length, totalVes: totalVes.toFixed(2), totalUsd: totalUsd.toFixed(2) };
}

/** Activos que todavía no tienen su cuota de ese mes (para el cierre mensual). */
export async function activosSinDepreciar(db: Db, anio: number, mes: number): Promise<string[]> {
  const { hasta } = rangoDeMes(anio, mes);
  const { rows } = await db.query<{ codigo: string; descripcion: string }>(
    `select f.codigo, f.descripcion from activo_fijo f
      where f.estado = 'activo' and f.inicio_depreciacion <= $1::date
        and not exists (select 1 from depreciacion_activo d join periodo_contable p on p.id = d.periodo_id where d.activo_id = f.id and p.anio = $2 and p.mes = $3)
      order by f.codigo`, [hasta, anio, mes]);
  return rows.map((r) => `${r.codigo} · ${r.descripcion}`);
}

// ---------------------------------------------------------------------
// Baja
// ---------------------------------------------------------------------

export async function solicitarBaja(tx: Db, u: UsuarioActivo, d: { activoId: string; fecha: string; motivo: string }): Promise<string> {
  exigir(u);
  if (!UUID.test(d.activoId)) throw new ErrorMaestro('Seleccione el activo.');
  if (!FECHA.test(d.fecha)) throw new ErrorMaestro('Indique la fecha de la baja.');
  if (d.motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la baja.');
  if (d.fecha > (await hoyCaracas(tx))) throw new ErrorMaestro('La fecha de la baja no puede ser futura.');
  const { rows: a } = await tx.query<{ estado: string; fecha_adquisicion: string }>('select estado, fecha_adquisicion::text from activo_fijo where id = $1 for update', [d.activoId]);
  if (!a[0]) throw new ErrorMaestro('El activo no existe.');
  if (!['activo', 'depreciado'].includes(a[0].estado)) throw new ErrorMaestro('Solo se da de baja un activo vigente.');
  if (d.fecha < a[0].fecha_adquisicion) throw new ErrorMaestro('La baja no puede ser anterior a la adquisición.');
  const { rows } = await tx.query<{ id: string }>('insert into baja_activo (activo_id, fecha, motivo, created_by) values ($1, $2::date, $3, $4) returning id', [d.activoId, d.fecha, d.motivo.trim(), u.id]);
  await solicitarAprobacion(tx, { tipo: 'baja_activo_fijo', objetoId: rows[0].id, solicitanteId: u.id });
  return rows[0].id;
}

/** Lo llama el motor de aprobaciones: saca el costo y la depreciación acumulada y lleva la diferencia a pérdida por baja. */
export async function aprobarBaja(tx: Db, id: string, aprobador: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string; fecha: string; activo_id: string; created_by: string; numero: string }>(
    'select estado, fecha::text, activo_id, created_by, numero::text from baja_activo where id = $1 for update', [id]);
  const b = rows[0];
  if (!b) throw new ErrorMaestro('La baja no existe.');
  if (b.estado !== 'pendiente') throw new ErrorMaestro('La baja no está pendiente de aprobación.');
  const { rows: a } = await tx.query<FilaActivoCuentas & { inicio: string; vida_util_meses: number; meses_depreciados_apertura: number; previas: number; prev_ves: string; prev_usd: string }>(
    `select f.estado, f.codigo, f.descripcion, f.created_by, f.costo_ves::text, f.costo_usd::text, f.residual_ves::text, f.residual_usd::text, f.dep_apertura_ves::text, f.dep_apertura_usd::text,
            f.inicio_depreciacion::text as inicio, f.vida_util_meses, f.meses_depreciados_apertura, c.cuenta_activo_id, c.cuenta_depreciacion_id, c.cuenta_gasto_id,
            (select count(*)::int from depreciacion_activo d where d.activo_id = f.id) as previas,
            (select coalesce(sum(monto_ves), 0)::text from depreciacion_activo d where d.activo_id = f.id) as prev_ves,
            (select coalesce(sum(monto_usd), 0)::text from depreciacion_activo d where d.activo_id = f.id) as prev_usd
       from activo_fijo f join categoria_activo c on c.id = f.categoria_id where f.id = $1 for update of f`, [b.activo_id]);
  const f = a[0];
  if (!['activo', 'depreciado'].includes(f.estado)) throw new ErrorMaestro('El activo ya no está vigente.');
  const anio = Number(b.fecha.slice(0, 4));
  const mes = Number(b.fecha.slice(5, 7));
  const esperadas = Math.min(Math.max(0, mesesDesde(f.inicio, anio, mes)), f.vida_util_meses - f.meses_depreciados_apertura);
  if (f.previas < esperadas) throw new ErrorMaestro('Antes de dar de baja el activo, deprecie los meses anteriores a la fecha de la baja.');

  const costo = { ves: new Decimal(f.costo_ves), usd: new Decimal(f.costo_usd) };
  const acum = { ves: new Decimal(f.dep_apertura_ves).plus(f.prev_ves), usd: new Decimal(f.dep_apertura_usd).plus(f.prev_usd) };
  const perdida = { ves: costo.ves.minus(acum.ves), usd: costo.usd.minus(acum.usd) };
  const as = await asentar(tx, {
    fecha: b.fecha, descripcion: `Baja del activo ${f.codigo} · ${f.descripcion}`, origen: { tipo: 'baja_activo_fijo', id }, creadoPor: b.created_by, contabilizadoPor: aprobador,
    lineas: [
      { cuentaId: f.cuenta_depreciacion_id, lado: 'D', ves: acum.ves, usd: acum.usd, glosa: 'Depreciación acumulada del activo dado de baja' },
      { cuentaId: await cuentaConfigurada(tx, 'perdida_baja_activo'), lado: 'D', ves: perdida.ves, usd: perdida.usd, glosa: 'Pérdida por baja de activo fijo' },
      { cuentaId: f.cuenta_activo_id, lado: 'H', ves: costo.ves, usd: costo.usd, glosa: 'Costo del activo dado de baja' },
    ],
  });
  await tx.query(`update baja_activo set estado = 'aprobada', aprobado_por = $2, costo_ves = $3, depreciacion_ves = $4, perdida_ves = $5, asiento_id = $6 where id = $1`,
    [id, aprobador, costo.ves.toFixed(2), acum.ves.toFixed(2), perdida.ves.toFixed(2), as.id]);
  await tx.query(`update activo_fijo set estado = 'dado_de_baja' where id = $1`, [b.activo_id]);
}

export async function rechazarBaja(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from baja_activo where id = $1 for update', [id]);
  if (rows[0]?.estado !== 'pendiente') throw new ErrorMaestro('La baja no está pendiente de aprobación.');
  await tx.query(`update baja_activo set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas y auxiliar
// ---------------------------------------------------------------------

export interface FilaActivo {
  id: string; codigo: string; descripcion: string; categoria: string; estado: string; fecha_adquisicion: string; costo_usd: string; costo_ves: string;
  depreciacion_ves: string; depreciacion_usd: string; valor_libros_ves: string; ubicacion: string | null; responsable: string | null;
}

export async function listarActivos(db: Db): Promise<FilaActivo[]> {
  const { rows } = await db.query<FilaActivo>(
    `select f.id, f.codigo, f.descripcion, c.nombre as categoria, f.estado, f.fecha_adquisicion::text, f.costo_usd::text, f.costo_ves::text,
            (f.dep_apertura_ves + coalesce(d.ves, 0))::text as depreciacion_ves, (f.dep_apertura_usd + coalesce(d.usd, 0))::text as depreciacion_usd,
            (f.costo_ves - f.dep_apertura_ves - coalesce(d.ves, 0))::text as valor_libros_ves, f.ubicacion, f.responsable
       from activo_fijo f join categoria_activo c on c.id = f.categoria_id
       left join (select activo_id, sum(monto_ves) as ves, sum(monto_usd) as usd from depreciacion_activo group by activo_id) d on d.activo_id = f.id
      order by f.codigo desc`);
  return rows;
}

export interface DetalleActivo {
  activo: FilaActivo & { vida_util_meses: number; meses_apertura: number; residual_ves: string; creador: string; aprobador: string | null; rechazo_motivo: string | null; inicio: string; asiento: string | null };
  cuotas: { periodo: string; monto_ves: string; monto_usd: string; asiento: string }[];
  baja: { id: string; numero: string; fecha: string; estado: string; motivo: string; rechazo_motivo: string | null; creador: string } | null;
}

export async function detalleActivo(db: Db, id: string): Promise<DetalleActivo | null> {
  const todos = (await listarActivos(db)).find((a) => a.id === id);
  if (!todos) return null;
  const { rows } = await db.query<{ vida_util_meses: number; meses_apertura: number; residual_ves: string; creador: string; aprobador: string | null; rechazo_motivo: string | null; inicio: string; asiento: string | null }>(
    `select f.vida_util_meses, f.meses_depreciados_apertura as meses_apertura, f.residual_ves::text, u.nombre as creador, a.nombre as aprobador, f.rechazo_motivo, f.inicio_depreciacion::text as inicio, x.numero::text as asiento
       from activo_fijo f join usuario u on u.id = f.created_by left join usuario a on a.id = f.aprobado_por left join asiento x on x.id = f.asiento_alta_id where f.id = $1`, [id]);
  const { rows: cuotas } = await db.query<DetalleActivo['cuotas'][number]>(
    `select p.anio || '-' || lpad(p.mes::text, 2, '0') as periodo, d.monto_ves::text, d.monto_usd::text, x.numero::text as asiento
       from depreciacion_activo d join periodo_contable p on p.id = d.periodo_id join asiento x on x.id = d.asiento_id where d.activo_id = $1 order by p.anio, p.mes`, [id]);
  const { rows: baja } = await db.query<NonNullable<DetalleActivo['baja']>>(
    `select b.id, b.numero::text, b.fecha::text, b.estado, b.motivo, b.rechazo_motivo, u.nombre as creador from baja_activo b join usuario u on u.id = b.created_by where b.activo_id = $1 and b.estado <> 'rechazada'`, [id]);
  return { activo: { ...todos, ...rows[0] }, cuotas, baja: baja[0] ?? null };
}

/** Auxiliar de activos fijos: costo y depreciación acumulada de los activos vigentes, en VES y USD, contra las cuentas de sus categorías. */
export async function saldoAuxiliarActivos(db: Db): Promise<{ costoVes: Decimal; costoUsd: Decimal; depVes: Decimal; depUsd: Decimal; mayorCostoVes: Decimal; mayorCostoUsd: Decimal; mayorDepVes: Decimal; mayorDepUsd: Decimal }> {
  const { rows: a } = await db.query<{ cves: string; cusd: string; dves: string; dusd: string }>(
    `select coalesce(sum(f.costo_ves), 0)::text as cves, coalesce(sum(f.costo_usd), 0)::text as cusd,
            coalesce(sum(f.dep_apertura_ves + coalesce(d.ves, 0)), 0)::text as dves, coalesce(sum(f.dep_apertura_usd + coalesce(d.usd, 0)), 0)::text as dusd
       from activo_fijo f left join (select activo_id, sum(monto_ves) as ves, sum(monto_usd) as usd from depreciacion_activo group by activo_id) d on d.activo_id = f.id
      where f.estado in ('activo', 'depreciado')`);
  const { rows: m } = await db.query<{ cves: string; cusd: string; dves: string; dusd: string }>(
    `select coalesce(sum(l.debe_ves - l.haber_ves) filter (where l.cuenta_id in (select cuenta_activo_id from categoria_activo)), 0)::text as cves,
            coalesce(sum(l.debe_usd - l.haber_usd) filter (where l.cuenta_id in (select cuenta_activo_id from categoria_activo)), 0)::text as cusd,
            coalesce(sum(l.haber_ves - l.debe_ves) filter (where l.cuenta_id in (select cuenta_depreciacion_id from categoria_activo)), 0)::text as dves,
            coalesce(sum(l.haber_usd - l.debe_usd) filter (where l.cuenta_id in (select cuenta_depreciacion_id from categoria_activo)), 0)::text as dusd
       from asiento_linea l join asiento x on x.id = l.asiento_id and x.estado = 'contabilizado'`);
  return {
    costoVes: new Decimal(a[0].cves), costoUsd: new Decimal(a[0].cusd), depVes: new Decimal(a[0].dves), depUsd: new Decimal(a[0].dusd),
    mayorCostoVes: new Decimal(m[0].cves), mayorCostoUsd: new Decimal(m[0].cusd), mayorDepVes: new Decimal(m[0].dves), mayorDepUsd: new Decimal(m[0].dusd),
  };
}
