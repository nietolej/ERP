import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenesVisibles, asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import {
  actualizarProducto, actualizarProductoBase, agregarAplicacion, agregarReferencia, buscarProductos, crearCatalogo,
  crearCategoria, crearProducto, fijarPrecio, resolverProductoBase, type DatosProducto,
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
  let marcaGenerica: string;

  /** Cada producto de prueba va en su propio código común, salvo que se indique otro. */
  let n = 0;
  const baseNueva = async () =>
    (await db.transaction((tx) => resolverProductoBase(tx, `BASE-${++n}`, { descripcion: `Artículo de prueba ${n}` }))).id;
  const datos = async (descripcion: string, extra: Partial<DatosProducto> = {}): Promise<DatosProducto> => ({
    descripcion, productoBaseId: await baseNueva(), marcaId: marcaGenerica, unidad: 'und', alicuotaIvaId: general,
    inventariable: true, ...extra,
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
    marcaGenerica = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
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
    const d1 = await datos('Pastillas de freno delanteras Tucson');
    const id = await db.transaction((tx) => crearProducto(tx, almacenista, ' 58101-2wa00 ', d1));
    const { rows } = await db.query<{ codigo: string; unidad: string }>('select codigo, unidad from producto where id = $1', [id]);
    expect(rows[0]).toEqual({ codigo: '58101-2WA00', unidad: 'UND' });
    const d2 = await datos('Otro');
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, '58101-2wa00', d2)), 'Ya existe');
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, '-MAL', d2)), 'empieza con letra');
    await esperarError(db.query(`update producto set codigo = 'OTRO' where id = $1`, [id]), 'no se cambia');
    await esperarError(db.transaction((tx) => actualizarProducto(tx, id, { ...d1, pesoKg: 'mucho' })), 'peso');
  });

  it('R-U/R-V: el empaque guarda unidades, peso y dimensiones, y la base calcula el volumen', async () => {
    const empaque = { empaqueUnidad: 'cja', unidadesPorEmpaque: '12', empaquePesoKg: '9.5', empaqueLargoCm: '40', empaqueAnchoCm: '30', empaqueAltoCm: '20' };
    const d1 = await datos('Bujía iridio', { pesoKg: '0.05', ...empaque });
    const id = await db.transaction((tx) => crearProducto(tx, almacenista, 'EMP-001', d1));
    const { rows } = await db.query<{ empaque_unidad: string; empaque_volumen_m3: string; volumen_unitario_m3: string }>(
      'select empaque_unidad, empaque_volumen_m3, volumen_unitario_m3 from producto where id = $1', [id]);
    expect(rows[0].empaque_unidad).toBe('CJA');
    expect(Number(rows[0].empaque_volumen_m3)).toBeCloseTo(0.024, 9);     // 40×30×20 cm
    expect(Number(rows[0].volumen_unitario_m3)).toBeCloseTo(0.002, 9);    // ÷ 12 unidades

    const d2 = await datos('Sin medidas');
    const sin = await db.transaction((tx) => crearProducto(tx, almacenista, 'EMP-002', d2));
    const r2 = await db.query<{ u: string; v: string | null }>('select unidades_por_empaque as u, volumen_unitario_m3 as v from producto where id = $1', [sin]);
    expect(Number(r2.rows[0].u)).toBe(1);
    expect(r2.rows[0].v).toBeNull();

    const base = await datos('Medidas incompletas', { ...empaque, empaqueAltoCm: '' });
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, 'EMP-003', base)), 'largo, ancho y alto');
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, 'EMP-003', { ...base, empaqueAltoCm: '0' })), 'mayores que cero');
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, 'EMP-003', { ...base, empaqueAltoCm: '5', unidadesPorEmpaque: '0' })), 'por empaque');
    await esperarError(db.query(`update producto set empaque_alto_cm = null where id = $1`, [id]), 'producto_empaque_dimensiones_completas');
  });

  it('catálogos, referencias cruzadas y búsqueda por referencia sin guiones o por descripción sin acentos', async () => {
    const grupo = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'tucson', 'Hyundai Tucson'));
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'mobis', 'Mobis'));
    await esperarError(db.transaction((tx) => crearCatalogo(tx, 'marca', 'MOBIS', 'Otra')), 'Ya existe la marca MOBIS');
    const df = await datos('Filtro de aceite Tucsón', { grupoId: grupo, marcaId: marca });
    const id = await db.transaction((tx) => crearProducto(tx, almacenista, 'FIL-001', df));
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

  it('R-R: el mismo artículo en tres marcas comparte un código común; una sola marca por código común', async () => {
    const [kia, mobis, sangsin] = await Promise.all(['KIA', 'MOBIS2', 'SANGSIN'].map((m) =>
      db.transaction((tx) => crearCatalogo(tx, 'marca', m, m))));
    const base = (await db.transaction((tx) => resolverProductoBase(tx, 'pf-tuc-del', { descripcion: 'Pastilla de freno delantera Tucson' }))).id;
    const comun = { descripcion: 'Pastilla de freno delantera Tucson', productoBaseId: base, unidad: 'JGO', alicuotaIvaId: general, inventariable: true };
    for (const [codigo, marcaId] of [['PF-KIA-1', kia], ['PF-MOB-1', mobis], ['PF-SAN-1', sangsin]]) {
      await db.transaction((tx) => crearProducto(tx, almacenista, codigo, { ...comun, marcaId }));
    }
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, 'PF-KIA-2', { ...comun, marcaId: kia })),
      'ya tiene un producto de esa marca: PF-KIA-1');
    await esperarError(db.transaction((tx) => crearProducto(tx, almacenista, 'PF-SIN', { ...comun, marcaId: null })), 'Seleccione la marca');

    // Se consultan juntos por el código común, o cada uno por su código.
    const porComun = await buscarProductos(db, { texto: 'PF-TUC-DEL' }, hoy);
    expect(porComun.map((p) => p.codigo).sort()).toEqual(['PF-KIA-1', 'PF-MOB-1', 'PF-SAN-1']);
    expect(porComun.every((p) => p.codigo_comun === 'PF-TUC-DEL')).toBe(true);
    expect((await buscarProductos(db, { texto: 'PF-MOB-1' }, hoy)).map((p) => p.codigo)).toEqual(['PF-MOB-1']);

    // Un código común inexistente exige su descripción; el código común no cambia.
    await esperarError(db.transaction((tx) => resolverProductoBase(tx, 'NO-EXISTE')), 'indique su descripción');
    await esperarError(db.query(`update producto_base set codigo = 'OTRO' where id = $1`, [base]), 'no se cambia');
  });

  it('R-S y R-T: categorías en árbol sin ciclos; el producto hereda la categoría de su código común', async () => {
    const frenos = await db.transaction((tx) => crearCategoria(tx, 'frenos', 'Frenos'));
    const pastillas = await db.transaction((tx) => crearCategoria(tx, 'frenos.past', 'Pastillas', frenos));
    await esperarError(db.query('update categoria_producto set padre_id = $1 where id = $2', [pastillas, frenos]), 'dentro de sí misma');
    const { rows: ruta } = await db.query<{ r: string }>('select fn_categoria_ruta($1) as r', [pastillas]);
    expect(ruta[0].r).toBe('Frenos › Pastillas');

    const { rows } = await db.query<{ id: string }>(`select id from producto_base where codigo = 'PF-TUC-DEL'`);
    await db.transaction((tx) => actualizarProductoBase(tx, rows[0].id, { descripcion: 'Pastilla de freno delantera Tucson', categoriaId: pastillas }));
    const { rows: cats } = await db.query<{ n: number }>(
      'select count(*)::int as n from producto where producto_base_id = $1 and categoria_id = $2', [rows[0].id, pastillas]);
    expect(cats[0].n).toBe(3);
    // Aunque se intente otra categoría directamente, se impone la del código común.
    await db.query(`update producto set categoria_id = $1 where codigo = 'PF-KIA-1'`, [frenos]);
    const { rows: k } = await db.query<{ c: string }>(`select categoria_id as c from producto where codigo = 'PF-KIA-1'`);
    expect(k[0].c).toBe(pastillas);
  });

  it('aplicación vehicular: un código común sirve para varios modelos y rangos de años', async () => {
    const { rows } = await db.query<{ id: string }>(`select id from producto_base where codigo = 'PF-TUC-DEL'`);
    const base = rows[0].id;
    const tucson = (await db.query<{ id: string }>(`select id from grupo_producto where codigo = 'TUCSON'`)).rows[0].id;
    const sportage = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'sportage', 'Kia Sportage'));
    await db.transaction((tx) => agregarAplicacion(tx, base, { grupoId: tucson, anioDesde: '2015', anioHasta: '2020' }));
    await db.transaction((tx) => agregarAplicacion(tx, base, { grupoId: sportage, anioDesde: '2016', anioHasta: '2021', motor: '2.0 gdi' }));
    await esperarError(db.transaction((tx) => agregarAplicacion(tx, base, { grupoId: tucson, anioDesde: '2015' })), 'ya está registrada');
    await esperarError(db.transaction((tx) => agregarAplicacion(tx, base, { grupoId: tucson, anioDesde: '2021', anioHasta: '2019' })), 'no puede ser menor');
    const { rows: apl } = await db.query<{ n: number }>('select count(*)::int as n from producto_base_aplicacion where producto_base_id = $1', [base]);
    expect(apl[0].n).toBe(2);
  });
});
