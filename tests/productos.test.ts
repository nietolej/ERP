import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenesVisibles, asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import {
  actualizarProducto, agregarReferencia, buscarProductos, crearCatalogo, crearProducto, fijarPrecio, type DatosProducto,
} from '@/lib/maestros/productos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('productos, precios y almacenes (§5.3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacenista: string;
  let general: string;
  let hoy: string;
  let manana: string;
  let sucursal: string;

  const datos = (descripcion: string, extra: Partial<DatosProducto> = {}): DatosProducto => ({
    descripcion, unidad: 'und', alicuotaIvaId: general, inventariable: true, ...extra,
  });
  const alicuota = async (codigo: string) =>
    (await db.query<{ id: string }>('select id from alicuota_iva where codigo = $1', [codigo])).rows[0].id;
  const pct = async (codigo: string, fecha: string) =>
    (await db.query<{ p: string }>('select fn_alicuota_iva_pct($1, $2::date) as p', [await alicuota(codigo), fecha])).rows[0].p;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    almacenista = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    general = await alicuota('GENERAL');
    const { rows } = await db.query<{ hoy: string; manana: string }>(
      `select (now() at time zone 'America/Caracas')::date::text as hoy,
              ((now() at time zone 'America/Caracas')::date + 1)::text as manana`);
    ({ hoy, manana } = rows[0]);
    sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
  });
  afterAll(() => cerrar());

  it('R-O: el porcentaje de cada alícuota sale de los parámetros fiscales vigentes en la fecha', async () => {
    expect(Number(await pct('GENERAL', '2026-06-01'))).toBe(16);
    expect(Number(await pct('LUJO', '2026-06-01'))).toBe(31);
    expect(Number(await pct('EXENTO', '2026-06-01'))).toBe(0);

    // Un cambio de alícuota es una nueva vigencia del parámetro: el producto no se toca.
    await db.query(`update parametro_fiscal set vigente_hasta = '2026-12-31' where codigo = 'IVA_GENERAL'`);
    await db.query(`insert into parametro_fiscal (codigo, descripcion, valor, unidad, vigente_desde)
                    values ('IVA_GENERAL', 'IVA general 2027', 15, 'porcentaje', '2027-01-01')`);
    expect(Number(await pct('GENERAL', '2026-12-31'))).toBe(16);
    expect(Number(await pct('GENERAL', '2027-01-01'))).toBe(15);

    await esperarError(db.query(`insert into alicuota_iva (codigo, nombre, parametros, tipo_libro)
                                 values ('X', 'X', array['NO_EXISTE'], 'gravada')`), 'no existe');
  });

  it('el código se normaliza a mayúsculas, es único sin importar mayúsculas y no cambia', async () => {
    const id = await db.transaction((tx) => crearProducto(tx, almacenista, ' 58101-2wa00 ', datos('Pastillas de freno delanteras Tucson')));
    const { rows } = await db.query<{ codigo: string; unidad: string }>('select codigo, unidad from producto where id = $1', [id]);
    expect(rows[0]).toEqual({ codigo: '58101-2WA00', unidad: 'UND' });
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, '58101-2wa00', datos('Otro'))), 'Ya existe');
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, '-MAL', datos('Código inválido'))), 'empieza con letra');
    await esperarError(db.query(`update producto set codigo = 'OTRO' where id = $1`, [id]), 'no se cambia');
    await esperarError(db.transaction((tx) => actualizarProducto(tx, id, datos('Pastillas', { pesoKg: 'mucho' }))), 'peso');
  });

  it('catálogos, referencias cruzadas y búsqueda por referencia sin guiones o por descripción sin acentos', async () => {
    const grupo = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'tucson', 'Hyundai Tucson'));
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'mobis', 'Mobis'));
    await esperarError(db.transaction((tx) => crearCatalogo(tx, 'marca', 'MOBIS', 'Otra')), 'Ya existe la marca MOBIS');
    const id = await db.transaction((tx) => crearProducto(tx, almacenista, 'FIL-001', datos('Filtro de aceite Tucsón', { grupoId: grupo, marcaId: marca })));
    await db.transaction((tx) => agregarReferencia(tx, id, { tipo: 'oem', fabricante: 'hyundai', referencia: '26300-35505' }));
    await esperarError(db.transaction((tx) => agregarReferencia(tx, id, { tipo: 'oem', fabricante: 'HYUNDAI', referencia: '26300-35505' })), 'ya está registrada');

    expect((await buscarProductos(db, { texto: '2630035505' }, hoy)).map((p) => p.codigo)).toEqual(['FIL-001']);
    expect((await buscarProductos(db, { texto: 'filtro de aceite tucson' }, hoy)).map((p) => p.codigo)).toEqual(['FIL-001']);
    expect((await buscarProductos(db, { texto: 'fil-001' }, hoy))[0]).toMatchObject({ grupo: 'TUCSON', marca: 'MOBIS' });
  });

  it('R-P: los precios tienen vigencia, no se editan, no se borran ni empiezan antes de hoy', async () => {
    const { rows } = await db.query<{ id: string }>(`select id from producto where codigo = 'FIL-001'`);
    const id = rows[0].id;
    await db.transaction((tx) => fijarPrecio(tx, id, 'A', '12.50', hoy));
    await db.transaction((tx) => fijarPrecio(tx, id, 'A', '13.00', manana));
    await esperarError(db.transaction((tx) => fijarPrecio(tx, id, 'A', '14', hoy)), 'Ya hay un precio');
    await esperarError(db.transaction((tx) => fijarPrecio(tx, id, 'B', '-1', hoy)), 'monto en USD');
    await esperarError(db.transaction((tx) => fijarPrecio(tx, id, 'B', '10', '2020-01-01')), 'antes de hoy');
    await esperarError(db.query(`update precio set precio = 1 where producto_id = $1`, [id]), 'no se modifica');
    await esperarError(db.query('delete from precio where producto_id = $1', [id]), 'no se modifica');

    const precio = async (fecha: string) =>
      (await db.query<{ p: string | null }>(`select fn_precio($1, 'A', $2::date) as p`, [id, fecha])).rows[0].p;
    expect(await precio(hoy)).toBe('12.50');
    expect(await precio(manana)).toBe('13.00');
    expect((await buscarProductos(db, { texto: 'FIL-001' }, hoy))[0]).toMatchObject({ precio_a: '12.50', precio_b: null });

    // Un producto con precios (y luego con movimientos) no se borra: se inactiva.
    await esperarError(db.query('delete from producto where id = $1', [id]), 'foreign key');
  });

  it('almacenes: solo uno comercial vende; el usuario de Almacén ve solo los asignados', async () => {
    await esperarError(db.transaction((tx) => crearAlmacen(tx, 'trans', { nombre: 'Tránsito', sucursalId: sucursal, esComercial: false, permiteVenta: true })),
      'Solo un almacén comercial');
    const a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    const trans = await db.transaction((tx) => crearAlmacen(tx, 'trans', { nombre: 'Tránsito', sucursalId: sucursal, esComercial: false, permiteVenta: false }));
    await esperarError(db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Duplicado', sucursalId: sucursal, esComercial: true, permiteVenta: true })), 'Ya existe');
    await esperarError(db.query(`update almacen set es_comercial = false where id = $1`, [a01]), 'check constraint');

    await db.transaction((tx) => asignarUsuarios(tx, a01, [almacenista]));
    expect(await almacenesVisibles(db, { id: almacenista, roles: ['almacen'] })).toEqual([a01]);
    expect((await almacenesVisibles(db, { id: almacenista, roles: ['almacen', 'gerencia'] })).sort()).toEqual([a01, trans].sort());
  });
});
