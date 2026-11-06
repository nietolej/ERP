import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { insertarLineasConvertidas, tasasDelDia, type LineaOriginal } from './motor';
import { rangoDeMes } from './estados';

/**
 * Revaluación mensual de partidas monetarias en divisas (decisión 1; migración 0054).
 *
 * Al cierre del mes las partidas en dólares se valoran a la tasa BCV del último día y la diferencia contra su valor en libros va a diferencial cambiario:
 *   bancos y cajas en USD (desde el mayor de su cuenta), cuentas por pagar en USD, anticipos de clientes en USD (pasivo) y anticipos a proveedores en USD (activo).
 * Solo mueve bolívares: el valor en USD de cada partida no cambia. El Jefe de contabilidad, distinto de quien propone, aprueba; al aprobar se contabiliza el
 * asiento de ajuste con fecha del último día y su reverso el primer día del mes siguiente, de modo que la revaluación solo vale para el balance del cierre y los
 * documentos que siguen usan los valores históricos. El mayor de cada banco se lee sin los asientos de ajuste y de su reverso: el cálculo da lo mismo antes y después de aprobar.
 * Las cuentas por pagar y los anticipos se leen con su saldo de hoy (como el cuadre de auxiliares): se revalúa al cerrar el mes, no meses después.
 */

export const ROLES_PROPONEN_REVALUACION = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_REVALUACION = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];
export type UsuarioReval = { id: string; roles: readonly string[] };

const dos = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const NO_AJUSTE = `not (a.tipo = 'ajuste_cambiario' or (a.tipo = 'reverso' and exists (select 1 from asiento o where o.id = a.reversa_de and o.tipo = 'ajuste_cambiario')))`;

export interface ItemRevaluacion {
  clave: string;
  cuentaId: string;
  codigo: string;
  nombre: string;
  naturaleza: 'activo' | 'pasivo';
  concepto: string;
  divisaUsd: string;
  librosVes: string;
  revaluadoVes: string;
  /** Efecto en resultados: positivo = ganancia, negativo = pérdida. */
  efectoVes: string;
}

export interface CalculoRevaluacion {
  anio: number; mes: number; fin: string; tasa: string;
  items: ItemRevaluacion[];
  gananciaVes: string; perdidaVes: string;
}

/** Efecto de revaluar: un activo gana si vale más; un pasivo gana si vale menos. */
export function efectoDe(naturaleza: 'activo' | 'pasivo', divisaUsd: Decimal, librosVes: Decimal, tasa: Decimal): { revaluado: Decimal; efecto: Decimal } {
  const revaluado = dos(divisaUsd.times(tasa));
  return { revaluado, efecto: naturaleza === 'activo' ? revaluado.minus(librosVes) : librosVes.minus(revaluado) };
}

async function cuentaConfigurada(db: Db, clave: string): Promise<{ id: string; codigo: string; nombre: string }> {
  const { rows } = await db.query<{ id: string; codigo: string; nombre: string }>(
    'select c.id, c.codigo, c.nombre from configuracion_contable k join cuenta_contable c on c.id = k.cuenta_id where k.clave = $1', [clave]);
  if (!rows[0]) throw new ErrorMaestro(`Falta configurar la cuenta «${clave}» de la revaluación.`);
  return rows[0];
}

/** Calcula la revaluación del mes con los saldos de hoy (partidas) y del mayor al último día (bancos). No guarda nada. */
export async function calcularRevaluacion(db: Db, anio: number, mes: number): Promise<CalculoRevaluacion> {
  const { hasta: fin } = rangoDeMes(anio, mes);
  const tasa = (await tasasDelDia(db, 'USD', fin)).usd;
  const items: ItemRevaluacion[] = [];
  const agrega = (i: { clave: string; cuenta: { id: string; codigo: string; nombre: string }; naturaleza: 'activo' | 'pasivo'; concepto: string; divisa: Decimal; libros: Decimal }) => {
    if (i.divisa.isZero() && i.libros.isZero()) return;
    const { revaluado, efecto } = efectoDe(i.naturaleza, i.divisa, i.libros, tasa);
    if (efecto.isZero()) return;
    items.push({
      clave: i.clave, cuentaId: i.cuenta.id, codigo: i.cuenta.codigo, nombre: i.cuenta.nombre, naturaleza: i.naturaleza, concepto: i.concepto,
      divisaUsd: i.divisa.toFixed(2), librosVes: i.libros.toFixed(2), revaluadoVes: revaluado.toFixed(2), efectoVes: efecto.toFixed(2),
    });
  };

  const { rows: bancos } = await db.query<{ id: string; codigo: string; nombre: string; cuenta_id: string; cuenta: string; cuenta_nombre: string; usd: string; ves: string }>(
    `select cb.id, cb.codigo, cb.nombre, cc.id as cuenta_id, cc.codigo as cuenta, cc.nombre as cuenta_nombre,
            coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd, coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves
       from cuenta_bancaria cb join cuenta_contable cc on cc.id = cb.cuenta_contable_id
       left join (asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' and a.fecha <= $1::date and ${NO_AJUSTE}) on l.cuenta_id = cc.id
      where cb.moneda = 'USD' group by cb.id, cb.codigo, cb.nombre, cc.id, cc.codigo, cc.nombre order by cb.codigo`, [fin]);
  for (const b of bancos) {
    agrega({ clave: `banco:${b.id}`, cuenta: { id: b.cuenta_id, codigo: b.cuenta, nombre: b.cuenta_nombre }, naturaleza: 'activo', concepto: `${b.codigo} · ${b.nombre}`, divisa: new Decimal(b.usd), libros: new Decimal(b.ves) });
  }

  const una = async (sql: string) => (await db.query<{ usd: string; ves: string }>(sql)).rows[0];
  const cxp = await una(`select coalesce(sum(saldo), 0)::text as usd, coalesce(sum(round(saldo * tasa, 2)), 0)::text as ves from partida_cxp where estado = 'abierta' and moneda = 'USD'`);
  agrega({ clave: 'cxp', cuenta: await cuentaConfigurada(db, 'revaluacion_cxp'), naturaleza: 'pasivo', concepto: 'Facturas de proveedores abiertas en dólares', divisa: new Decimal(cxp.usd), libros: new Decimal(cxp.ves) });
  const ac = await una(`select coalesce(sum(por_aplicar), 0)::text as usd, coalesce(sum(por_aplicar_ves), 0)::text as ves from cobro where estado <> 'anulado' and moneda = 'USD' and por_aplicar > 0`);
  agrega({ clave: 'anticipos_clientes', cuenta: await cuentaConfigurada(db, 'revaluacion_anticipos_clientes'), naturaleza: 'pasivo', concepto: 'Anticipos de clientes en dólares', divisa: new Decimal(ac.usd), libros: new Decimal(ac.ves) });
  const ap = await una(`select coalesce(sum(por_aplicar), 0)::text as usd, coalesce(sum(por_aplicar_ves), 0)::text as ves from pago where estado = 'pagado' and moneda = 'USD' and por_aplicar > 0`);
  agrega({ clave: 'anticipos_proveedores', cuenta: await cuentaConfigurada(db, 'revaluacion_anticipos_proveedores'), naturaleza: 'activo', concepto: 'Anticipos a proveedores en dólares', divisa: new Decimal(ap.usd), libros: new Decimal(ap.ves) });

  const efectos = items.map((i) => new Decimal(i.efectoVes));
  return {
    anio, mes, fin, tasa: tasa.toFixed(6), items,
    gananciaVes: efectos.filter((e) => e.gt(0)).reduce((s, e) => s.plus(e), new Decimal(0)).toFixed(2),
    perdidaVes: efectos.filter((e) => e.lt(0)).reduce((s, e) => s.plus(e.abs()), new Decimal(0)).toFixed(2),
  };
}

/** Lo que identifica un cálculo para saber si lo aprobado sigue siendo lo que toca: la tasa y el efecto de cada partida. */
const huella = (c: Pick<CalculoRevaluacion, 'tasa' | 'items'>) => JSON.stringify({ tasa: c.tasa, items: c.items.map((i) => [i.clave, i.efectoVes]) });

export interface RegistroRevaluacion {
  id: string; estado: 'pendiente' | 'aprobada' | 'rechazada'; creador: string; aprobador: string | null; rechazo_motivo: string | null;
  asiento: string | null; asiento_reverso: string | null; created_by: string; cifras: CalculoRevaluacion;
}

export async function registroVigente(db: Db, anio: number, mes: number): Promise<RegistroRevaluacion | null> {
  const { rows } = await db.query<RegistroRevaluacion>(
    `select r.id, r.estado, u.nombre as creador, a.nombre as aprobador, r.rechazo_motivo, x.numero::text as asiento, y.numero::text as asiento_reverso, r.created_by, r.cifras
       from revaluacion_cambiaria r join periodo_contable p on p.id = r.periodo_id join usuario u on u.id = r.created_by left join usuario a on a.id = r.aprobado_por
       left join asiento x on x.id = r.asiento_id left join asiento y on y.id = r.asiento_reverso_id
      where p.anio = $1 and p.mes = $2 and r.estado <> 'rechazada'`, [anio, mes]);
  return rows[0] ?? null;
}

export interface EstadoRevaluacion { ok: boolean; detalle: string; calculo: CalculoRevaluacion; registro: RegistroRevaluacion | null }

/** ¿Está resuelto el diferencial cambiario del mes? Sin diferencia por registrar sí; con diferencia, solo con la revaluación aprobada y vigente. */
export async function estadoRevaluacion(db: Db, anio: number, mes: number): Promise<EstadoRevaluacion> {
  let calculo: CalculoRevaluacion;
  try {
    calculo = await calcularRevaluacion(db, anio, mes);
  } catch (e) {
    // Sin la tasa BCV del último día no se puede valorar: el cierre queda pendiente en lugar de fallar.
    if (!/tasa/i.test((e as Error).message)) throw e;
    return { ok: false, detalle: `${(e as Error).message}. Cargue la tasa BCV del último día del mes.`, calculo: { anio, mes, fin: rangoDeMes(anio, mes).hasta, tasa: '0', items: [], gananciaVes: '0.00', perdidaVes: '0.00' }, registro: null };
  }
  const registro = await registroVigente(db, anio, mes);
  if (registro?.estado === 'aprobada') {
    return huella(registro.cifras) === huella(calculo)
      ? { ok: true, detalle: `Revaluada a la tasa ${calculo.tasa}: ganancia Bs. ${registro.cifras.gananciaVes}, pérdida Bs. ${registro.cifras.perdidaVes}. Asiento ${registro.asiento}, reverso ${registro.asiento_reverso}.`, calculo, registro }
      : { ok: false, detalle: 'Las cifras cambiaron después de aprobar la revaluación (hubo movimientos en divisas): proponga una nueva.', calculo, registro };
  }
  if (calculo.items.length === 0) return { ok: true, detalle: 'No hay partidas en divisas con diferencia por registrar.', calculo, registro: null };
  if (registro?.estado === 'pendiente') return { ok: false, detalle: 'La revaluación está pendiente del Jefe de contabilidad.', calculo, registro };
  return { ok: false, detalle: `Hay diferencia por registrar (ganancia Bs. ${calculo.gananciaVes}, pérdida Bs. ${calculo.perdidaVes}): proponga la revaluación del mes.`, calculo, registro };
}

export async function proponerRevaluacion(tx: Db, u: UsuarioReval, anio: number, mes: number): Promise<string> {
  if (!u.roles.some((r) => (ROLES_PROPONEN_REVALUACION as readonly string[]).includes(r))) throw new ErrorMaestro('Solo Contabilidad o Gerencia proponen la revaluación.');
  const { rows: p } = await tx.query<{ id: string; estado: string }>('select id, estado from periodo_contable where anio = $1 and mes = $2', [anio, mes]);
  if (!p[0]) throw new ErrorMaestro('No existe el periodo de ese mes: créelo en Periodos contables.');
  if (p[0].estado !== 'abierto') throw new ErrorMaestro('Solo se propone la revaluación de un mes abierto.');
  if (await registroVigente(tx, anio, mes)) throw new ErrorMaestro('Ese mes ya tiene una revaluación propuesta o aprobada.');
  const c = await calcularRevaluacion(tx, anio, mes);
  if (c.items.length === 0) throw new ErrorMaestro('No hay diferencia cambiaria por registrar en ese mes.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into revaluacion_cambiaria (periodo_id, tasa, cifras, ganancia_ves, perdida_ves, created_by) values ($1, $2, $3::jsonb, $4, $5, $6) returning id`,
    [p[0].id, c.tasa, JSON.stringify(c), c.gananciaVes, c.perdidaVes, u.id]);
  await solicitarAprobacion(tx, { tipo: 'revaluacion_cambiaria', objetoId: rows[0].id, solicitanteId: u.id });
  return rows[0].id;
}

/** Lo llama el motor de aprobaciones: recalcula, verifica que nada cambió, contabiliza el ajuste y su reverso del primer día del mes siguiente. */
export async function aprobarRevaluacion(tx: Db, id: string, aprobador: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string; anio: number; mes: number; cifras: CalculoRevaluacion; created_by: string }>(
    `select r.estado, p.anio, p.mes, r.cifras, r.created_by from revaluacion_cambiaria r join periodo_contable p on p.id = r.periodo_id where r.id = $1 for update of r`, [id]);
  const r = rows[0];
  if (!r) throw new ErrorMaestro('La revaluación no existe.');
  if (r.estado !== 'pendiente') throw new ErrorMaestro('La revaluación no está pendiente de aprobación.');
  const actual = await calcularRevaluacion(tx, r.anio, r.mes);
  if (huella(actual) !== huella(r.cifras)) throw new ErrorMaestro('Las cifras cambiaron desde que se propuso (hubo movimientos en divisas): rechace esta propuesta y proponga una nueva.');

  const { rows: cfg } = await tx.query<{ clave: string; id: string }>(`select clave, cuenta_id as id from configuracion_contable where clave in ('diferencial_ganancia', 'diferencial_perdida')`);
  const ganancia = cfg.find((c) => c.clave === 'diferencial_ganancia')?.id;
  const perdida = cfg.find((c) => c.clave === 'diferencial_perdida')?.id;
  if (!ganancia || !perdida) throw new ErrorMaestro('Falta configurar las cuentas de diferencial cambiario.');

  const lineas: LineaOriginal[] = [];
  const linea = (cuentaId: string, lado: 'D' | 'H', ves: Decimal, glosa: string) => lineas.push({ cuentaId, lado, original: ves, glosa, explicito: { ves, usd: new Decimal(0) } });
  for (const i of actual.items) {
    const e = new Decimal(i.efectoVes);
    linea(i.cuentaId, e.gt(0) ? 'D' : 'H', e.abs(), `Revaluación · ${i.concepto}`);
  }
  if (new Decimal(actual.gananciaVes).gt(0)) linea(ganancia, 'H', new Decimal(actual.gananciaVes), 'Ganancia por diferencial cambiario (revaluación)');
  if (new Decimal(actual.perdidaVes).gt(0)) linea(perdida, 'D', new Decimal(actual.perdidaVes), 'Pérdida por diferencial cambiario (revaluación)');

  const etiqueta = `${String(r.mes).padStart(2, '0')}-${r.anio}`;
  const { rows: a } = await tx.query<{ id: string }>(
    `insert into asiento (fecha, tipo, descripcion, origen_tipo, origen_id, created_by) values ($1::date, 'ajuste_cambiario', $2, 'revaluacion_cambiaria', $3, $4) returning id`,
    [actual.fin, `Revaluación cambiaria al cierre de ${etiqueta} (tasa ${actual.tasa})`, id, r.created_by]);
  await insertarLineasConvertidas(tx, a[0].id, 'VES', await tasasDelDia(tx, 'VES', actual.fin), lineas);
  await tx.query(`update asiento set estado = 'contabilizado', contabilizado_por = $2 where id = $1`, [a[0].id, aprobador]);

  const siguiente = new Date(`${actual.fin}T00:00:00Z`);
  siguiente.setUTCDate(siguiente.getUTCDate() + 1);
  const { rows: rv } = await tx.query<{ id: string }>(
    'select fn_reversar_asiento($1, $2::date, $3) as id', [a[0].id, siguiente.toISOString().slice(0, 10), `la revaluación solo vale para el balance de ${etiqueta}`]);
  await tx.query(`update revaluacion_cambiaria set estado = 'aprobada', aprobado_por = $2, asiento_id = $3, asiento_reverso_id = $4 where id = $1`, [id, aprobador, a[0].id, rv[0].id]);
}

export async function rechazarRevaluacion(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from revaluacion_cambiaria where id = $1 for update', [id]);
  if (rows[0]?.estado !== 'pendiente') throw new ErrorMaestro('La revaluación no está pendiente de aprobación.');
  await tx.query(`update revaluacion_cambiaria set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}
