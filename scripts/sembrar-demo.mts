/**
 * Siembra una empresa FICTICIA de demostración con operación simulada, usando las mismas funciones del ERP.
 *
 * Uso: npm run db:sembrar-demo -- [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--semilla 1] [--dir .data/demo] [--reiniciar] [--ruido]
 *
 * - Por defecto simula los últimos 30 días hasta ayer, para que "hoy" en pantalla coincida con el día real.
 * - Crea una base PGlite NUEVA en --dir (por defecto .data/demo). No usa DATABASE_URL ni toca la base de desarrollo
 *   (.data/erp): una base de producción jamás se siembra con datos ficticios.
 * - La empresa queda marcada como demostración (empresa.es_demo, migración 0057) y su razón social lo dice.
 * - Con la misma semilla y las mismas fechas genera siempre los mismos datos.
 * - Para usarla: PGLITE_DIR=.data/demo ADJUNTOS_DIR=.data/demo-adjuntos npm run dev   (usuarios <rol>@demo.test; la clave está en scripts/demo/fundaciones.mts)
 */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { crearDbPglite } from '../src/lib/db/pglite';
import { migrar } from '../src/lib/db/migrar';
import { sumarDias } from './demo/base.mts';
import { sembrarDemo } from './demo/sembrar.mts';

const hoyCaracas = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
const ayer = sumarDias(hoyCaracas, -1);

const { values } = parseArgs({
  options: {
    desde: { type: 'string', default: sumarDias(ayer, -30) },
    hasta: { type: 'string', default: ayer },
    semilla: { type: 'string', default: '1' },
    dir: { type: 'string', default: path.join('.data', 'demo') },
    reiniciar: { type: 'boolean', default: false },
    ruido: { type: 'boolean', default: false },
  },
});
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
if (!FECHA.test(values.desde!) || !FECHA.test(values.hasta!) || values.desde! > values.hasta!) {
  console.error('Indique --desde y --hasta como AAAA-MM-DD, con desde ≤ hasta.');
  process.exit(1);
}
const dir = path.resolve(values.dir!);
const adjuntosDir = `${dir}-adjuntos`;                              // soportes de gastos y vales (ADJUNTOS_DIR)
if (existsSync(dir) && readdirSync(dir).length > 0) {
  if (!values.reiniciar) {
    console.error(`${dir} ya tiene datos. Use --reiniciar para borrarla y volver a sembrar.`);
    process.exit(1);
  }
  // Solo se borra una carpeta pensada para demostración: nunca la base de desarrollo (.data/erp) ni otra cosa.
  if (!/^demo/i.test(path.basename(dir))) {
    console.error(`Por seguridad, --reiniciar solo borra carpetas cuyo nombre empieza por "demo" (esta se llama "${path.basename(dir)}").`);
    process.exit(1);
  }
  await rm(dir, { recursive: true, force: true });
  await rm(adjuntosDir, { recursive: true, force: true });
}

const inicio = Date.now();
console.log(`Sembrando la empresa ficticia en ${dir}\n  Ventas del ${values.desde} al ${values.hasta} (semilla ${values.semilla})`);
const base = await crearDbPglite(dir);
let salida = 0;
try {
  await migrar(base.db);
  const r = await sembrarDemo({ db: base.db, desde: values.desde!, hasta: values.hasta!, semilla: Number(values.semilla), ruido: values.ruido, adjuntosDir, log: (t) => console.log(t) });
  console.log('\nDocumentos creados:');
  for (const [k, v] of Object.entries(r.resumen).sort()) console.log(`  ${k.replaceAll('_', ' ')}: ${v}`);
  if (r.avisos.length) {
    console.log('\nSituaciones de negocio que el ERP rechazó (esperadas en parte; revisar si alguna sorprende):');
    for (const [m, n] of r.avisos) console.log(`  ${n}× ${m}`);
  }
  console.log('\nVerificación:');
  for (const l of r.verificacion) console.log(`  ${l}`);
  if (!r.ok) salida = 2;
} catch (e) {
  console.error('\nLa siembra se detuvo con un error del ERP (es un hallazgo, no un problema de los datos):');
  console.error(e);
  salida = 1;
} finally {
  await base.cerrar();
}
console.log(`\n${salida === 0 ? 'Listo' : 'Terminó con problemas'} en ${((Date.now() - inicio) / 1000).toFixed(0)} s.`);
process.exit(salida);
