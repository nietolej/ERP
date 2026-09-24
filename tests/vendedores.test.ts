import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearCliente } from '@/lib/maestros/clientes';
import { digitoVerificador } from '@/lib/maestros/rif';
import { actualizarVendedor, cambiarEstadoVendedor, crearVendedor } from '@/lib/maestros/vendedores';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const rif = (letra: string, n: string) => `${letra}-${n}-${digitoVerificador(letra, n)}`;

describe('vendedores (§5.2)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente: string;
  let usuarioVentas: string;
  let usuarioContable: string;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    usuarioVentas = await usuarioDePrueba(db, 'ana@prueba.test', ['ventas']);
    usuarioContable = await usuarioDePrueba(db, 'conta@prueba.test', ['contabilidad']);
  });
  afterAll(() => cerrar());

  const crear = (d: Parameters<typeof crearVendedor>[2]) => db.transaction((tx) => crearVendedor(tx, gerente, d));

  it('el código lo asigna el numerador y no se cambia', async () => {
    const a = await crear({ nombre: 'Ana Rodríguez', tipo: 'interno', usuarioId: usuarioVentas });
    const b = await crear({ nombre: 'Mostrador Barquisimeto', tipo: 'casa' });
    expect([a.codigo, b.codigo]).toEqual(['V001', 'V002']);
    await esperarError(db.query(`insert into vendedor (codigo, nombre, tipo) values ('V999', 'X', 'interno')`), 'lo asigna el sistema');
    await esperarError(db.query(`update vendedor set codigo = 'V050' where id = $1`, [a.id]), 'no se cambia');
  });

  it('un vendedor externo necesita RIF y reutiliza el tercero si ya existe', async () => {
    await esperarError(crear({ nombre: 'Luis Comisionista', tipo: 'externo' }), 'necesita su RIF');
    await esperarError(crear({ nombre: 'Luis Comisionista', tipo: 'externo', rif: 'V-12345678-0' }), 'dígito verificador');

    const r = rif('V', '14567890');
    const cliente = await db.transaction((tx) => crearCliente(tx, gerente, {
      rif: r, tercero: { razonSocial: 'Luis Comisionista', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: {},
    }));
    const v = await crear({ nombre: 'Luis Comisionista', tipo: 'externo', rif: r });
    const { rows } = await db.query<{ tercero_id: string }>('select tercero_id from vendedor where id = $1', [v.id]);
    expect(rows[0].tercero_id).toBe(cliente.id);

    await esperarError(db.query(`update vendedor set tercero_id = null where id = $1`, [v.id]), 'check constraint');
  });

  it('el usuario enlazado debe tener rol de ventas y no estar enlazado a otro vendedor', async () => {
    await esperarError(crear({ nombre: 'Contador', tipo: 'interno', usuarioId: usuarioContable }), 'rol Ventas');
    await esperarError(crear({ nombre: 'Otra Ana', tipo: 'interno', usuarioId: usuarioVentas }), 'ya está enlazado al vendedor V001');
  });

  it('se actualiza sin cambiar el código y se inactiva en lugar de borrarse', async () => {
    const v = await crear({ nombre: 'Pedro', tipo: 'interno' });
    await db.transaction((tx) => actualizarVendedor(tx, gerente, v.id, { nombre: 'Pedro Pérez', tipo: 'administrativo' }));
    await db.transaction((tx) => cambiarEstadoVendedor(tx, v.id, 'inactivo'));
    const { rows } = await db.query<{ codigo: string; nombre: string; tipo: string; estado: string }>(
      'select codigo, nombre, tipo, estado from vendedor where id = $1', [v.id]);
    expect(rows[0]).toEqual({ codigo: v.codigo, nombre: 'Pedro Pérez', tipo: 'administrativo', estado: 'inactivo' });
  });

  it('un vendedor con clientes no se borra', async () => {
    const v = await crear({ nombre: 'Con cartera', tipo: 'interno' });
    await db.transaction((tx) => crearCliente(tx, gerente, {
      rif: rif('J', '31234567'), tercero: { razonSocial: 'Cliente de cartera', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: { vendedorId: v.id },
    }));
    await esperarError(db.query('delete from vendedor where id = $1', [v.id]), 'foreign key');
  });
});
