import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actualizarBanco, crearBanco } from '@/lib/maestros/bancos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError } from './apoyo';

describe('bancos (§5.4)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
  });
  afterAll(() => cerrar());

  it('la base nace sin bancos: ninguno se siembra', async () => {
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from banco');
    expect(rows[0].n).toBe(0);
  });

  it('crea un banco normalizando código, nombre y país', async () => {
    const id = await db.transaction((tx) => crearBanco(tx, ' 0134 ', { nombre: '  Banesco   Banco  Universal ', pais: 've' }));
    const { rows } = await db.query<{ codigo: string; nombre: string; pais: string; activo: boolean }>(
      'select codigo, nombre, pais, activo from banco where id = $1', [id]);
    expect(rows[0]).toEqual({ codigo: '0134', nombre: 'Banesco Banco Universal', pais: 'VE', activo: true });
  });

  it('no permite código ni nombre repetidos, sin importar mayúsculas', async () => {
    await db.transaction((tx) => crearBanco(tx, 'chase', { nombre: 'JPMorgan Chase', pais: 'US' }));
    await esperarError(db.transaction((tx) => crearBanco(tx, 'CHASE', { nombre: 'Otro nombre', pais: 'US' })), 'Ya existe el banco con código CHASE');
    await esperarError(db.transaction((tx) => crearBanco(tx, 'CHASE2', { nombre: 'jpmorgan  chase', pais: 'US' })), 'Ya existe un banco llamado');
  });

  it('rechaza código y país inválidos', async () => {
    await esperarError(db.transaction((tx) => crearBanco(tx, 'A', { nombre: 'Banco', pais: 'VE' })), 'código admite');
    await esperarError(db.transaction((tx) => crearBanco(tx, 'BAN-1', { nombre: 'Banco', pais: 'VE' })), 'código admite');
    await esperarError(db.transaction((tx) => crearBanco(tx, 'BANCO1', { nombre: 'Banco Uno', pais: 'VEN' })), 'código de 2 letras');
    await esperarError(db.transaction((tx) => crearBanco(tx, 'BANCO1', { nombre: ' ', pais: 'VE' })), 'Indique el nombre');
  });

  it('actualiza y inactiva, pero el código no cambia y el banco no se borra (R-R, R-S)', async () => {
    const id = await db.transaction((tx) => crearBanco(tx, '0108', { nombre: 'Provincial', pais: 'VE' }));
    await db.transaction((tx) => actualizarBanco(tx, id, { nombre: 'BBVA Provincial', pais: 'VE', activo: false }));
    const { rows } = await db.query<{ nombre: string; activo: boolean }>('select nombre, activo from banco where id = $1', [id]);
    expect(rows[0]).toEqual({ nombre: 'BBVA Provincial', activo: false });

    await esperarError(db.query(`update banco set codigo = '9999' where id = $1`, [id]), 'código del banco no se cambia');
    await esperarError(db.query('delete from banco where id = $1', [id]), 'no se borra');
    await esperarError(db.transaction((tx) => actualizarBanco(tx, id, { nombre: 'jpmorgan chase', pais: 'VE', activo: true })), 'Ya existe un banco llamado');
  });

  it('un banco inexistente no se actualiza', async () => {
    await esperarError(
      db.transaction((tx) => actualizarBanco(tx, '00000000-0000-0000-0000-000000000000', { nombre: 'Fantasma', pais: 'VE', activo: true })),
      'no existe');
  });

  it('la creación queda en la auditoría', async () => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from audit_log where entidad = 'banco' and accion = 'INSERT'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });
});
