/**
 * Cierre mensual de la empresa ficticia (spec §12.4). El primer día del mes siguiente, antes de operar, cada mes terminado
 * recorre su checklist como lo haría Contabilidad: revaluación cambiaria (propone Contabilidad, aprueba el Jefe de
 * contabilidad), conciliación bancaria de cada cuenta (Tesorería empareja, Contabilidad cierra), declaración de IVA,
 * confirmación de los asientos recurrentes y, con todo en orden, cierre del periodo.
 */
import { cerrarMes, checklistCierre, confirmarCierre } from '../../src/lib/contabilidad/cierre';
import { depreciarMes } from '../../src/lib/contabilidad/activos';
import { estadoRevaluacion, proponerRevaluacion } from '../../src/lib/contabilidad/revaluacion';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { emitirPeriodo, pendientes } from '../../src/lib/fiscal/comprobantes';
import { declarar } from '../../src/lib/fiscal/declaraciones';
import { agregarLinea, cerrarExtracto, conciliar, crearExtracto } from '../../src/lib/tesoreria/conciliacion';
import { como, contar, sumarDias, type Ctx } from './base.mts';
import { liquidarComisionesDelMes } from './comisiones.mts';

const dos = (n: number) => n.toFixed(2);
const finDeMes = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);

/** Meses (AAAA, M) desde el de `desde` hasta el de `hasta`, ambos incluidos. */
export function mesesEntre(desde: string, hasta: string): { anio: number; mes: number }[] {
  const r: { anio: number; mes: number }[] = [];
  let a = Number(desde.slice(0, 4));
  let m = Number(desde.slice(5, 7));
  const fa = Number(hasta.slice(0, 4));
  const fm = Number(hasta.slice(5, 7));
  while (a < fa || (a === fa && m <= fm)) {
    r.push({ anio: a, mes: m });
    if (++m > 12) { m = 1; a++; }
  }
  return r;
}

/**
 * Conciliación de una cuenta bancaria: el extracto del banco trae todo lo que el mayor registró hasta el fin del mes y todavía
 * no estaba emparejado, salvo (a propósito) algunos movimientos de los últimos días, que quedan «en tránsito» para el mes siguiente.
 */
async function conciliarCuenta(ctx: Ctx, cuenta: { id: string; moneda: string; cuentaContableId: string }, anio: number, mes: number): Promise<void> {
  const { db, u } = ctx;
  const fin = finDeMes(anio, mes);
  const inicio = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const col = cuenta.moneda === 'USD' ? '(l.debe_usd - l.haber_usd)' : '(l.debe_ves - l.haber_ves)';
  const { rows } = await db.query<{ linea: string; fecha: string; descripcion: string; referencia: string | null; neto: string }>(
    `select l.id::text as linea, a.fecha::text, coalesce(l.glosa, a.descripcion) as descripcion, coalesce(c.referencia, p.referencia) as referencia, ${col}::text as neto
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
       left join cobro c on a.origen_tipo = 'cobro' and c.id = a.origen_id
       left join pago p on a.origen_tipo = 'pago_proveedor' and p.id = a.origen_id
      where l.cuenta_id = $1 and a.fecha <= $2::date and not exists (select 1 from extracto_linea x where x.asiento_linea_id = l.id)
        and ${col} <> 0
      order by a.fecha, l.id`, [cuenta.cuentaContableId, fin]);
  if (!rows.length) return;

  // En tránsito: 1 de cada 12 movimientos de los últimos 3 días del mes todavía no aparece en el banco.
  const limite = sumarDias(fin, -2);
  const enBanco = rows.filter((r) => !(r.fecha >= limite && ctx.azar() < 1 / 12));
  const previo = (await db.query<{ saldo_final: string }>(
    `select saldo_final::text from extracto_bancario where cuenta_bancaria_id = $1 and estado = 'cerrado' order by anio desc, mes desc limit 1`, [cuenta.id])).rows[0];
  const saldoInicial = Number(previo?.saldo_final ?? 0);
  const movimientos = enBanco.reduce((s, r) => s + Number(r.neto), 0);

  const extractoId = await como(ctx, u.tesoreria, (tx) => crearExtracto(tx, u.tesoreria, {
    cuentaId: cuenta.id, anio, mes, saldoInicial: dos(saldoInicial), saldoFinal: dos(saldoInicial + movimientos),
  }));
  await como(ctx, u.tesoreria, async (tx) => {
    for (const r of enBanco) {
      const lineaBanco = await agregarLinea(tx, u.tesoreria, extractoId, {
        fecha: r.fecha < inicio ? inicio : r.fecha, descripcion: r.descripcion, referencia: r.referencia ?? undefined, monto: r.neto,
      });
      await conciliar(tx, u.tesoreria, lineaBanco, r.linea);
    }
  });
  await como(ctx, u.contabilidad, (tx) => cerrarExtracto(tx, u.contabilidad, extractoId));
  contar(ctx, 'conciliaciones_cerradas');
}

export async function cerrarUnMes(ctx: Ctx, anio: number, mes: number): Promise<void> {
  const { db, u } = ctx;
  const hoy = (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;

  // Comisiones del mes (liquidar, aprobar y pagar) y depreciación mensual de los activos fijos, antes de los demás puntos del cierre.
  await liquidarComisionesDelMes(ctx, anio, mes, hoy);
  if (ctx.estado.activoIds.length) {
    await como(ctx, u.contabilidad, (tx) => depreciarMes(tx, u.contabilidad, anio, mes));
    contar(ctx, 'meses_depreciados');
  }

  // Revaluación de las partidas en dólares con la tasa BCV del último día del mes.
  const rev = await estadoRevaluacion(db, anio, mes);
  if (!rev.ok && rev.calculo.items.length > 0) {
    const id = await como(ctx, u.contabilidad, (tx) => proponerRevaluacion(tx, u.contabilidad, anio, mes));
    await como(ctx, u.jefe_contabilidad, (tx) => resolverAprobacion(tx, 'revaluacion_cambiaria', id, u.jefe_contabilidad.id, 'aprobada'));
    contar(ctx, 'revaluaciones');
  }

  // Conciliación de cada cuenta bancaria con movimiento.
  const { rows: cuentas } = await db.query<{ id: string; moneda: string; cuenta_contable_id: string }>(
    `select id, moneda, cuenta_contable_id from cuenta_bancaria where activa and tipo <> 'caja' order by codigo`);
  for (const c of cuentas) await conciliarCuenta(ctx, { id: c.id, moneda: c.moneda, cuentaContableId: c.cuenta_contable_id }, anio, mes);

  // Retenciones del mes (la empresa ficticia es agente de IVA e ISLR y contribuyente especial): se emiten los comprobantes con su
  // numeración correlativa y se declaran, el IVA retenido por quincena y el ISLR por mes; después, la declaración de IVA del mes.
  const pend = await pendientes(db, anio, mes);
  if (pend.length) {
    const e = await como(ctx, u.contabilidad, (tx) => emitirPeriodo(tx, u.contabilidad, anio, mes));
    contar(ctx, 'comprobantes_de_retencion', e.emitidos);
  }
  const { rows: huboRet } = await db.query<{ impuesto: string }>(
    `select distinct impuesto from retencion_compra where nota_id is null and to_char(fecha, 'YYYYMM') = $1`, [`${anio}${String(mes).padStart(2, '0')}`]);
  const impuestos = new Set(huboRet.map((r) => r.impuesto));
  if (impuestos.has('iva')) {
    for (const quincena of [1, 2]) {
      await como(ctx, u.contabilidad, (tx) => declarar(tx, u.contabilidad, { tipo: 'retenciones_iva', anio, mes, quincena }));
      contar(ctx, 'declaraciones_retenciones_iva');
    }
  }
  if (impuestos.has('islr')) {
    await como(ctx, u.contabilidad, (tx) => declarar(tx, u.contabilidad, { tipo: 'retenciones_islr', anio, mes }));
    contar(ctx, 'declaraciones_retenciones_islr');
  }
  await como(ctx, u.contabilidad, (tx) => declarar(tx, u.contabilidad, { tipo: 'iva', anio, mes }));
  contar(ctx, 'declaraciones_iva');

  await como(ctx, u.contabilidad, (tx) => confirmarCierre(tx, u.contabilidad, anio, mes, 'recurrentes', 'Sin asientos recurrentes ni provisiones en la empresa ficticia'));

  const cl = await checklistCierre(db, anio, mes);
  if (!cl.listo) {
    const falta = cl.puntos.filter((p) => !p.ok).map((p) => `${p.titulo}: ${p.detalle}${p.pendientes?.length ? ` (${p.pendientes.join('; ')})` : ''}`);
    throw new Error(`El cierre de ${anio}-${String(mes).padStart(2, '0')} no quedó listo:\n  - ${falta.join('\n  - ')}`);
  }
  await como(ctx, u.contabilidad, (tx) => cerrarMes(tx, u.contabilidad, anio, mes));
  contar(ctx, 'meses_cerrados');
}
