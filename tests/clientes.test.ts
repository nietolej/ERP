import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actualizarCredito, aprobarCliente, buscarClientes, cambiarEstadoCliente, crearCliente, puedeVerCliente,
  type DatosTercero,
} from '@/lib/maestros/clientes';
import { digitoVerificador, normalizarRif, problemaDeRif, rifValido, tipoPersona } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('RIF: formato y dígito verificador', () => {
  it('acepta RIF reales conocidos y calcula su dígito verificador', () => {
    expect(rifValido('G-20000303-0')).toBe(true); // SENIAT
    expect(rifValido('J-00002961-0')).toBe(true); // Banco de Venezuela
    // 3×4 + (1·3 + 2·2 + 3·7 + 4·6 + 5·5 + 6·4 + 7·3 + 8·2) = 150; 150 mod 11 = 7; 11 − 7 = 4
    expect(digitoVerificador('J', '12345678')).toBe(4);
    expect(rifValido('J-12345678-4')).toBe(true);
    expect(rifValido('J-12345678-9')).toBe(false);
  });

  it('normaliza lo que escribe el usuario', () => {
    expect(normalizarRif('j123456784')).toBe('J-12345678-4');
    expect(normalizarRif(' J-12345678-4 ')).toBe('J-12345678-4');
    expect(normalizarRif('v-1234567-8')).toBe('V-01234567-8');
    expect(normalizarRif('X-12345678-9')).toBeNull();
    expect(normalizarRif('J1234')).toBeNull();
    expect(problemaDeRif('J-12345678-9')).toContain('dígito verificador');
    expect(tipoPersona('J-12345678-4')).toBe('J');
    expect(tipoPersona('V-01234567-8')).toBe('N');
  });
});

describe('clientes (§5.1, §5.5)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let facturacion: string;
  let gerente: string;
  let vendedorUsuario: string;
  let otroVendedorUsuario: string;
  let vendedorId: string;
  let contado: string;

  const tercero = (razonSocial: string, extra: Partial<DatosTercero> = {}): DatosTercero => ({
    razonSocial, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, ...extra,
  });
  const credito = { limiteCreditoUsd: '1500.00', nivelPrecio: 'B' as const, descuentoPct: '0' };
  const crear = (rif: string, nombre: string, extra: { vendedorId?: string; confirmar?: boolean } = {}) =>
    db.transaction((tx) => crearCliente(tx, facturacion, {
      rif, tercero: tercero(nombre), comercial: { vendedorId: extra.vendedorId, zona: 'Centro' },
      confirmarNombreParecido: extra.confirmar,
    }));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    facturacion = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    vendedorUsuario = await usuarioDePrueba(db, 'vendedor@prueba.test', ['ventas']);
    otroVendedorUsuario = await usuarioDePrueba(db, 'vendedor2@prueba.test', ['ventas']);
    const { rows } = await db.query<{ id: string }>(
      `insert into vendedor (nombre, tipo, usuario_id) values ('Pedro Pérez', 'interno', $1) returning id`,
      [vendedorUsuario]);
    vendedorId = rows[0].id;
    contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
  });
  afterAll(() => cerrar());

  it('la base valida el RIF con el mismo algoritmo que la aplicación', async () => {
    for (let i = 0; i < 300; i++) {
      const letra = 'VEJPG'[i % 5];
      const numero = String((i * 7919 + 12345) % 100_000_000).padStart(8, '0');
      const rif = `${letra}-${numero}-${(i * 3) % 10}`;
      const { rows } = await db.query<{ v: boolean }>('select fn_rif_valido($1) as v', [rif]);
      expect(rows[0].v, rif).toBe(rifValido(rif));
    }
    await esperarError(
      db.query(`insert into tercero (rif, razon_social, tipo_persona) values ('J-12345678-9', 'X', 'J')`),
      'check constraint');
  });

  it('Facturación registra un cliente pendiente con código del numerador', async () => {
    const a = await crear('J-12345678-4', 'Repuestos Lara, C.A.');
    expect(a.codigo).toBe('C00001');
    expect(a.terceroExistente).toBe(false);
    const { rows } = await db.query<{ estado: string; rif: string; tipo_persona: string }>(
      `select c.estado, t.rif, t.tipo_persona from cliente c join tercero t on t.id = c.tercero_id where c.tercero_id = $1`, [a.id]);
    expect(rows[0]).toEqual({ estado: 'pendiente', rif: 'J-12345678-4', tipo_persona: 'J' });
  });

  it('rechaza RIF inválido, RIF que ya es cliente y códigos escritos a mano', async () => {
    await esperarError(crear('J-12345678-9', 'Otro'), 'dígito verificador');
    await esperarError(crear('J123456784', 'Repetido'), 'ya es el cliente C00001');
    const t = (await db.query<{ id: string }>(
      `insert into tercero (rif, razon_social, tipo_persona) values ($1, 'Manual', 'N') returning id`,
      [`V-00000001-${digitoVerificador('V', '00000001')}`])).rows[0].id;
    await esperarError(
      db.query(`insert into cliente (tercero_id, codigo) values ($1, 'C99999')`, [t]), 'lo asigna el sistema');
  });

  it('un RIF que ya existe como tercero (p. ej. proveedor) se reutiliza: un RIF es una sola persona', async () => {
    const rif = `J-40000000-${digitoVerificador('J', '40000000')}`;
    await db.query(`insert into tercero (rif, razon_social, tipo_persona) values ($1, 'Proveedor y cliente C.A.', 'J')`, [rif]);
    const c = await crear(rif, 'Nombre que se ignora');
    expect(c.terceroExistente).toBe(true);
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from tercero where rif = $1', [rif]);
    expect(rows[0].n).toBe(1);
  });

  it('avisa de un nombre parecido a otro tercero y exige confirmación', async () => {
    const rif = `J-50000000-${digitoVerificador('J', '50000000')}`;
    await esperarError(crear(rif, 'REPUESTOS LARA CA'), 'nombre igual o muy parecido');
    const c = await crear(rif, 'REPUESTOS LARA CA', { confirmar: true });
    expect(c.codigo).toMatch(/^C\d{5}$/);
  });

  it('solo Gerencia aprueba: el cliente pasa a activo con condición de pago', async () => {
    const rif = `J-60000000-${digitoVerificador('J', '60000000')}`;
    const c = await crear(rif, 'Cliente por aprobar');
    await esperarError(
      db.transaction((tx) => aprobarCliente(tx, c.id, facturacion, { ...credito, condicionPagoId: contado })),
      'rol Gerencia');
    await esperarError(
      db.query(`update cliente set estado = 'activo' where tercero_id = $1`, [c.id]), 'rol Gerencia');

    await db.transaction((tx) => aprobarCliente(tx, c.id, gerente, { ...credito, condicionPagoId: contado }));
    const { rows } = await db.query<{ estado: string; aprobado_por: string; limite_credito_usd: string; aprobado_at: Date | null }>(
      'select estado, aprobado_por, limite_credito_usd, aprobado_at from cliente where tercero_id = $1', [c.id]);
    expect(rows[0]).toMatchObject({ estado: 'activo', aprobado_por: gerente, limite_credito_usd: '1500.00' });
    expect(rows[0].aprobado_at).not.toBeNull();

    await esperarError(db.transaction((tx) => aprobarCliente(tx, c.id, gerente, { ...credito, condicionPagoId: contado })), 'ya fue aprobado');
    await esperarError(db.query(`update cliente set estado = 'pendiente' where tercero_id = $1`, [c.id]), 'no vuelve a pendiente');
    await esperarError(db.query('update cliente set aprobado_por = $2 where tercero_id = $1', [c.id, facturacion]), 'no se modifica');
  });

  it('valida las condiciones de crédito y permite cambiarlas y el estado después de aprobar', async () => {
    const rif = `J-70000000-${digitoVerificador('J', '70000000')}`;
    const c = await crear(rif, 'Cliente de crédito');
    await esperarError(
      db.transaction((tx) => aprobarCliente(tx, c.id, gerente, { ...credito, limiteCreditoUsd: '-5', condicionPagoId: contado })),
      'límite de crédito');
    await esperarError(
      db.transaction((tx) => aprobarCliente(tx, c.id, gerente, { ...credito, descuentoPct: '120', condicionPagoId: contado })),
      'porcentaje entre 0 y 100');
    await esperarError(db.transaction((tx) => cambiarEstadoCliente(tx, c.id, 'inactivo')), 'primero se aprueba');

    await db.transaction((tx) => aprobarCliente(tx, c.id, gerente, { ...credito, condicionPagoId: contado }));
    await db.transaction((tx) => actualizarCredito(tx, c.id, { ...credito, limiteCreditoUsd: '3000', nivelPrecio: 'A', condicionPagoId: contado }));
    await db.transaction((tx) => cambiarEstadoCliente(tx, c.id, 'bloqueado'));
    const { rows } = await db.query<{ estado: string; limite_credito_usd: string; nivel_precio: string }>(
      'select estado, limite_credito_usd, nivel_precio from cliente where tercero_id = $1', [c.id]);
    expect(rows[0]).toEqual({ estado: 'bloqueado', limite_credito_usd: '3000.00', nivel_precio: 'A' });
  });

  it('R-J: un tercero con cliente no se borra', async () => {
    const { rows } = await db.query<{ id: string }>(`select tercero_id as id from cliente where codigo = 'C00001'`);
    await esperarError(db.query('delete from tercero where id = $1', [rows[0].id]), 'foreign key');
  });

  it('seguridad por fila: el vendedor ve solo su cartera; Facturación ve todos', async () => {
    const rif = `J-80000000-${digitoVerificador('J', '80000000')}`;
    const propio = await crear(rif, 'Cliente de Pedro', { vendedorId });

    const deVendedor = await buscarClientes(db, { id: vendedorUsuario, roles: ['ventas'] }, {});
    expect(deVendedor.map((c) => c.id)).toEqual([propio.id]);
    expect(await buscarClientes(db, { id: otroVendedorUsuario, roles: ['ventas'] }, {})).toEqual([]);
    expect(await buscarClientes(db, { id: 'x', roles: ['administrador'] }, {})).toEqual([]);

    const todos = await buscarClientes(db, { id: facturacion, roles: ['facturacion'] }, {});
    expect(todos.length).toBeGreaterThan(1);

    const { rows } = await db.query<{ id: string }>(`select tercero_id as id from cliente where codigo = 'C00001'`);
    expect(await puedeVerCliente(db, { id: vendedorUsuario, roles: ['ventas'] }, propio.id)).toBe(true);
    expect(await puedeVerCliente(db, { id: vendedorUsuario, roles: ['ventas'] }, rows[0].id)).toBe(false);
  });

  it('busca por código, RIF sin guiones o nombre sin acentos ni signos', async () => {
    const u = { id: facturacion, roles: ['facturacion'] };
    expect((await buscarClientes(db, u, { texto: 'C00001' })).map((c) => c.codigo)).toContain('C00001');
    expect((await buscarClientes(db, u, { texto: '123456784' })).map((c) => c.codigo)).toContain('C00001');
    expect((await buscarClientes(db, u, { texto: 'repuestos lara' })).length).toBe(2);
    expect((await buscarClientes(db, u, { estado: 'bloqueado' })).every((c) => c.estado === 'bloqueado')).toBe(true);
  });

  it('la auditoría identifica al cliente por su tercero', async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_log where entidad = 'cliente' and entidad_id is null`);
    expect(rows[0].n).toBe(0);
  });
});
