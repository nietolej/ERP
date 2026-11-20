import { afterAll, beforeAll, expect, it } from 'vitest';
import { hayAdministradorActivo } from '@/lib/auth/admin-inicial';
import { EMAIL_USUARIO_DEV, ROLES } from '@/lib/auth/constantes';
import { tieneRol } from '@/lib/auth/permisos';
import { urlPostgres } from '@/lib/db/configuracion';
import type { Db } from '@/lib/db/tipos';
import { ROLES_VEN_DISPONIBILIDAD } from '@/lib/inventario/disponibilidad';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { ROLES_VEN_CLIENTES } from '@/lib/maestros/roles';
import { MODULOS } from '@/lib/modulos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

let db: Db;
let cerrar: () => Promise<void>;
beforeAll(async () => { ({ db, cerrar } = await baseDePrueba()); });
afterAll(() => cerrar());

it('reanuda el alta tras migrar y distingue un administrador activo de una cuenta de desarrollo', async () => {
  expect(await hayAdministradorActivo(db)).toBe(false);
  await usuarioDePrueba(db, EMAIL_USUARIO_DEV, ['administrador']);
  await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
  expect(await hayAdministradorActivo(db)).toBe(false);
  const admin = await usuarioDePrueba(db, 'admin@prueba.test', ['administrador']);
  expect(await hayAdministradorActivo(db)).toBe(true);
  await db.query('update usuario set activo = false where id = $1', [admin]);
  expect(await hayAdministradorActivo(db)).toBe(false);
});

it('exige PostgreSQL en producción antes de seleccionar el motor', () => {
  for (const url of [undefined, '', 'https://servidor/base', 'postgres://', 'postgres://servidor:invalido/base']) {
    expect(() => urlPostgres(url, 'production')).toThrow('Configure DATABASE_URL');
  }
  expect(urlPostgres('postgresql://servidor/base', 'production')).toBe('postgresql://servidor/base');
  expect(urlPostgres(undefined, 'development')).toBeUndefined();
});

it.each(ROLES)('el menú BI ofrece al rol %s los mismos reportes que autorizan sus páginas', (rol) => {
  const items = MODULOS.find((modulo) => modulo.codigo === 'BI')!.items.filter((item) => item.href !== '/');
  expect(items).toHaveLength(7);
  for (const item of items) {
    const roles = item.href === '/reportes/inventario' ? ROLES_VEN_DISPONIBILIDAD
      : item.href === '/reportes/productos' ? ROLES_VEN_PRODUCTOS : ROLES_VEN_CLIENTES;
    expect(item.roles && tieneRol({ roles: [rol] }, item.roles), item.href).toBe(tieneRol({ roles: [rol] }, roles));
  }
});
