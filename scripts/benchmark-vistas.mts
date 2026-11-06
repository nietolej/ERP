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
const MIGRACION = process.argv[3]; // opcional: migración candidata a medir antes/después; sin ella solo se mide el estado actual

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

// Productos, terceros, líneas (3 por factura), notas de crédito (5 %) y movimientos de comisión (1 de cada 4 facturas).
await c.query(`
  insert into producto (id, codigo, descripcion, grupo_id, marca_id, alicuota_iva_id, producto_base_id, linea_calidad)
  select md5('prod' || g)::uuid, 'P' || g, 'Producto ' || g, md5('g' || (g % 20))::uuid, md5('m' || (g % 30))::uuid,
         (select id from alicuota_iva limit 1), md5('pb' || g)::uuid, 'oem'
    from generate_series(1, 2000) g`);
// Solo en la base temporal: los RIF de relleno no llevan dígito verificador válido.
await c.query('alter table tercero drop constraint tercero_rif_check');
await c.query(`
  insert into tercero (id, rif, razon_social, tipo_persona)
  select md5('c' || g)::uuid, 'J' || lpad(g::text, 9, '0'), 'Cliente ' || g, 'J' from generate_series(0, 1999) g`);
await c.query(`
  insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, alicuota_iva_id,
                                     alicuota_pct, base, iva, total, costo_unitario_usd, precio_lista)
  select d.id, l, md5('prod' || ((d.numero * 7 + l) % 2000 + 1))::uuid, 'Linea', 2, 50, (select id from alicuota_iva limit 1),
         16, 100, 16, 116, 30, 50
    from documento_venta d cross join generate_series(1, 3) l`);
await c.query(`
  insert into documento_venta (tipo, serie, numero, estado, sucursal_id, almacen_id, cliente_id, vendedor_id, documento_origen_id,
                               fecha_emision, moneda, tasa, subtotal, base_imponible, iva, total, total_ves, total_usd, created_by, motivo_nc)
  select 'nota_credito', 'A', ${N} + d.numero, 'emitido', d.sucursal_id, d.almacen_id, d.cliente_id, d.vendedor_id, d.id,
         d.fecha_emision + interval '5 days', 'USD', 36, 10, 10, 1.6, 11.6, 417.6, 11.6, d.created_by, 'devolucion'
    from documento_venta d where d.tipo = 'factura' and d.numero % 20 = 1`);
await c.query(`
  insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, alicuota_iva_id,
                                     alicuota_pct, base, iva, total, costo_unitario_usd)
  select n.id, 1, md5('prod' || (n.numero % 2000 + 1))::uuid, 'Devolucion', 1, 10, (select id from alicuota_iva limit 1), 16, 10, 1.6, 11.6, 6
    from documento_venta n where n.tipo = 'nota_credito'`);
await c.query(`
  insert into comision_movimiento (vendedor_id, fecha, tipo, origen_tipo, origen_id, factura_id, base_usd, porcentaje, monto_usd, monto_ves,
                                   calculo, asiento_id, created_by)
  select d.vendedor_id, (d.fecha_emision at time zone 'America/Caracas')::date + 10, 'devengo', 'aplicacion_cobro', md5('o' || d.numero)::uuid,
         d.id, 100, 2, 2, 72, '{}'::jsonb, md5('as' || d.numero)::uuid, md5('u')::uuid
    from documento_venta d where d.tipo = 'factura' and d.numero % 4 = 0`);
await c.query('analyze');
console.log(`Datos sintéticos: ${N} facturas, partidas, cobros y aplicaciones (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);

const CONSULTAS: Record<string, string> = {
  'vw_venta_documento, un trimestre': `select sum(base_usd) from vw_venta_documento where fecha between '2025-01-01' and '2025-03-31'`,
  'vw_venta_documento, un mes por vendedor': `select vendedor_id, sum(base_usd) from vw_venta_documento where fecha between '2025-06-01' and '2025-06-30' group by 1`,
  'vw_cxc_antiguedad, todos los saldos': `select tramo, sum(saldo_usd) from vw_cxc_antiguedad group by 1`,
  'vw_venta_linea, un trimestre por marca': `select marca_id, sum(base_usd) from vw_venta_linea where fecha between '2025-01-01' and '2025-03-31' group by 1`,
  'vw_nota_credito_linea, un trimestre': `select sum(base_usd) from vw_nota_credito_linea where fecha between '2025-01-01' and '2025-03-31'`,
  'vw_rentabilidad_linea, un trimestre': `select sum(venta_usd), sum(costo_usd), sum(comision_usd) from vw_rentabilidad_linea where fecha between '2025-01-01' and '2025-03-31'`,
  'vw_rentabilidad_linea, un mes por vendedor': `select vendedor_id, sum(venta_usd - costo_usd - comision_usd) from vw_rentabilidad_linea where fecha between '2025-06-01' and '2025-06-30' group by 1`,
  'vw_libro_ventas, un mes': `select sum(base_ves), sum(iva_ves) from vw_libro_ventas where periodo = '2025-06-01' and incluido`,
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
let despues = antes;
if (MIGRACION) {
  await c.query(readFileSync(path.join(DIR_MIGRACIONES, MIGRACION), 'utf8'));
  await c.query('analyze');
  despues = await medir();
}
if (process.env.PLANES) {
  for (const [nombre, sql] of Object.entries(CONSULTAS)) {
    if (!process.env.PLANES.split('|').some((p) => nombre.includes(p))) continue;
    const { rows } = await c.query(`explain (analyze, costs off, timing off, summary off) ${sql}`);
    console.log(`\n== ${nombre}\n` + rows.map((r) => r['QUERY PLAN']).join('\n'));
  }
}

console.log('Consulta'.padEnd(44), 'antes (ms)'.padStart(12), 'después (ms)'.padStart(14), 'mejora'.padStart(8));
for (const k of Object.keys(CONSULTAS)) {
  console.log(k.padEnd(44), antes[k].toFixed(1).padStart(12), despues[k].toFixed(1).padStart(14), `${(antes[k] / despues[k]).toFixed(1)}x`.padStart(8));
}

await c.end();
await rm(dirBase, { recursive: true, force: true });
await detener();
