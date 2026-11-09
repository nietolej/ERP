import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { declaraPorQuincena } from '@/lib/fiscal/declaraciones';
import { ErrorMaestro } from '@/lib/errores';
import { saldoAuxiliarComisiones } from '@/lib/comisiones/comisiones';
import { activosSinDepreciar, saldoAuxiliarActivos } from './activos';
import { construirSituacion, rangoDeMes, saldosAl } from './estados';
import { estadoRevaluacion } from './revaluacion';
import { dos } from '@/lib/dinero';

/**
 * Cierre mensual (spec §12.4; migración 0051). El checklist junta lo que el sistema puede comprobar solo (documentos pendientes, conciliaciones,
 * auxiliares contra el mayor, declaraciones, cuadre del balance) con dos puntos que confirma una persona por periodo (asientos recurrentes y
 * provisiones, y revisión del diferencial cambiario). Con todo en orden, Contabilidad cierra el periodo con `fn_cerrar_periodo`, que guarda la foto
 * del checklist; la base se niega a cerrar con asientos en borrador o con el mayor descuadrado. Reabrir lo hace solo Gerencia, con motivo.
 */

export const ROLES_CIERRAN_PERIODO = ['contabilidad', 'jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_REABREN_PERIODO = ['gerencia'] as const satisfies readonly Rol[];
export const ROLES_RETIRAN_CIERRE = ['jefe_contabilidad', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_CIERRE = ['contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor'] as const satisfies readonly Rol[];

export type CodigoCierre = 'recurrentes';
export type UsuarioCierre = { id: string; roles: readonly string[] };

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const etiquetaMes = (anio: number, mes: number) => `${NOMBRE_MES[mes - 1]} ${anio}`;

export interface ConfirmacionCierre { id: string; codigo: CodigoCierre; por: string; el: string; nota: string | null }

export interface PuntoCierre {
  codigo: string;
  titulo: string;
  ok: boolean;
  detalle: string;
  /** Una línea por cosa que falta (documentos, cuentas, declaraciones…). */
  pendientes: string[];
  /** Lo que una persona confirma por periodo. */
  confirmacion?: { codigo: CodigoCierre; hecha: ConfirmacionCierre | null };
  enlace?: { texto: string; href: string };
}

export interface ChecklistCierre {
  periodo: { id: string; anio: number; mes: number; estado: 'abierto' | 'cerrado' | 'bloqueado' };
  puntos: PuntoCierre[];
  listo: boolean;
}

export async function periodoDeMes(db: Db, anio: number, mes: number): Promise<ChecklistCierre['periodo']> {
  rangoDeMes(anio, mes);
  const { rows } = await db.query<ChecklistCierre['periodo']>('select id, anio, mes, estado from periodo_contable where anio = $1 and mes = $2', [anio, mes]);
  if (!rows[0]) throw new ErrorMaestro(`No existe el periodo de ${etiquetaMes(anio, mes)}: créelo en Contabilidad → Periodos contables.`);
  return rows[0];
}

// ---------------------------------------------------------------------
// Comprobaciones
// ---------------------------------------------------------------------

/** Documentos que todavía no están emitidos o resueltos y que ya existían al terminar el mes: cada uno puede cambiar el mayor. */
const PENDIENTES: { titulo: string; sql: string; porPeriodo?: boolean }[] = [
  { titulo: 'asientos en borrador', sql: `select count(*)::int as n from asiento where estado = 'borrador' and periodo_id = $1::uuid`, porPeriodo: true },
  { titulo: 'notas de entrega, facturas y notas de crédito o débito en borrador', sql: `select count(*)::int as n from documento_venta where tipo <> 'pedido' and estado = 'borrador' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'ajustes de inventario sin resolver', sql: `select count(*)::int as n from ajuste_inventario where estado in ('borrador', 'pendiente') and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'recepciones de mercancía en borrador', sql: `select count(*)::int as n from documento_compra where tipo = 'recepcion' and estado = 'borrador' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'facturas de compra en borrador o retenidas', sql: `select count(*)::int as n from factura_compra where estado in ('borrador', 'retenida') and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'gastos de importación en borrador', sql: `select count(*)::int as n from gasto_importacion where estado = 'borrador' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'facturas de gasto pendientes de aprobación', sql: `select count(*)::int as n from gasto_proveedor where estado = 'pendiente' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'notas del proveedor pendientes de aprobación', sql: `select count(*)::int as n from nota_proveedor where estado = 'pendiente' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'pagos a proveedores solicitados sin aprobar', sql: `select count(*)::int as n from pago where estado = 'solicitado' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
  { titulo: 'reposiciones de caja chica pendientes', sql: `select count(*)::int as n from reposicion_caja where estado = 'pendiente' and (created_at at time zone 'America/Caracas')::date <= $1::date` },
];

async function documentosPendientes(db: Db, hasta: string, periodoId: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of PENDIENTES) {
    const n = (await db.query<{ n: number }>(p.sql, [p.porPeriodo ? periodoId : hasta])).rows[0].n;
    if (n > 0) out.push(`${n} ${p.titulo}`);
  }
  return out;
}

async function periodosAnterioresAbiertos(db: Db, anio: number, mes: number): Promise<string[]> {
  const { rows } = await db.query<{ anio: number; mes: number }>(
    `select p.anio, p.mes from periodo_contable p
      where p.mes <= 12 and (p.anio, p.mes) < ($1::int, $2::int) and p.estado = 'abierto'
        and exists (select 1 from asiento a where a.periodo_id = p.id and a.estado = 'contabilizado')
      order by p.anio, p.mes`, [anio, mes]);
  return rows.map((r) => etiquetaMes(r.anio, r.mes));
}

async function conciliacionesAbiertas(db: Db, anio: number, mes: number, desde: string, hasta: string): Promise<string[]> {
  const { rows } = await db.query<{ texto: string }>(
    `select cb.codigo || ' · ' || cb.nombre as texto from cuenta_bancaria cb
      where cb.activa and cb.tipo <> 'caja' and cb.moneda in ('VES', 'USD')
        and (exists (select 1 from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                      where l.cuenta_id = cb.cuenta_contable_id and a.fecha between $1::date and $2::date)
             or exists (select 1 from extracto_bancario e where e.cuenta_bancaria_id = cb.id and e.anio = $3 and e.mes = $4))
        and not exists (select 1 from extracto_bancario e where e.cuenta_bancaria_id = cb.id and e.anio = $3 and e.mes = $4 and e.estado = 'cerrado')
      order by cb.codigo`, [desde, hasta, anio, mes]);
  return rows.map((r) => r.texto);
}

export interface Cuadre { nombre: string; moneda: 'VES' | 'USD'; mayor: string; auxiliar: string; ok: boolean }

/**
 * Cada auxiliar contra su cuenta del mayor, con lo contabilizado hasta hoy. CxC en bolívares y dólares; CxP, inventario y mercancía recibida no
 * facturada en dólares (su moneda de valoración). Comisiones por pagar en bolívares (valor en libros) y en dólares.
 */
export async function cuadreAuxiliares(db: Db): Promise<Cuadre[]> {
  const mayor = async (codigo: string, col: 'ves' | 'usd', signo: 1 | -1): Promise<Decimal> => {
    const { rows } = await db.query<{ v: string }>(
      `select coalesce(sum(l.debe_${col} - l.haber_${col}), 0)::text as v from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
         join cuenta_contable c on c.id = l.cuenta_id where c.codigo = $1`, [codigo]);
    return dos(new Decimal(rows[0].v).times(signo));
  };
  const un = async (sql: string): Promise<Decimal> => dos((await db.query<{ v: string }>(sql)).rows[0].v);
  const cuadre = (nombre: string, moneda: 'VES' | 'USD', m: Decimal, a: Decimal): Cuadre => ({ nombre, moneda, mayor: m.toFixed(2), auxiliar: a.toFixed(2), ok: m.equals(a) });

  // El auxiliar es la columna saldo_usd que mantiene la base (R-BR): recalcular monto_usd × saldo / monto_original difiere un centavo
  // del mayor cuando un pago parcial deja una mitad en medio centavo.
  const cxc = await db.query<{ ves: string; usd: string }>(
    `select coalesce(sum(saldo), 0)::text as ves, coalesce(sum(saldo_usd), 0)::text as usd from partida_cxc where estado = 'abierta'`);
  const cxp = await un(`select coalesce(sum(saldo_usd), 0)::text as v from partida_cxp where estado = 'abierta'`);
  const inv = await un(`select coalesce(sum(valor_usd), 0)::text as v from producto_costo`);
  const puente = await mayor('2.1.02', 'usd', -1);
  const com = await saldoAuxiliarComisiones(db);
  const af = await saldoAuxiliarActivos(db);
  return [
    cuadre('Cuentas por cobrar (1.2.01)', 'VES', await mayor('1.2.01', 'ves', 1), dos(cxc.rows[0].ves)),
    cuadre('Cuentas por cobrar (1.2.01)', 'USD', await mayor('1.2.01', 'usd', 1), dos(cxc.rows[0].usd)),
    cuadre('Cuentas por pagar (2.1.01)', 'USD', await mayor('2.1.01', 'usd', -1), cxp),
    cuadre('Inventario de mercancía (1.3.01)', 'USD', await mayor('1.3.01', 'usd', 1), inv),
    cuadre('Activos fijos: costo', 'VES', dos(af.mayorCostoVes), dos(af.costoVes)),
    cuadre('Activos fijos: costo', 'USD', dos(af.mayorCostoUsd), dos(af.costoUsd)),
    cuadre('Activos fijos: depreciación acumulada', 'VES', dos(af.mayorDepVes), dos(af.depVes)),
    cuadre('Activos fijos: depreciación acumulada', 'USD', dos(af.mayorDepUsd), dos(af.depUsd)),
    cuadre('Comisiones por pagar (2.1.07)', 'VES', await mayor('2.1.07', 'ves', -1), dos(com.ves)),
    cuadre('Comisiones por pagar (2.1.07)', 'USD', await mayor('2.1.07', 'usd', -1), dos(com.usd)),
    // La cuenta puente de la conciliación a tres vías no tiene auxiliar propio: no puede quedar con saldo deudor (se facturó más de lo recibido).
    { nombre: 'Mercancía recibida no facturada (2.1.02): saldo no deudor', moneda: 'USD', mayor: puente.toFixed(2), auxiliar: '≥ 0.00', ok: puente.greaterThanOrEqualTo(0) },
  ];
}

async function declaracionesFaltantes(db: Db, anio: number, mes: number, desde: string, hasta: string): Promise<string[]> {
  const faltan: string[] = [];
  const vigentes = async (tipo: string) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from declaracion_fiscal where tipo = $1 and anio = $2 and mes = $3 and reabierta_at is null`, [tipo, anio, mes])).rows[0].n;
  if ((await vigentes('iva')) < 1) faltan.push('Declaración de IVA');
  const porQuincena = await declaraPorQuincena(db);
  for (const [tipo, impuesto, nombre] of [['retenciones_iva', 'iva', 'Retenciones de IVA'], ['retenciones_islr', 'islr', 'Retenciones de ISLR']] as const) {
    const hay = (await db.query<{ n: number }>(
      `select count(*)::int as n from retencion_compra where impuesto = $1 and fecha between $2::date and $3::date`, [impuesto, desde, hasta])).rows[0].n;
    if (hay === 0) continue;                              // sin retenciones en el mes no hay nada que declarar
    const necesarias = tipo === 'retenciones_iva' && porQuincena ? 2 : 1;
    if ((await vigentes(tipo)) < necesarias) faltan.push(`${nombre}${necesarias === 2 ? ' (las dos quincenas)' : ''}`);
  }
  return faltan;
}

async function confirmaciones(db: Db, periodoId: string): Promise<Map<CodigoCierre, ConfirmacionCierre>> {
  const { rows } = await db.query<{ id: string; codigo: CodigoCierre; por: string; el: string; nota: string | null }>(
    `select c.id, c.codigo, u.nombre as por, to_char(c.confirmado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as el, c.nota
       from cierre_confirmacion c join usuario u on u.id = c.confirmado_por where c.periodo_id = $1 and c.retirada_at is null`, [periodoId]);
  return new Map(rows.map((r) => [r.codigo, r]));
}

/** Calcula el checklist del mes con el estado de hoy. */
export async function checklistCierre(db: Db, anio: number, mes: number): Promise<ChecklistCierre> {
  const periodo = await periodoDeMes(db, anio, mes);
  const { desde, hasta } = rangoDeMes(anio, mes);
  const conf = await confirmaciones(db, periodo.id);
  const puntos: PuntoCierre[] = [];
  const agrega = (p: Omit<PuntoCierre, 'pendientes'> & { pendientes?: string[] }) => puntos.push({ ...p, pendientes: p.pendientes ?? [] });

  const anteriores = await periodosAnterioresAbiertos(db, anio, mes);
  agrega({
    codigo: 'anteriores', titulo: 'Los meses anteriores con movimiento están cerrados', ok: anteriores.length === 0,
    detalle: anteriores.length === 0 ? 'No queda un mes anterior abierto con asientos.' : 'Cierre primero los meses anteriores, en orden.', pendientes: anteriores,
  });

  const docs = await documentosPendientes(db, hasta, periodo.id);
  agrega({
    codigo: 'documentos', titulo: 'Todos los documentos del mes están emitidos, resueltos o anulados', ok: docs.length === 0,
    detalle: docs.length === 0 ? 'No quedan borradores ni documentos por aprobar.' : 'Emita, apruebe, rechace o anule estos documentos.', pendientes: docs,
  });

  const conc = await conciliacionesAbiertas(db, anio, mes, desde, hasta);
  agrega({
    codigo: 'conciliaciones', titulo: 'Conciliaciones bancarias del mes cerradas', ok: conc.length === 0,
    detalle: conc.length === 0 ? 'Toda cuenta con movimiento tiene su conciliación cerrada.' : 'Falta cerrar la conciliación de estas cuentas.', pendientes: conc,
    enlace: { texto: 'Conciliación bancaria', href: '/tesoreria/conciliacion' },
  });

  const cuadres = await cuadreAuxiliares(db);
  const malos = cuadres.filter((c) => !c.ok);
  agrega({
    codigo: 'auxiliares', titulo: 'Auxiliares contra mayor: CxC, CxP, inventario, comisiones y mercancía recibida no facturada', ok: malos.length === 0,
    detalle: malos.length === 0 ? 'Todos los auxiliares cuadran con su cuenta del mayor (incluye comisiones por pagar).' : 'Un auxiliar no cuadra con su cuenta del mayor.',
    pendientes: malos.map((c) => `${c.nombre} en ${c.moneda}: mayor ${c.mayor}, auxiliar ${c.auxiliar}`),
  });

  const faltan = await declaracionesFaltantes(db, anio, mes, desde, hasta);
  agrega({
    codigo: 'fiscal', titulo: 'Libros de IVA, retenciones y declaraciones del mes presentados', ok: faltan.length === 0,
    detalle: faltan.length === 0 ? 'IVA y retenciones del mes declarados.' : 'Falta declarar.', pendientes: faltan,
    enlace: { texto: 'Declaraciones', href: '/fiscal/declaraciones' },
  });

  const sinDepreciar = await activosSinDepreciar(db, anio, mes);
  agrega({
    codigo: 'recurrentes', titulo: 'Depreciación del mes contabilizada y demás asientos recurrentes y provisiones (nómina)', ok: conf.has('recurrentes') && sinDepreciar.length === 0,
    detalle: sinDepreciar.length ? 'Falta depreciar el mes (Contabilidad → Activos fijos).' : conf.has('recurrentes') ? 'Depreciación hecha y resto confirmado por Contabilidad.' : 'Depreciación al día. Contabilidad confirma que registró los demás asientos recurrentes y provisiones del mes.',
    pendientes: sinDepreciar.map((x) => `Sin depreciar: ${x}`),
    confirmacion: { codigo: 'recurrentes', hecha: conf.get('recurrentes') ?? null },
    enlace: { texto: 'Asientos contables', href: '/contabilidad/asientos' },
  });

  const rev = await estadoRevaluacion(db, anio, mes);
  agrega({
    codigo: 'diferencial_cambiario', titulo: 'Partidas en divisas revaluadas al cierre del mes (diferencial cambiario)', ok: rev.ok, detalle: rev.detalle,
    enlace: { texto: 'Revaluación cambiaria', href: `/contabilidad/revaluacion?periodo=${anio}-${String(mes).padStart(2, '0')}` },
  });

  const control = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
  const situacion = construirSituacion(await saldosAl(db, hasta));
  const cuadra = dos(control.ves).isZero() && dos(control.usd).isZero() && situacion.cuadra;
  agrega({
    codigo: 'balance', titulo: 'El mayor cuadra y el balance del mes cuadra', ok: cuadra,
    detalle: cuadra ? 'Debe y haber iguales en el mayor; activo igual a pasivo y patrimonio.' : `Diferencia del mayor: Bs. ${dos(control.ves).toFixed(2)} / US$ ${dos(control.usd).toFixed(2)}; del balance: Bs. ${situacion.diferencia.ves.toFixed(2)}.`,
    enlace: { texto: 'Balance de comprobación', href: '/contabilidad/balance' },
  });

  return { periodo, puntos, listo: puntos.every((p) => p.ok) };
}

// ---------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------

const tiene = (u: UsuarioCierre, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));

export async function confirmarCierre(tx: Db, u: UsuarioCierre, anio: number, mes: number, codigo: CodigoCierre, nota?: string): Promise<void> {
  if (!tiene(u, ROLES_CIERRAN_PERIODO)) throw new ErrorMaestro('Solo Contabilidad o Gerencia confirman puntos del cierre.');
  if (codigo !== 'recurrentes') throw new ErrorMaestro('Confirmación desconocida.');
  const p = await periodoDeMes(tx, anio, mes);
  if (p.estado !== 'abierto') throw new ErrorMaestro('El periodo ya no está abierto.');
  const { rows } = await tx.query('select 1 from cierre_confirmacion where periodo_id = $1 and codigo = $2 and retirada_at is null', [p.id, codigo]);
  if (rows.length) throw new ErrorMaestro('Esa confirmación ya está hecha.');
  await tx.query(`insert into cierre_confirmacion (periodo_id, codigo, nota, confirmado_por) values ($1, $2, nullif(trim($3), ''), $4)`, [p.id, codigo, nota ?? '', u.id]);
}

export async function retirarConfirmacionCierre(tx: Db, u: UsuarioCierre, id: string, motivo: string): Promise<void> {
  if (!tiene(u, ROLES_RETIRAN_CIERRE)) throw new ErrorMaestro('Solo el Jefe de contabilidad o Gerencia retiran una confirmación del cierre.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo.');
  const { rows } = await tx.query('update cierre_confirmacion set retirada_motivo = $2, retirada_por = $3 where id = $1 and retirada_at is null returning id', [id, motivo.trim(), u.id]);
  if (!rows[0]) throw new ErrorMaestro('La confirmación no existe o ya fue retirada.');
}

/** Cierra el mes: el checklist completo y en orden, y luego la función de la base, que guarda la foto del checklist y cambia el estado. */
export async function cerrarMes(tx: Db, u: UsuarioCierre, anio: number, mes: number): Promise<void> {
  if (!tiene(u, ROLES_CIERRAN_PERIODO)) throw new ErrorMaestro('Solo Contabilidad o Gerencia cierran un periodo.');
  const c = await checklistCierre(tx, anio, mes);
  if (c.periodo.estado !== 'abierto') throw new ErrorMaestro(`El periodo de ${etiquetaMes(anio, mes)} ya está ${c.periodo.estado}.`);
  const faltan = c.puntos.filter((p) => !p.ok);
  if (faltan.length) throw new ErrorMaestro(`Antes de cerrar ${etiquetaMes(anio, mes)} falta: ${faltan.map((p) => p.titulo).join('; ')}.`);
  const foto = c.puntos.map((p) => ({ codigo: p.codigo, titulo: p.titulo, ok: p.ok, detalle: p.detalle }));
  await tx.query('select fn_cerrar_periodo($1, $2::jsonb, $3)', [c.periodo.id, JSON.stringify(foto), u.id]);
}

/** Gerencia reabre un mes cerrado, con motivo; queda en el historial. */
export async function reabrirMes(tx: Db, u: UsuarioCierre, anio: number, mes: number, motivo: string): Promise<void> {
  if (!tiene(u, ROLES_REABREN_PERIODO)) throw new ErrorMaestro('Solo Gerencia reabre un periodo cerrado.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la reapertura.');
  const p = await periodoDeMes(tx, anio, mes);
  const { rows } = await tx.query<{ n: number }>(
    `select count(*)::int as n from periodo_contable where mes <= 12 and (anio, mes) > ($1::int, $2::int) and estado <> 'abierto' and exists (select 1 from asiento a where a.periodo_id = periodo_contable.id and a.estado = 'contabilizado')`, [anio, mes]);
  if (rows[0].n > 0) throw new ErrorMaestro('Hay meses posteriores cerrados: reábralos primero, del más reciente al más antiguo.');
  await tx.query('select fn_reabrir_periodo($1, $2, $3)', [p.id, motivo.trim(), u.id]);
}

export interface FilaHistorialCierre { id: string; accion: 'cierre' | 'reapertura'; motivo: string | null; por: string; el: string }

export async function historialCierre(db: Db, anio: number, mes: number): Promise<FilaHistorialCierre[]> {
  const { rows } = await db.query<FilaHistorialCierre>(
    `select h.id, h.accion, h.motivo, u.nombre as por, to_char(h.hecho_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as el
       from cierre_periodo h join periodo_contable p on p.id = h.periodo_id join usuario u on u.id = h.hecho_por
      where p.anio = $1 and p.mes = $2 order by h.hecho_at desc`, [anio, mes]);
  return rows;
}
