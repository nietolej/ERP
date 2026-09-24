import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashClave } from '@/lib/auth/clave';
import { MAX_FALLOS_CORREO, MAX_FALLOS_IP, VENTANA_MINUTOS } from '@/lib/auth/limite';
import { autenticarConLimite } from '@/lib/auth/sesiones';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba } from './apoyo';

describe('límite de intentos de inicio de sesión', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let id: string;
  const CORRECTA = 'Clave-correcta-1';

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const { rows } = await db.query<{ id: string }>(
      `insert into usuario (email, nombre, password_hash) values ('luis@hanei.test', 'Luis', $1) returning id`,
      [await hashClave(CORRECTA)],
    );
    id = rows[0].id;
  });
  beforeEach(() => db.query('delete from intento_fallido'));
  afterAll(() => cerrar());

  const fallar = async (email: string, veces: number, ip: string | null = null) => {
    for (let i = 0; i < veces; i++) {
      expect((await autenticarConLimite(db, email, 'Clave-mala-99', ip)).estado).toBe('rechazado');
    }
  };

  it(`bloquea el correo al llegar a ${MAX_FALLOS_CORREO} fallos, incluso con la clave correcta`, async () => {
    await fallar('luis@hanei.test', MAX_FALLOS_CORREO);
    expect((await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, null)).estado).toBe('bloqueado');
    // Sin importar mayúsculas ni espacios
    expect((await autenticarConLimite(db, ' LUIS@hanei.test', CORRECTA, null)).estado).toBe('bloqueado');
  });

  it('el bloqueo se levanta cuando los fallos salen de la ventana', async () => {
    await fallar('luis@hanei.test', MAX_FALLOS_CORREO);
    await db.query(`update intento_fallido set created_at = now() - make_interval(mins => $1 + 1)`, [VENTANA_MINUTOS]);
    const r = await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, null);
    expect(r).toMatchObject({ estado: 'ok', usuario: { id } });
  });

  it('un acceso correcto pone el contador del correo en cero', async () => {
    await fallar('luis@hanei.test', MAX_FALLOS_CORREO - 1);
    expect((await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, null)).estado).toBe('ok');
    await fallar('luis@hanei.test', MAX_FALLOS_CORREO - 1);
    expect((await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, null)).estado).toBe('ok');
  });

  it('bloquea igual un correo inexistente, para no revelar qué correos están registrados', async () => {
    await fallar('nadie@hanei.test', MAX_FALLOS_CORREO);
    expect((await autenticarConLimite(db, 'nadie@hanei.test', 'x', null)).estado).toBe('bloqueado');
    // El bloqueo de un correo no afecta a otro
    expect((await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, null)).estado).toBe('ok');
  });

  it(`bloquea una IP que acumula ${MAX_FALLOS_IP} fallos con correos distintos`, async () => {
    for (let i = 0; i < MAX_FALLOS_IP; i++) await fallar(`prueba${i}@hanei.test`, 1, '10.0.0.7');
    expect((await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, '10.0.0.7')).estado).toBe('bloqueado');
    expect((await autenticarConLimite(db, 'luis@hanei.test', CORRECTA, '10.0.0.8')).estado).toBe('ok');
  });

  it('no guarda correos ni IP en claro y deja el bloqueo en la auditoría', async () => {
    await fallar('luis@hanei.test', MAX_FALLOS_CORREO, '10.0.0.9');
    const { rows } = await db.query<{ clave: string }>('select clave from intento_fallido');
    for (const r of rows) {
      expect(r.clave).toMatch(/^[0-9a-f]{64}$/);
    }
    const aud = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_log where accion = 'BLOQUEO_ACCESO' and entidad_id = $1`,
      [id],
    );
    expect(aud.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
