/**
 * Ruido de la empresa ficticia para simulaciones largas: lo que hace que doce meses no sean doce copias del primero.
 *
 * - Estacionalidad: más ventas en diciembre, menos en enero y agosto.
 * - Feriados (fijos): el negocio cierra, sin ventas, gastos, producción ni conteos.
 * - Costos: cada trimestre los proveedores suben sus precios y Gerencia actualiza los precios de venta.
 * - Cobro: algunos clientes pagan con mucho retraso y otros no pagan dentro del horizonte (cartera vencida).
 * - Tasa: dos saltos cambiarios al año además de la deriva diaria.
 */
import { fijarPrecio } from '../../src/lib/maestros/productos';
import { como, contar, type Ctx } from './base.mts';

const FERIADOS = new Set(['01-01', '04-19', '05-01', '06-24', '07-05', '07-24', '10-12', '12-24', '12-25', '12-31']);

export const esFeriado = (fecha: string): boolean => FERIADOS.has(fecha.slice(5));

const ESTACION: Record<string, number> = { '01': 0.7, '02': 0.9, '03': 1, '04': 1, '05': 1, '06': 1, '07': 0.95, '08': 0.8, '09': 1, '10': 1.05, '11': 1.15, '12': 1.4 };
export const factorEstacional = (fecha: string): number => ESTACION[fecha.slice(5, 7)] ?? 1;

/** Salto cambiario: dos veces al año (primer lunes de marzo y de septiembre) la tasa sube entre 6 % y 12 % de golpe. */
export const saltoCambiario = (ctx: Ctx, fecha: string, dia: number): number =>
  dia === 1 && Number(fecha.slice(8)) <= 7 && (fecha.slice(5, 7) === '03' || fecha.slice(5, 7) === '09') ? 1 + ctx.azar.entero(6, 12) / 100 : 1;

/** Primer lunes de enero, abril, julio y octubre: los proveedores suben sus costos y Gerencia ajusta los precios de venta. */
export async function ajustarCostos(ctx: Ctx, fecha: string, dia: number): Promise<void> {
  const mes = fecha.slice(5, 7);
  if (dia !== 1 || Number(fecha.slice(8)) > 7 || !['01', '04', '07', '10'].includes(mes)) return;
  const factorPorMarca = new Map<string, number>();
  for (const p of ctx.proveedores) factorPorMarca.set(p.marcaId, 1 + ctx.azar.entero(2, 8) / 100);
  for (const p of ctx.productos) {
    const f = factorPorMarca.get(p.marcaId);
    if (!f) continue;
    p.costoUsd = Math.round(p.costoUsd * f * 100) / 100;
    p.precioBUsd = Math.round(p.costoUsd * 1.45 * 100) / 100;
    const precio = (x: number) => (Math.round(p.costoUsd * x * 100) / 100).toFixed(2);
    await como(ctx, ctx.u.gerencia, async (tx) => {
      await fijarPrecio(tx, p.id, 'A', precio(1.6), fecha);
      await fijarPrecio(tx, p.id, 'B', precio(1.45), fecha);
      await fijarPrecio(tx, p.id, 'D', precio(1.3), fecha);
    });
  }
  contar(ctx, 'ajustes_de_costos');
}

/** Retraso extra de cobro: 8 % de las facturas a crédito tarda 30 a 70 días más; 3 % no se cobra dentro del horizonte. */
export function retrasoExtra(ctx: Ctx): number | null {
  const r = ctx.azar();
  if (r < 0.03) return null;
  return r < 0.11 ? ctx.azar.entero(30, 70) : 0;
}
