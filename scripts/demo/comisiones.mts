/**
 * Comisiones de venta con base cobrada (spec §5.2, migración 0053): un plan con reglas por grupo y marca que el Supervisor de
 * ventas crea y Gerencia aprueba, asignado a cada vendedor; el devengo ocurre solo al cobrar (lo hace el ERP en registrarCobro) y
 * cada mes terminado Contabilidad arma las liquidaciones, Gerencia las aprueba y Tesorería las paga.
 */
import { asignarPlan, crearPlan, enviarPlan, generarLiquidaciones, pagarLiquidacion } from '../../src/lib/comisiones/comisiones';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { como, contar, type Ctx } from './base.mts';

/** Día 0: plan estándar (3 % general, 4 % en frenos, 2 % en la marca importada más barata) asignado a los tres vendedores. */
export async function sembrarPlanComision(ctx: Ctx, desde: string): Promise<void> {
  const { db, u } = ctx;
  const id = async (sql: string, p: unknown[]) => (await db.query<{ id: string }>(sql, p)).rows[0].id;
  const frenos = await id(`select id from grupo_producto where codigo = 'FRENOS'`, []);
  const korven = await id(`select id from marca where codigo = 'KORVEN'`, []);
  const plan = await como(ctx, u.supervisor_ventas, (tx) => crearPlan(tx, u.supervisor_ventas, {
    nombre: 'Plan estándar de ventas',
    reglas: [{ porcentaje: '3' }, { grupoId: frenos, porcentaje: '4' }, { marcaId: korven, porcentaje: '2' }],
  }));
  await como(ctx, u.supervisor_ventas, (tx) => enviarPlan(tx, u.supervisor_ventas, plan));
  await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'plan_comision', plan, u.gerencia.id, 'aprobada'));
  for (const v of (await db.query<{ id: string }>('select id from vendedor order by codigo')).rows) {
    await como(ctx, u.supervisor_ventas, (tx) => asignarPlan(tx, u.supervisor_ventas, { vendedorId: v.id, planId: plan, desde }));
  }
  contar(ctx, 'planes_de_comision');
}

/** Primer día del mes siguiente: liquida el mes terminado, Gerencia aprueba y Tesorería paga desde la cuenta en dólares. */
export async function liquidarComisionesDelMes(ctx: Ctx, anio: number, mes: number, hoy: string): Promise<void> {
  const { u } = ctx;
  const periodo = `${anio}-${String(mes).padStart(2, '0')}`;
  const r = await como(ctx, u.contabilidad, (tx) => generarLiquidaciones(tx, u.contabilidad, periodo));
  for (const l of r.creadas) {
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'liquidacion_comision', l.id, u.gerencia.id, 'aprobada'));
    await como(ctx, u.tesoreria, (tx) => pagarLiquidacion(tx, u.tesoreria, l.id, { cuentaBancariaId: ctx.cuentaUsdId, fecha: hoy, referencia: `Comisiones ${periodo}` }));
    contar(ctx, 'liquidaciones_pagadas');
  }
}
