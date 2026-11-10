/**
 * Siembra completa de la empresa ficticia sobre una base ya migrada y VACÍA. La usan el comando
 * (scripts/sembrar-demo.mts) y la prueba de integración (tests/siembra-demo.test.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { almacenEnDisco } from '../../src/lib/adjuntos/almacen';
import type { Db } from '../../src/lib/db/tipos';
import { crearAzar, fijarReloj, restaurarReloj, sumarDias, type Ctx } from './base.mts';
import { sembrarFundaciones } from './fundaciones.mts';
import { sembrarMaestros } from './maestros.mts';
import { simular } from './operacion.mts';
import { verificar } from './verificacion.mts';

export interface OpcionesSiembra {
  db: Db;
  /** Primer día de ventas (AAAA-MM-DD). Una semana antes se compra y recibe la mercancía. */
  desde: string;
  hasta: string;
  semilla: number;
  /** Agrega estacionalidad, feriados, alzas de costo, mora y saltos cambiarios (para simulaciones largas). */
  ruido?: boolean;
  /** Carpeta de los soportes (PDF) de gastos y vales; por omisión, una temporal. */
  adjuntosDir?: string;
  log?: (texto: string) => void;
}

export interface ResultadoSiembra {
  ok: boolean;
  resumen: Record<string, number>;
  avisos: [string, number][];
  verificacion: string[];
}

export async function sembrarDemo(o: OpcionesSiembra): Promise<ResultadoSiembra> {
  const log = o.log ?? (() => {});
  const { rows } = await o.db.query<{ n: string }>('select count(*)::text as n from empresa');
  if (Number(rows[0].n) > 0) throw new Error('La base ya tiene una empresa: la siembra de demostración solo corre sobre una base vacía.');

  const preparacion = sumarDias(o.desde, -8);
  fijarReloj(preparacion, 8);
  try {
    const ctx = { db: o.db, azar: crearAzar(o.semilla), desde: o.desde, hasta: o.hasta, ruido: o.ruido ?? false, agenda: new Map(), resumen: {}, avisos: new Map(),
      estado: { secuencia: 0, enCamino: new Map(), fondoId: null, valesSinReponer: 0, activoIds: [] as string[], kits: [] as Ctx['estado']['kits'], azarCrm: crearAzar((o.semilla ^ 0x5eed) >>> 0), prospectos: 0 },
      archivos: almacenEnDisco(o.adjuntosDir ?? mkdtempSync(path.join(tmpdir(), 'erp-demo-adjuntos-'))) } as Ctx;
    const anios = [...new Set([preparacion.slice(0, 4), o.hasta.slice(0, 4)])].map(Number);
    Object.assign(ctx, await sembrarFundaciones(ctx.db, anios));
    log('Fundaciones listas: empresa, periodos, usuarios por rol, almacén y bancos.');
    Object.assign(ctx, await sembrarMaestros(ctx, preparacion));
    log(`Maestros listos: ${ctx.productos.length} productos, ${ctx.clientes.length} clientes, ${ctx.proveedores.length} proveedores.`);
    log('Simulando la operación día por día…');
    await simular(ctx, log);
    restaurarReloj();
    const v = await verificar(ctx);
    return { ok: v.ok, resumen: ctx.resumen, avisos: [...ctx.avisos.entries()].sort((a, b) => b[1] - a[1]), verificacion: v.lineas };
  } finally {
    restaurarReloj();
  }
}
