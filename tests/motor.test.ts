import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { contabilizar, type EventoContable } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Pruebas del motor con un evento de ejemplo ("factura_prueba"): CxC al debe por el total,
 * ventas e IVA al haber. Las reglas reales de cada documento se agregan en su fase.
 */
describe('motor de contabilización', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let usuario: string;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    usuario = await usuarioDePrueba(db);
    await db.query('select fn_crear_periodos(2026)');
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ('2026-04-01', 'USD', 36.123457)`);
    const reglas: [number, 'D' | 'H', string, string][] = [
      [1, 'D', '1.2.01', 'total'],
      [2, 'H', '4.1.01', 'base'],
      [3, 'H', '2.1.03', 'iva'],
    ];
    for (const [orden, lado, codigo, importe] of reglas) {
      await db.query(
        `insert into regla_contable (evento, orden, lado, cuenta_id, importe) values ('factura_prueba', $1, $2, $3, $4)`,
        [orden, lado, await cuenta(db, codigo), importe],
      );
    }
  });
  afterAll(() => cerrar());

  const evento = (importes: Record<string, string>, moneda = 'USD', id = randomUUID()): EventoContable => ({
    evento: 'factura_prueba',
    fecha: '2026-04-02',
    descripcion: 'Factura de prueba',
    origen: { tipo: 'factura_prueba', id },
    moneda,
    importes,
    usuarioId: usuario,
  });

  async function lineas(asientoId: string) {
    const { rows } = await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
      `select c.codigo, l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd
         from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id
        where l.asiento_id = $1 order by l.id`,
      [asientoId],
    );
    return rows;
  }

  it('genera un asiento en USD y VES a la tasa del día (la cuenta de CxC acepta asientos automáticos)', async () => {
    const r = await db.transaction((tx) => contabilizar(tx, evento({ base: '100.00', iva: '16.00', total: '116.00' })));
    expect(r.yaExistia).toBe(false);
    const l = await lineas(r.asientoId);
    expect(l[0]).toMatchObject({ codigo: '1.2.01', debe_usd: '116.00', debe_ves: '4190.32' }); // 116 × 36.123457 = 4190.321…
    expect(l[1]).toMatchObject({ codigo: '4.1.01', haber_usd: '100.00', haber_ves: '3612.35' });
    expect(l[2]).toMatchObject({ codigo: '2.1.03', haber_usd: '16.00', haber_ves: '577.98' });
  });

  it('compensa con una línea de redondeo la diferencia de centavos de la conversión', async () => {
    // 116 → 4190.32 ; 100 → 3612.35 ; 16 → 577.98 → haber 4190.33: 1 centavo de diferencia
    const r = await db.transaction((tx) => contabilizar(tx, evento({ base: '100.00', iva: '16.00', total: '116.00' })));
    const l = await lineas(r.asientoId);
    const redondeo = l.find((x) => x.codigo === '6.3.03');
    expect(redondeo).toMatchObject({ debe_ves: '0.01', haber_ves: '0.00' });
    const d = l.reduce((s, x) => s + Number(x.debe_ves), 0);
    const h = l.reduce((s, x) => s + Number(x.haber_ves), 0);
    expect(d.toFixed(2)).toBe(h.toFixed(2));
  });

  it('convierte documentos en bolívares a USD con la tasa del día', async () => {
    const r = await db.transaction((tx) =>
      contabilizar(tx, evento({ base: '3612.35', iva: '577.98', total: '4190.33' }, 'VES')));
    const l = await lineas(r.asientoId);
    expect(l[0]).toMatchObject({ codigo: '1.2.01', debe_ves: '4190.33', debe_usd: '116.00' });
  });

  it('es idempotente: el mismo documento no genera dos asientos', async () => {
    const id = randomUUID();
    const a = await db.transaction((tx) => contabilizar(tx, evento({ base: '10.00', iva: '1.60', total: '11.60' }, 'USD', id)));
    const b = await db.transaction((tx) => contabilizar(tx, evento({ base: '10.00', iva: '1.60', total: '11.60' }, 'USD', id)));
    expect(b).toEqual({ ...a, yaExistia: true });
    const { rows } = await db.query<{ n: string }>(`select count(*) as n from asiento where origen_id = $1`, [id]);
    expect(rows[0].n).toBe('1');
  });

  it('rechaza eventos que no cuadran, importes faltantes o eventos sin reglas', async () => {
    await esperarError(
      db.transaction((tx) => contabilizar(tx, evento({ base: '100.00', iva: '16.00', total: '117.00' }))),
      'no cuadran',
    );
    await esperarError(
      db.transaction((tx) => contabilizar(tx, evento({ base: '100.00', total: '116.00' }))),
      'no trae el importe "iva"',
    );
    await esperarError(
      db.transaction((tx) => contabilizar(tx, { ...evento({ total: '1' }), evento: 'inexistente' })),
      'No hay reglas contables',
    );
  });

  it('no contabiliza sin tasa del día registrada', async () => {
    await esperarError(
      db.transaction((tx) => contabilizar(tx, { ...evento({ base: '1.00', iva: '0.16', total: '1.16' }), fecha: '2026-06-15' })),
      'Registre la tasa vigente',
    );
  });
});
