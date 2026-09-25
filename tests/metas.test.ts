import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import {
  aprobarLoteMetas, crearLoteMetas, leerFilasExcel, metaGlobal, parsearMonto, rechazarLoteMetas, type FilaMeta,
} from '@/lib/maestros/metas';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('metas: lectura de montos y de Excel (spec_reportes §10)', () => {
  it('interpreta montos escritos a la venezolana o a la americana', () => {
    expect(parsearMonto(15000)).toBe('15000.00');
    expect(parsearMonto('15000')).toBe('15000.00');
    expect(parsearMonto('15000.5')).toBe('15000.50');
    expect(parsearMonto('15.000')).toBe('15000.00');
    expect(parsearMonto('15.000,50')).toBe('15000.50');
    expect(parsearMonto('15,000.50')).toBe('15000.50');
    expect(parsearMonto('1.500.000')).toBe('1500000.00');
    expect(parsearMonto('$ 2500,75')).toBe('2500.75');
    expect(parsearMonto('0,5')).toBe('0.50');
    expect(parsearMonto('0')).toBe('0.00');
    expect(parsearMonto(15.5)).toBe('15.50');
    expect(parsearMonto(15.123)).toBeNull(); // una celda numérica no se lee como miles
  });

  it('rechaza lo que no es un monto válido', () => {
    for (const malo of ['', 'abc', '-100', '12.345.67', '1234.567', '10,5,5', '15.0000', '1e5', '0.500', null, undefined]) {
      expect(parsearMonto(malo as never), String(malo)).toBeNull();
    }
    expect(parsearMonto(-5)).toBeNull();
    expect(parsearMonto(Number.NaN)).toBeNull();
  });

  it('convierte las filas de la hoja: encabezados sin importar mayúsculas ni acentos, MES opcional', () => {
    const filas = leerFilasExcel([
      ['tipo', 'Código', 'AÑO', 'meta venta', 'Mes'],
      ['Vendedor', 'V001', 2026, 15000, 3],
      [null, null, null, null, null],
      ['GLOBAL', '', '2026', '100000', ''],
    ]);
    expect(filas).toEqual([
      { fila: 2, tipo: 'vendedor', referencia: 'V001', anio: 2026, mes: 3, monto: 15000 },
      { fila: 4, tipo: 'global', referencia: '', anio: 2026, mes: null, monto: '100000' },
    ]);
  });

  it('informa las columnas que faltan, el archivo vacío y los tipos inválidos con su fila', () => {
    expect(() => leerFilasExcel([])).toThrow('vacío');
    expect(() => leerFilasExcel([['TIPO', 'CODIGO']])).toThrow('Faltan las columnas: ANIO, META_VENTA');
    expect(() => leerFilasExcel([['TIPO', 'CODIGO', 'ANIO', 'META_VENTA'], ['SUCURSAL', 'X', 2026, 1]])).toThrow('Fila 2: el tipo "SUCURSAL"');
  });
});

describe('metas: lotes, versiones y aprobación (§5.4)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente: string;
  let otroGerente: string;
  let supervisor: string;
  let ventas: string;
  let vendedor: { id: string; codigo: string };
  let vendedor2: { id: string; codigo: string };
  let clienteId: string;
  let clienteCodigo: string;
  let grupoId: string;
  let productoCodigo: string;

  const fila = (n: number, tipo: FilaMeta['tipo'], referencia: string | undefined, anio: number, mes: number | null, monto: string | number): FilaMeta =>
    ({ fila: n, tipo, referencia, anio, mes, monto });
  const cargar = (usuario: string, filas: FilaMeta[], origen: 'excel' | 'manual' = 'manual') =>
    db.transaction((tx) => crearLoteMetas(tx, usuario, origen, filas));
  const aprobar = (lote: string, usuario: string) => db.transaction((tx) => aprobarLoteMetas(tx, lote, usuario));
  const vigente = async (tipo: string, entidad: string | null, anio: number, mes: number | null) =>
    (await db.query<{ monto_usd: string; version: number }>(
      `select monto_usd, version from vw_meta_periodo
        where tipo = $1 and entidad_id is not distinct from $2::uuid and anio = $3 and mes is not distinct from $4::int`,
      [tipo, entidad, anio, mes])).rows[0];

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    otroGerente = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    supervisor = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    ventas = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    vendedor = await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Pedro Pérez', tipo: 'interno' }));
    vendedor2 = await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Ana Gómez', tipo: 'interno' }));
    const facturacion = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const c = await db.transaction((tx) => crearCliente(tx, facturacion, {
      rif: 'J-12345678-4',
      tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: {},
    }));
    clienteId = c.id;
    clienteCodigo = c.codigo;
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    await db.transaction((tx) => aprobarCliente(tx, clienteId, gerente, { condicionPagoId: contado, limiteCreditoUsd: '1000', nivelPrecio: 'B', descuentoPct: '0' }));
    grupoId = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'FRENOS', 'Frenos'));
    const almacenista = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-1', { descripcion: 'Pastilla de freno' }));
    productoCodigo = 'PF-001';
    await db.transaction((tx) => crearProducto(tx, almacenista, productoCodigo, {
      descripcion: 'Pastilla de freno delantera', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
  });
  afterAll(() => cerrar());

  it('un lote nace pendiente y no cuenta hasta que Gerencia lo aprueba', async () => {
    const r = await cargar(supervisor, [fila(2, 'vendedor', vendedor.codigo, 2026, 3, '15.000')]);
    expect(r.filas).toBe(1);
    expect(await vigente('vendedor', vendedor.id, 2026, 3)).toBeUndefined();
    await aprobar(r.id, gerente);
    expect(await vigente('vendedor', vendedor.id, 2026, 3)).toEqual({ monto_usd: '15000.00', version: r.version });
  });

  it('quien carga no aprueba; solo Gerencia aprueba o rechaza (R-U)', async () => {
    const r = await cargar(gerente, [fila(2, 'vendedor', vendedor.codigo, 2026, 4, 1000)]);
    await esperarError(aprobar(r.id, gerente), 'Quien carga las metas no las aprueba');
    await esperarError(aprobar(r.id, supervisor), 'rol Gerencia');
    await esperarError(aprobar(r.id, ventas), 'rol Gerencia');
    await esperarError(db.transaction((tx) => rechazarLoteMetas(tx, r.id, supervisor, 'No corresponde')), 'rol Gerencia');
    await aprobar(r.id, otroGerente);
    await esperarError(aprobar(r.id, otroGerente), 'ya fue resuelto');
  });

  it('solo Gerencia y Supervisor de ventas cargan metas', async () => {
    await esperarError(cargar(ventas, [fila(2, 'vendedor', vendedor.codigo, 2026, 5, 1000)]), 'Solo Gerencia o Supervisor');
  });

  it('un lote nuevo aprobado reemplaza la meta vigente; las versiones anteriores se conservan', async () => {
    const primero = await vigente('vendedor', vendedor.id, 2026, 3);
    const r = await cargar(supervisor, [fila(2, 'vendedor', vendedor.codigo, 2026, 3, '18000.50')]);
    expect((await vigente('vendedor', vendedor.id, 2026, 3)).monto_usd).toBe('15000.00');
    await aprobar(r.id, gerente);
    expect(await vigente('vendedor', vendedor.id, 2026, 3)).toEqual({ monto_usd: '18000.50', version: r.version });
    expect(r.version).toBeGreaterThan(primero.version);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from meta_venta m join meta_lote l on l.id = m.lote_id
        where m.entidad_id = $1 and m.anio = 2026 and m.mes = 3 and l.estado = 'aprobado'`, [vendedor.id]);
    expect(rows[0].n).toBe(2);
  });

  it('un lote rechazado exige motivo y no cuenta', async () => {
    const r = await cargar(supervisor, [fila(2, 'vendedor', vendedor.codigo, 2026, 3, 99999)]);
    await esperarError(db.transaction((tx) => rechazarLoteMetas(tx, r.id, gerente, ' ')), 'motivo del rechazo');
    await db.transaction((tx) => rechazarLoteMetas(tx, r.id, gerente, 'Monto fuera de rango'));
    expect((await vigente('vendedor', vendedor.id, 2026, 3)).monto_usd).toBe('18000.50');
    await esperarError(aprobar(r.id, otroGerente), 'ya fue resuelto');
  });

  it('un lote resuelto y sus filas no se modifican ni se borran (R-V)', async () => {
    const { rows } = await db.query<{ id: string; lote_id: string }>(`select id, lote_id from meta_venta limit 1`);
    await esperarError(db.query(`update meta_venta set monto_usd = 1 where id = $1`, [rows[0].id]), 'no se modifican ni se borran');
    await esperarError(db.query(`delete from meta_venta where id = $1`, [rows[0].id]), 'no se modifican ni se borran');
    await esperarError(db.query(`delete from meta_lote where id = $1`, [rows[0].lote_id]), 'no se borra');
    await esperarError(db.query(`update meta_lote set estado = 'pendiente', resuelto_por = null, resuelto_at = null where id = $1`, [rows[0].lote_id]), 'ya resuelto');
    await esperarError(db.query(`insert into meta_venta (lote_id, tipo, entidad_id, anio, monto_usd) values ($1, 'global', null, 2030, 1)`, [rows[0].lote_id]), 'lote ya resuelto');
  });

  it('todo o nada: una fila con error impide guardar el lote y se informan las filas', async () => {
    const antes = (await db.query<{ n: number }>('select count(*)::int as n from meta_lote')).rows[0].n;
    let mensaje = '';
    try {
      await cargar(supervisor, [
        fila(2, 'vendedor', vendedor.codigo, 2026, 6, 500),
        fila(3, 'vendedor', 'V999', 2026, 6, 500),
        fila(4, 'cliente', 'J-99999999-9', 2026, null, 500),
        fila(5, 'vendedor', vendedor.codigo, 1999, 6, 500),
        fila(6, 'vendedor', vendedor.codigo, 2026, 13, 500),
        fila(7, 'vendedor', vendedor.codigo, 2026, 6, 'mucho'),
        fila(8, 'vendedor', vendedor.codigo, 2026, 6, 700),
        fila(9, 'grupo', undefined, 2026, null, 500),
      ], 'excel');
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain('No se guardó nada');
    expect(mensaje).toContain('Fila 3: no existe un vendedor activo con el código V999');
    expect(mensaje).toContain('Fila 4: no existe un cliente activo');
    expect(mensaje).toContain('Fila 5: el año');
    expect(mensaje).toContain('Fila 6: el mes');
    expect(mensaje).toContain('Fila 7: la meta debe ser un monto');
    expect(mensaje).toContain('Fila 8: repite la meta de la fila 2');
    expect(mensaje).toContain('Fila 9: falta el código');
    expect((await db.query<{ n: number }>('select count(*)::int as n from meta_lote')).rows[0].n).toBe(antes);
  });

  it('reconoce clientes por código del ERP o por RIF, productos y grupos por código, y la meta global sin código', async () => {
    const r = await cargar(supervisor, [
      fila(2, 'cliente', clienteCodigo.toLowerCase(), 2026, null, 8000),
      fila(3, 'cliente', 'j123456784', 2026, 1, 500),
      fila(4, 'producto', productoCodigo.toLowerCase(), 2026, null, 3000),
      fila(5, 'grupo', 'frenos', 2026, null, 20000),
      fila(6, 'global', undefined, 2026, null, 100000),
    ]);
    await aprobar(r.id, gerente);
    expect((await vigente('cliente', clienteId, 2026, null)).monto_usd).toBe('8000.00');
    expect((await vigente('cliente', clienteId, 2026, 1)).monto_usd).toBe('500.00');
    expect((await vigente('grupo', grupoId, 2026, null)).monto_usd).toBe('20000.00');
    expect((await vigente('global', null, 2026, null)).monto_usd).toBe('100000.00');
    const { rows } = await db.query<{ entidad: string }>(`select entidad from vw_meta_periodo where tipo = 'cliente' and mes is null`);
    expect(rows[0].entidad).toBe(`${clienteCodigo} · Repuestos Lara, C.A.`);
  });

  it('la base rechaza metas que apuntan a algo que no existe, globales con entidad y montos negativos (R-W)', async () => {
    const r = await cargar(supervisor, [fila(2, 'global', undefined, 2027, null, 1)]);
    const cero = '00000000-0000-0000-0000-000000000000';
    await esperarError(db.query(`insert into meta_venta (lote_id, tipo, entidad_id, anio, monto_usd) values ($1, 'vendedor', $2, 2027, 1)`, [r.id, cero]), 'no existe');
    await esperarError(db.query(`insert into meta_venta (lote_id, tipo, entidad_id, anio, monto_usd) values ($1, 'global', $2, 2027, 1)`, [r.id, vendedor.id]), 'check constraint');
    await esperarError(db.query(`insert into meta_venta (lote_id, tipo, entidad_id, anio, monto_usd) values ($1, 'vendedor', $2, 2027, -1)`, [r.id, vendedor.id]), 'check constraint');
    await esperarError(db.query(`insert into meta_venta (lote_id, tipo, entidad_id, anio, monto_usd) values ($1, 'sucursal', $2, 2027, 1)`, [r.id, vendedor.id]), 'check constraint');
  });

  it('un lote sin filas no se aprueba', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into meta_lote (origen, creado_por) values ('manual', $1) returning id`, [supervisor]);
    await esperarError(aprobar(rows[0].id, gerente), 'sin filas');
  });

  it('meta global: la fila GLOBAL, o la suma de las metas de los vendedores si no hay (vw_meta_anual, fn_meta_global)', async () => {
    expect(await metaGlobal(db, 2026)).toEqual({ origen: 'global', monto: '100000.00' });
    expect(await metaGlobal(db, 2030)).toBeNull();

    // 2028: sin GLOBAL. Pedro tiene meta anual; Ana tiene dos meses → cuenta la suma de sus meses.
    const r = await cargar(supervisor, [
      fila(2, 'vendedor', vendedor.codigo, 2028, null, 12000),
      fila(3, 'vendedor', vendedor2.codigo, 2028, 1, 1000),
      fila(4, 'vendedor', vendedor2.codigo, 2028, 2, 2500.5),
    ]);
    await aprobar(r.id, gerente);
    expect(await metaGlobal(db, 2028)).toEqual({ origen: 'suma_vendedores', monto: '15500.50' });

    const g = await cargar(supervisor, [fila(2, 'global', undefined, 2028, null, 20000)]);
    await aprobar(g.id, gerente);
    expect(await metaGlobal(db, 2028)).toEqual({ origen: 'global', monto: '20000.00' });
  });

  it('cada lote y cada fila quedan en la auditoría', async () => {
    const { rows } = await db.query<{ entidad: string; n: number }>(
      `select entidad, count(*)::int as n from audit_log where entidad in ('meta_lote', 'meta_venta') group by entidad`);
    const n = Object.fromEntries(rows.map((r) => [r.entidad, r.n]));
    expect(n.meta_lote).toBeGreaterThan(5);
    expect(n.meta_venta).toBeGreaterThan(5);
  });
});
