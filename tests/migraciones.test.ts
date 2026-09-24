import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrar } from '@/lib/db/migrar';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba } from './apoyo';

describe('migraciones', () => {
  let db: Db;
  let cerrar: () => Promise<void>;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
  });
  afterAll(() => cerrar());

  it('crean la base desde cero y registran cada versión', async () => {
    const { rows } = await db.query<{ version: string }>('select version from schema_migrations order by version');
    expect(rows.map((r) => r.version)).toEqual([
      '0001_seguridad.sql',
      '0002_configuracion.sql',
      '0003_contabilidad.sql',
      '0004_semillas.sql',
      '0005_limite_acceso.sql',
      '0006_asiento_manual.sql',
      '0007_terceros_clientes.sql',
    ]);
  });

  it('son idempotentes: volver a migrar no aplica nada', async () => {
    expect(await migrar(db)).toEqual([]);
  });

  it('el mismo archivo con finales de línea CRLF no se toma como una migración editada', async () => {
    const { mkdtemp, readdir, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { DIR_MIGRACIONES } = await import('@/lib/db/migrar');
    const dir = await mkdtemp(path.join(tmpdir(), 'migraciones-crlf-'));
    for (const f of await readdir(DIR_MIGRACIONES)) {
      const sql = await readFile(path.join(DIR_MIGRACIONES, f), 'utf8');
      await writeFile(path.join(dir, f), sql.replace(/\r?\n/g, '\r\n'));
    }
    expect(await migrar(db, dir)).toEqual([]);
  });

  it('cargan el plan de cuentas con su jerarquía', async () => {
    const { rows } = await db.query<{ codigo: string; padre: string | null }>(
      `select c.codigo, p.codigo as padre
         from cuenta_contable c left join cuenta_contable p on p.id = c.padre_id
        where c.codigo in ('1', '1.1.01.02', '3.3.02', '6.3.03')
        order by c.codigo`,
    );
    expect(rows).toEqual([
      { codigo: '1', padre: null },
      { codigo: '1.1.01.02', padre: '1.1.01' },
      { codigo: '3.3.02', padre: '3' },
      { codigo: '6.3.03', padre: '6.3' },
    ]);
  });

  it('dejan los parámetros fiscales pendientes de validación por el contador', async () => {
    const { rows } = await db.query<{ n: string }>(
      'select count(*) as n from parametro_fiscal where validado_por_contador',
    );
    expect(rows[0].n).toBe('0');
  });

  it('no traen datos de operación: la base de producción nace vacía (§14)', async () => {
    for (const tabla of ['usuario', 'asiento', 'tasa_cambio', 'periodo_contable', 'empresa']) {
      const { rows } = await db.query<{ n: string }>(`select count(*) as n from ${tabla}`);
      expect(rows[0].n, tabla).toBe('0');
    }
  });
});
