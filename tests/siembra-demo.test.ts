import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/tipos';
import { sembrarDemo, type ResultadoSiembra } from '../scripts/demo/sembrar.mts';
import { baseDePrueba } from './apoyo';

/**
 * La empresa ficticia de demostración (scripts/sembrar-demo.mts) recorre los flujos reales del ERP con un reloj simulado.
 * Esta prueba es el criterio de "no se rompió nada de punta a punta": si una regla nueva choca con un flujo existente,
 * la siembra falla aquí aunque cada prueba por pieza siga en verde.
 */
describe('siembra de la empresa ficticia de demostración', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let r: ResultadoSiembra;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    r = await sembrarDemo({ db, desde: '2026-10-26', hasta: '2026-11-04', semilla: 7 });
  }, 120_000);
  afterAll(() => cerrar());

  it('recorre compras, ventas y cobros y todas las comprobaciones de cuadre pasan', () => {
    expect(r.verificacion.filter((l) => l.startsWith('✘'))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.resumen.ordenes_compra).toBeGreaterThan(0);
    expect(r.resumen.recepciones).toBeGreaterThan(0);
    expect(r.resumen.recepciones).toBeLessThanOrEqual(r.resumen.ordenes_compra);   // una importación puede seguir en tránsito al terminar
    expect(r.resumen.facturas_venta).toBeGreaterThan(10);
    expect(r.resumen.cobros).toBeGreaterThan(0);
  });

  it('abre la empresa (saldos iniciales aprobados, apertura cerrada) y cierra el mes terminado con su checklist completo', async () => {
    expect(r.resumen.documentos_de_apertura).toBe(15);            // bancos, conteo, facturas pendientes, asiento del contador y 3 activos
    expect(r.verificacion.some((l) => l.startsWith('✔ Apertura cerrada'))).toBe(true);
    expect(r.resumen.meses_cerrados).toBe(1);                                 // octubre; noviembre sigue abierto
    expect(r.resumen.conciliaciones_cerradas).toBe(2);                        // banco en bolívares y en dólares
    expect(r.resumen.declaraciones_iva).toBe(1);
    // Comisiones sobre lo cobrado y depreciación mensual de los activos de la apertura.
    expect(r.resumen.planes_de_comision).toBe(1);
    expect(r.resumen.ordenes_produccion).toBeGreaterThan(0);
    expect(r.resumen.ajustes_de_inventario).toBeGreaterThan(0);
    expect(r.resumen.liquidaciones_pagadas).toBeGreaterThan(0);
    expect(r.resumen.meses_depreciados).toBe(1);
    // Empresa agente de retención y contribuyente especial: comprobantes numerados y el IVA retenido se declara por quincena.
    expect(r.resumen.comprobantes_de_retencion).toBeGreaterThan(0);
    expect(r.resumen.declaraciones_retenciones_iva).toBe(2);
    expect(r.verificacion.filter((l) => l.includes('por enterar') || l.includes('sin comprobante')).every((l) => l.startsWith('✔'))).toBe(true);
    const { rows } = await db.query<{ anio: number; mes: number; estado: string }>(
      `select anio, mes, estado from periodo_contable where mes <= 12 and (anio, mes) in ((2026, 10), (2026, 11)) order by mes`);
    expect(rows.map((p) => [p.mes, p.estado])).toEqual([[10, 'cerrado'], [11, 'abierto']]);
  });

  it('registra gastos, caja chica y notas, y todo sigue cuadrando', () => {
    expect(r.resumen.gastos_de_proveedor).toBeGreaterThan(0);
    expect(r.resumen.fondos_de_caja_chica).toBe(1);
    expect(r.resumen.vales_de_caja_chica).toBeGreaterThan(0);
    const notas = Object.entries(r.resumen).filter(([k]) => k.startsWith('notas_')).reduce((n, [, v]) => n + v, 0);
    expect(notas).toBeGreaterThan(0);
    expect(r.verificacion.filter((l) => l.startsWith('✘'))).toEqual([]);
  });

  it('marca la empresa como demostración y la marca no se cambia', async () => {
    const { rows } = await db.query<{ es_demo: boolean; razon_social: string }>('select es_demo, razon_social from empresa');
    expect(rows).toHaveLength(1);
    expect(rows[0].es_demo).toBe(true);
    expect(rows[0].razon_social).toContain('DEMO');
    await expect(db.query('update empresa set es_demo = false')).rejects.toThrow('no se cambia');
  });

  it('las facturas llevan la fecha del día simulado, no la de hoy', async () => {
    const { rows } = await db.query<{ primera: string; ultima: string }>(
      `select min((fecha_emision at time zone 'America/Caracas')::date)::text as primera,
              max((fecha_emision at time zone 'America/Caracas')::date)::text as ultima
         from documento_venta where tipo = 'factura' and not apertura`);   // las de apertura traen su fecha original, anterior al arranque
    expect(rows[0].primera >= '2026-10-26').toBe(true);
    expect(rows[0].ultima <= '2026-11-04').toBe(true);
  });

  it('no se siembra sobre una base que ya tiene empresa', async () => {
    await expect(sembrarDemo({ db, desde: '2026-10-05', hasta: '2026-10-06', semilla: 1 })).rejects.toThrow('solo corre sobre una base vacía');
  });
});

describe('la siembra es reproducible', () => {
  it('con la misma semilla y las mismas fechas da las mismas cifras', async () => {
    const totales: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { db, cerrar } = await baseDePrueba();
      try {
        const res = await sembrarDemo({ db, desde: '2026-10-05', hasta: '2026-10-09', semilla: 3 });
        const { rows } = await db.query<{ total: string; n: string }>('select coalesce(sum(total_usd), 0)::text as total, count(*)::text as n from documento_venta where tipo = \'factura\'');
        totales.push(`${rows[0].n}|${rows[0].total}|${JSON.stringify(res.resumen)}`);
      } finally {
        await cerrar();
      }
    }
    expect(totales[0]).toBe(totales[1]);
  }, 120_000);

  it('con ruido (feriado, alza de costos, mora) sigue cuadrando y es reproducible', async () => {
    const corridas: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { db, cerrar } = await baseDePrueba();
      try {
        // 6 de julio de 2026: primer lunes de julio (alzan los costos); el 5 de julio es feriado.
        const res = await sembrarDemo({ db, desde: '2026-07-01', hasta: '2026-07-10', semilla: 5, ruido: true });
        expect(res.verificacion.filter((l) => l.startsWith('✘'))).toEqual([]);
        expect(res.resumen.ajustes_de_costos).toBe(1);
        expect(res.resumen.facturas_venta).toBeGreaterThan(5);
        corridas.push(JSON.stringify(res.resumen));
      } finally {
        await cerrar();
      }
    }
    expect(corridas[0]).toBe(corridas[1]);
  }, 240_000);
});
