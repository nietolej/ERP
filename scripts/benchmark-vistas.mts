/**
 * Mide las vistas de reportes con datos sintéticos, antes y después de una migración de índices.
 * Uso: npx tsx scripts/benchmark-vistas.mts [facturas] [migracion_a_medir.sql]
 *
 * Crea un PostgreSQL real y temporal (embedded-postgres), aplica las migraciones EXCEPTO la indicada,
 * genera datos con generate_series, mide con EXPLAIN ANALYZE, aplica la migración y vuelve a medir.
 * Es solo una herramienta de medición: no toca ninguna base real.
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { crearDbPostgres } from '../src/lib/db/postgres';
import { migrar, DIR_MIGRACIONES } from '../src/lib/db/migrar';
import { postgresTemporal } from '../tests/postgres-temporal';

const N = Number(process.argv[2] ?? 300_000);
const MIGRACION = process.argv[3] ?? '0056_indices_reportes.sql';

const { url, detener } = await postgresTemporal();
const dirBase = path.join(tmpdir(), `erp-bench-${Date.now()}`);
await mkdir(dirBase, { recursive: true });
for (const f of (await readdir(DIR_MIGRACIONES)).filter((f) => f.endsWith('.sql') && f !== MIGRACION)) {
  await copyFile(path.join(DIR_MIGRACIONES, f), path.join(dirBase, f));
}

const base = crearDbPostgres(url);
await migrar(base.db, dirBase);
await base.cerrar();

const c = new pg.Client({ connectionString: url });
await c.connect();
// Solo para la carga sintética: sin triggers ni llaves foráneas (los datos son de relleno y no se usan fuera de aquí).
await c.query(`set session_replication_role = replica`);

const t0 = Date.now();
await c.query(`
  insert into documento_venta (tipo, serie, numero, numero_control, estado, sucursal_id, almacen_id, cliente_id, vendedor_id,
                               fecha_emision, moneda, tasa, subtotal, base_imponible, iva, total, total_ves, total_usd, created_by,
                               fecha_vencimiento)
  select 'factura', 'A', g, 'C' || g, 'emitido', md5('s')::uuid, md5('a')::uuid, md5('c' || (g % 2000))::uuid, md5('v' || (g % 50))::uuid,
         timestamptz '2023-01-01' + (g::numeric / ${N} * 1095) * interval '1 day', 'USD', 36, 100, 100, 16, 116, 4176, 116, md5('u')::uuid,
         (timestamptz '2023-01-01' + (g::numeric / ${N} * 1095) * interval '1 day')::date + 30
    from generate_series(1, ${N}) g`);
// Una partida por factura: 5 % abiertas, el resto canceladas.
await c.query(`
  insert into partida_cxc (id, cliente_id, documento_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo, saldo_usd, estado)
  select md5('p' || d.numero)::uuid, d.cliente_id, d.id, (d.fecha_emision at time zone 'America/Caracas')::date,
         (d.fecha_emision at time zone 'America/Caracas')::date + 30, 'USD', 36, 116, 116,
         case when d.numero % 20 = 0 then 116 else 0 end, case when d.numero % 20 = 0 then 116 else 0 end,
         case when d.numero % 20 = 0 then 'abierta' else 'cancelada' end
    from documento_venta d`);
// Un cobro por factura cancelada y su aplicación.
await c.query(`
  insert into cobro (numero, cliente_id, fecha, instrumento_id, cuenta_bancaria_id, moneda, tasa, monto, monto_ves, monto_usd,
                     por_aplicar, por_aplicar_ves, por_aplicar_usd, created_by)
  select d.numero, d.cliente_id, (d.fecha_emision at time zone 'America/Caracas')::date + 10, md5('i')::uuid, md5('b')::uuid,
         'USD', 36, 116, 4176, 116, 0, 0, 0, md5('u')::uuid
    from documento_venta d where d.numero % 20 <> 0`);
await c.query(`
  insert into aplicacion_cobro (cobro_id, partida_id, origen, fecha, liquida, monto_cobro, tasa, monto_partida, usd_partida, base_ves, base_usd)
  select co.id, md5('p' || co.numero)::uuid, 'registro', co.fecha, true, 116, 36, 116, 116, 4176, 116
    from cobro co`);
await c.query('analyze');
console.log(`Datos sintéticos: ${N} facturas, partidas, cobros y aplicaciones (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);

const CONSULTAS: Record<string, string> = {
  'vw_venta_documento, un trimestre': `select sum(base_usd) from vw_venta_documento where fecha between '2025-01-01' and '2025-03-31'`,
  'vw_venta_documento, un mes por vendedor': `select vendedor_id, sum(base_usd) from vw_venta_documento where fecha between '2025-06-01' and '2025-06-30' group by 1`,
  'vw_cxc_antiguedad, todos los saldos': `select tramo, sum(saldo_usd) from vw_cxc_antiguedad group by 1`,
  'vw_cobro_aplicado, un trimestre': `select sum(monto_usd) from vw_cobro_aplicado where fecha between '2025-01-01' and '2025-03-31'`,
};

async function medir(): Promise<Record<string, number>> {
  const r: Record<string, number> = {};
  for (const [nombre, sql] of Object.entries(CONSULTAS)) {
    const tiempos: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { rows } = await c.query(`explain (analyze, format json) ${sql}`);
      tiempos.push(rows[0]['QUERY PLAN'][0]['Execution Time']);
    }
    tiempos.sort((a, b) => a - b);
    r[nombre] = tiempos[2]; // mediana de 5
  }
  return r;
}

const antes = await medir();
await c.query(readFileSync(path.join(DIR_MIGRACIONES, MIGRACION), 'utf8'));
await c.query('analyze');
const despues = await medir();

console.log('Consulta'.padEnd(44), 'antes (ms)'.padStart(12), 'después (ms)'.padStart(14), 'mejora'.padStart(8));
for (const k of Object.keys(CONSULTAS)) {
  console.log(k.padEnd(44), antes[k].toFixed(1).padStart(12), despues[k].toFixed(1).padStart(14), `${(antes[k] / despues[k]).toFixed(1)}x`.padStart(8));
}

await c.end();
await rm(dirBase, { recursive: true, force: true });
await detener();
