import { afterEach, describe, expect, it } from 'vitest';
import { ROLES, sinLogin } from '@/lib/auth/constantes';
import { EMAIL_USUARIO_DEV, asegurarUsuarioDesarrollo } from '@/lib/auth/modo-desarrollo';
import { autenticar } from '@/lib/auth/sesiones';
import { baseDePrueba } from './apoyo';

describe('modo sin login (solo desarrollo)', () => {
  const entorno = { ...process.env };
  afterEach(() => {
    process.env.ERP_SIN_LOGIN = entorno.ERP_SIN_LOGIN;
    (process.env as Record<string, string | undefined>).NODE_ENV = entorno.NODE_ENV;
    if (entorno.ERP_SIN_LOGIN === undefined) delete process.env.ERP_SIN_LOGIN;
  });

  it('está apagado por defecto y solo se activa con ERP_SIN_LOGIN=1', () => {
    delete process.env.ERP_SIN_LOGIN;
    expect(sinLogin()).toBe(false);
    process.env.ERP_SIN_LOGIN = 'true';
    expect(sinLogin()).toBe(false);
    process.env.ERP_SIN_LOGIN = '1';
    expect(sinLogin()).toBe(true);
  });

  it('nunca se activa en producción, aunque la variable esté puesta', () => {
    process.env.ERP_SIN_LOGIN = '1';
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(sinLogin()).toBe(false);
  });

  it('el usuario de desarrollo se crea una vez con todos los roles y no sirve para entrar por /login', async () => {
    const { db, cerrar } = await baseDePrueba();
    try {
      const u = await asegurarUsuarioDesarrollo(db);
      const otra = await asegurarUsuarioDesarrollo(db);
      expect(otra.id).toBe(u.id);
      expect(u.email).toBe(EMAIL_USUARIO_DEV);
      expect([...u.roles].sort()).toEqual([...ROLES].sort());
      expect(u.debeCambiarPassword).toBe(false);
      expect(await autenticar(db, EMAIL_USUARIO_DEV, 'cualquier-clave')).toBeNull();
      expect((await db.query('select 1 from usuario where email = $1', [EMAIL_USUARIO_DEV])).rows).toHaveLength(1);
    } finally {
      await cerrar();
    }
  });
});
