import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claveTemporal, hashClave, problemasDeClave, verificarClave } from '@/lib/auth/clave';
import { autenticar, crearSesion, eliminarSesion, usuarioDeSesion } from '@/lib/auth/sesiones';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba } from './apoyo';

describe('claves', () => {
  it('se guardan con scrypt y sal: la misma clave produce hashes distintos que verifican', async () => {
    const a = await hashClave('Hanei2026seguro');
    const b = await hashClave('Hanei2026seguro');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verificarClave('Hanei2026seguro', a)).toBe(true);
    expect(await verificarClave('otra-clave-123', a)).toBe(false);
  });

  it('exigen longitud, letras y números', () => {
    expect(problemasDeClave('corta1')).toContain('Debe tener al menos 10 caracteres.');
    expect(problemasDeClave('sololetrasaqui')).toContain('Debe incluir al menos un número.');
    expect(problemasDeClave('Buena-clave-2026')).toEqual([]);
    expect(problemasDeClave(claveTemporal())).toEqual([]);
  });
});

describe('autenticación y sesiones', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let id: string;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const { rows } = await db.query<{ id: string }>(
      `insert into usuario (email, nombre, password_hash) values ('ana@hanei.test', 'Ana', $1) returning id`,
      [await hashClave('Clave-correcta-1')],
    );
    id = rows[0].id;
    await db.query(`insert into usuario_rol (usuario_id, rol) values ($1, 'contabilidad'), ($1, 'auditor')`, [id]);
  });
  afterAll(() => cerrar());

  it('autentica con correo (sin importar mayúsculas) y clave, y trae los roles', async () => {
    const u = await autenticar(db, '  ANA@hanei.test ', 'Clave-correcta-1');
    expect(u).toMatchObject({ id, nombre: 'Ana', roles: ['auditor', 'contabilidad'], debeCambiarPassword: true });
  });

  it('rechaza clave equivocada, correo inexistente y usuario inactivo', async () => {
    expect(await autenticar(db, 'ana@hanei.test', 'Clave-incorrecta-1')).toBeNull();
    expect(await autenticar(db, 'nadie@hanei.test', 'Clave-correcta-1')).toBeNull();
    await db.query('update usuario set activo = false where id = $1', [id]);
    expect(await autenticar(db, 'ana@hanei.test', 'Clave-correcta-1')).toBeNull();
    await db.query('update usuario set activo = true where id = $1', [id]);
  });

  it('la sesión guarda solo el hash del token, vence y se puede cerrar', async () => {
    const { token } = await crearSesion(db, id);
    const { rows } = await db.query<{ token_hash: string }>('select token_hash from sesion where usuario_id = $1', [id]);
    expect(rows.map((r) => r.token_hash)).not.toContain(token);

    expect((await usuarioDeSesion(db, token))?.id).toBe(id);
    expect(await usuarioDeSesion(db, 'token-falso')).toBeNull();

    await db.query(`update sesion set expira_at = now() - interval '1 minute' where usuario_id = $1`, [id]);
    expect(await usuarioDeSesion(db, token)).toBeNull();

    const nueva = await crearSesion(db, id);
    await eliminarSesion(db, nueva.token);
    expect(await usuarioDeSesion(db, nueva.token)).toBeNull();
  });
});
