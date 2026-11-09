/**
 * Comprobaciones al terminar la siembra: lo que la empresa ficticia registró tiene que cuadrar como en producción.
 * Si algo no cuadra, la siembra termina con error: eso es un hallazgo sobre el ERP, no sobre los datos.
 */
import { controlApertura, estadoArranque } from '../../src/lib/apertura/apertura';
import { cuadreCaja } from '../../src/lib/gastos/caja-chica';
import { cuadreAuxiliares } from '../../src/lib/contabilidad/cierre';
import type { Ctx } from './base.mts';

export async function verificar(ctx: Ctx): Promise<{ ok: boolean; lineas: string[] }> {
  const { db } = ctx;
  const lineas: string[] = [];
  let ok = true;
  const marca = (bien: boolean, texto: string) => { lineas.push(`${bien ? '✔' : '✘'} ${texto}`); if (!bien) ok = false; };

  const mayor = (await db.query<{ ves: string; usd: string; asientos: string; lineas: string }>(
    `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves, coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd,
            count(distinct a.id)::text as asientos, count(*)::text as lineas
       from asiento_linea l join asiento a on a.id = l.asiento_id where a.estado = 'contabilizado'`)).rows[0];
  marca(Number(mayor.ves) === 0 && Number(mayor.usd) === 0, `Mayor cuadrado: ${mayor.asientos} asientos, ${mayor.lineas} líneas (diferencia VES ${mayor.ves}, USD ${mayor.usd})`);

  for (const c of await cuadreAuxiliares(db)) marca(c.ok, `Auxiliar ${c.nombre} (${c.moneda}): mayor ${c.mayor} · auxiliar ${c.auxiliar}`);

  const ap = await controlApertura(db);
  marca((await estadoArranque(db)).cerrada, 'Apertura cerrada por Gerencia');
  marca(Number(ap.saldoPuenteVes) === 0, `«Saldos de apertura» (3.9.01) en cero en bolívares (${ap.saldoPuenteVes}); residuo en USD por tasas históricas: ${ap.saldoPuenteUsd}`);

  const bancos = (await db.query<{ nombre: string; moneda: string; saldo: string }>(
    `select cb.nombre, cb.moneda, coalesce(sum(case when cb.moneda = 'USD' then l.debe_usd - l.haber_usd else l.debe_ves - l.haber_ves end), 0)::text as saldo
       from cuenta_bancaria cb left join asiento_linea l on l.cuenta_id = cb.cuenta_contable_id
       left join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' group by cb.id, cb.nombre, cb.moneda order by cb.nombre`)).rows;
  for (const b of bancos) marca(Number(b.saldo) >= 0, `Saldo de ${b.nombre}: ${b.moneda} ${Number(b.saldo).toFixed(2)} (no negativo)`);

  for (const f of await cuadreCaja(db)) marca(f.cuadra, `Caja chica ${f.codigo} (${f.moneda}): mayor ${f.mayor} · fondo según vales y reposiciones ${f.auxiliar}`);

  // Retenciones: las cuentas por enterar cuadran con las retenciones registradas (USD) y ninguna retención de un mes cerrado quedó sin comprobante.
  for (const [impuesto, cuenta] of [['iva', '2.1.04'], ['islr', '2.1.05']] as const) {
    const { rows } = await db.query<{ mayor: string; registrado: string }>(
      `select coalesce((select sum(l.haber_usd - l.debe_usd) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                          join cuenta_contable c on c.id = l.cuenta_id where c.codigo = $2), 0)::text as mayor,
              coalesce((select sum(monto_usd * signo) from retencion_compra where impuesto = $1), 0)::text as registrado`, [impuesto, cuenta]);
    marca(Number(rows[0].mayor) === Number(rows[0].registrado), `Retenciones de ${impuesto.toUpperCase()} por enterar (${cuenta}): mayor US$ ${rows[0].mayor} · retenciones registradas US$ ${rows[0].registrado}`);
  }
  const sinComprobante = Number((await db.query<{ n: string }>(
    `select count(*)::text as n from retencion_compra r join periodo_contable p on r.fecha between p.inicio and p.fin and p.mes <= 12
      where p.estado <> 'abierto' and r.nota_id is null and r.signo = 1 and not exists (select 1 from comprobante_retencion c where c.retencion_id = r.id)`)).rows[0].n);
  marca(sinComprobante === 0, `Sin retenciones de meses cerrados sin comprobante (${sinComprobante})`);

  const borradores = Number((await db.query<{ n: string }>(`select count(*)::text as n from asiento where estado = 'borrador'`)).rows[0].n);
  marca(borradores === 0, `Sin asientos en borrador (${borradores})`);

  const pendientes = Number((await db.query<{ n: string }>(`select count(*)::text as n from solicitud_aprobacion where estado = 'pendiente'`)).rows[0].n);
  marca(pendientes === 0, `Sin aprobaciones pendientes en la bandeja (${pendientes})`);

  const abiertas = Number((await db.query<{ n: string }>(`select count(*)::text as n from orden_produccion where estado in ('borrador', 'pendiente', 'liberada', 'en_proceso')`)).rows[0].n);
  marca(abiertas === 0, `Sin órdenes de producción a medias (${abiertas})`);
  const ajustesAbiertos = Number((await db.query<{ n: string }>(`select count(*)::text as n from ajuste_inventario where estado in ('borrador', 'pendiente')`)).rows[0].n);
  marca(ajustesAbiertos === 0, `Sin ajustes de inventario a medias (${ajustesAbiertos})`);

  const mes = (await db.query<{ mes: string; facturas: string; venta_usd: string }>(
    `select to_char(fecha, 'YYYY-MM') as mes, count(*)::text as facturas, sum(base_usd)::text as venta_usd
       from vw_venta_documento group by 1 order by 1`)).rows;
  for (const m of mes) lineas.push(`  Ventas ${m.mes}: ${m.facturas} facturas, US$ ${Number(m.venta_usd).toFixed(2)} sin IVA`);

  const cxc = (await db.query<{ abiertas: string; saldo_usd: string; vencidas: string }>(
    `select count(*)::text as abiertas, coalesce(sum(saldo_usd), 0)::text as saldo_usd,
            count(*) filter (where vencimiento < (now() at time zone 'America/Caracas')::date)::text as vencidas
       from vw_cxc_antiguedad`)).rows[0];
  lineas.push(`  Cuentas por cobrar: ${cxc.abiertas} partidas abiertas (${cxc.vencidas} vencidas), US$ ${Number(cxc.saldo_usd).toFixed(2)}`);
  return { ok, lineas };
}
