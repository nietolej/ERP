import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ESTADOS_SALUD, consultarDisponibilidad, resumenSalud, validarPeriodo, type FilaDisponibilidad,
} from '@/lib/inventario/disponibilidad';
import { crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const DESDE = '2026-01-01';
const HASTA = '2026-01-31';

describe('disponibilidad y velocidad de venta (R-BO, spec_reportes §9.1)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let usuario: string;
  let a01: string;
  let a02: string;
  let deposito: string;
  const prod: Record<string, string> = {};

  const como = <T,>(fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  /** Existencia al cierre de un día pasado: solo el sistema escribe esta tabla, así que la prueba abre la puerta interna. */
  const foto = (p: string, almacen: string, fecha: string, cantidad: number) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.inventario_interno', '1', true)");
    await tx.query('insert into existencia_diaria (fecha, producto_id, almacen_id, cantidad, reservado) values ($1, $2, $3, $4, 0)', [fecha, p, almacen, cantidad]);
  });
  const entrada = (p: string, cantidad: number) => como((tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('entrada_compra', $1, $2, $3, 1, 'prueba', gen_random_uuid())`, [p, a01, cantidad]));
  /** Movimiento de venta con fecha pasada (la salida descuenta lo que la entrada dejó). */
  const venta = (tipo: 'salida_venta' | 'devolucion_cliente', p: string, almacen: string, fecha: string, cantidad: number) => como((tx) => tx.query(
    `insert into movimiento_inventario (fecha, tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ($1::timestamptz, $2, $3, $4, $5, 0, 'prueba', gen_random_uuid())`,
    [`${fecha} 12:00-04`, tipo, p, almacen, tipo === 'salida_venta' ? -cantidad : cantidad]));
  const parametro = (codigo: string, valor: number | null) => valor === null
    ? db.query('delete from parametro_inventario where codigo = $1', [codigo])
    : db.query('update parametro_inventario set valor = $2 where codigo = $1', [codigo, valor]);
  const num = (v: string | null) => (v === null ? null : Number(v));
  const fila = (filas: FilaDisponibilidad[], codigo: string) => filas.find((f) => f.codigo === codigo)!;
  const resumen = (f: FilaDisponibilidad) => ({
    periodo: f.dias_periodo, con: f.dias_con_existencia, sin: f.dias_sin_existencia, pct: num(f.pct_disponibilidad),
    unidades: num(f.unidades_vendidas), basica: num(f.velocidad_basica), ajustada: num(f.velocidad_ajustada),
    stock: num(f.stock_comercial), cobertura: num(f.cobertura_dias), perdidaU: num(f.venta_perdida_unidades), estado: f.estado_salud,
  });

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    usuario = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    a02 = await db.transaction((tx) => crearAlmacen(tx, '02', { nombre: 'Caracas', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    deposito = await db.transaction((tx) => crearAlmacen(tx, 'DEP', { nombre: 'Depósito', sucursalId: sucursal, esComercial: false, permiteVenta: false }));
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    for (const n of [1, 2, 3, 5, 6, 7, 8]) {
      const codigo = `PD-00${n}`;
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      prod[codigo] = await db.transaction((tx) => crearProducto(tx, usuario, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
      }));
    }
    // Con qué salir: las salidas de venta descuentan existencia real (la entrada es de hoy, fuera de los periodos de enero).
    for (const c of Object.keys(prod)) await entrada(prod[c], 1000);

    // PD-001: se agota el 10 y repone el 20; el depósito no vende y no cuenta. Vende 14 y le devuelven 2.
    await foto(prod['PD-001'], a01, '2026-01-01', 10);
    await foto(prod['PD-001'], a01, '2026-01-10', 0);
    await foto(prod['PD-001'], a01, '2026-01-20', 5);
    await foto(prod['PD-001'], deposito, '2026-01-05', 50);
    await venta('salida_venta', prod['PD-001'], a01, '2026-01-05', 10);
    await venta('salida_venta', prod['PD-001'], a01, '2026-01-08', 4);
    await venta('devolucion_cliente', prod['PD-001'], a01, '2026-01-06', 2);
    // PD-002: primer registro el 11; vende 2.
    await foto(prod['PD-002'], a01, '2026-01-11', 8);
    await venta('salida_venta', prod['PD-002'], a01, '2026-01-15', 2);
    // PD-003: dos almacenes que venden, uno después del otro; vende 4.
    await foto(prod['PD-003'], a01, '2026-01-01', 1);
    await foto(prod['PD-003'], a01, '2026-01-05', 0);
    await foto(prod['PD-003'], a02, '2026-01-08', 4);
    await foto(prod['PD-003'], a02, '2026-01-12', 0);
    await venta('salida_venta', prod['PD-003'], a01, '2026-01-02', 2);
    await venta('salida_venta', prod['PD-003'], a01, '2026-01-09', 2);
    // PD-005: casi todo el mes sin existencia y repone el 28; vende 3.
    await foto(prod['PD-005'], a01, '2026-01-01', 5);
    await foto(prod['PD-005'], a01, '2026-01-02', 0);
    await foto(prod['PD-005'], a01, '2026-01-28', 20);
    await venta('salida_venta', prod['PD-005'], a01, '2026-01-01', 3);
    // PD-006: mucha existencia y poca salida relativa; PD-007: existencia sin ventas; PD-008: nunca tuvo existencia.
    await foto(prod['PD-006'], a01, '2026-01-01', 500);
    await venta('salida_venta', prod['PD-006'], a01, '2026-01-15', 31);
    await foto(prod['PD-007'], a01, '2026-01-01', 10);
    await foto(prod['PD-008'], a01, '2026-01-01', 0);
  });
  afterAll(() => cerrar());

  it('calcula días disponibles, días sin existencia, velocidades, cobertura y estado de salud de cada producto', async () => {
    const { filas, desde, hasta } = await consultarDisponibilidad(db, { desde: DESDE, hasta: HASTA, limite: 500 });
    expect([desde, hasta]).toEqual([DESDE, HASTA]);
    expect(filas.map((f) => f.codigo).sort()).toEqual(['PD-001', 'PD-002', 'PD-003', 'PD-005', 'PD-006', 'PD-007', 'PD-008']);

    // 21 días con existencia (1 al 9 y 20 al 31); el depósito no cuenta. 12 vendidas netas.
    expect(resumen(fila(filas, 'PD-001'))).toEqual({
      periodo: 31, con: 21, sin: 10, pct: 67.74, unidades: 12, basica: 0.3871, ajustada: 0.5714, stock: 5, cobertura: 8.8, perdidaU: 5.71, estado: 'RIESGO_QUIEBRE',
    });
    // Antes del primer registro (11 de enero) no hay dato: el periodo cuenta desde ahí.
    expect(resumen(fila(filas, 'PD-002'))).toEqual({
      periodo: 21, con: 21, sin: 0, pct: 100, unidades: 2, basica: 0.0952, ajustada: 0.0952, stock: 8, cobertura: 84, perdidaU: 0, estado: 'SALUDABLE',
    });
    // Con dos almacenes, el día cuenta si hay existencia en alguno: 1 al 4 (A01) y 8 al 11 (A02).
    expect(resumen(fila(filas, 'PD-003'))).toEqual({
      periodo: 31, con: 8, sin: 23, pct: 25.81, unidades: 4, basica: 0.129, ajustada: 0.5, stock: 0, cobertura: 0, perdidaU: 11.5, estado: 'RIESGO_QUIEBRE',
    });
    expect(resumen(fila(filas, 'PD-005'))).toEqual({
      periodo: 31, con: 5, sin: 26, pct: 16.13, unidades: 3, basica: 0.0968, ajustada: 0.6, stock: 20, cobertura: 33.3, perdidaU: 15.6, estado: 'DEMANDA_REPRIMIDA',
    });
    expect(resumen(fila(filas, 'PD-006'))).toMatchObject({ con: 31, sin: 0, unidades: 31, ajustada: 1, stock: 500, cobertura: 500, estado: 'SOBRESTOCK' });
    expect(resumen(fila(filas, 'PD-007'))).toMatchObject({ con: 31, unidades: 0, ajustada: 0, stock: 10, cobertura: null, estado: 'SIN_ROTACION' });
    // Sin un solo día con existencia no hay velocidad ajustada: no se inventa una cifra.
    expect(resumen(fila(filas, 'PD-008'))).toEqual({
      periodo: 31, con: 0, sin: 31, pct: 0, unidades: 0, basica: 0, ajustada: null, stock: 0, cobertura: null, perdidaU: null, estado: 'RIESGO_QUIEBRE',
    });
  });

  it('coincide, producto por producto y en distintos periodos, con fn_dias_con_existencia (la cuenta día por día)', async () => {
    for (const [desde, hasta] of [['2026-01-01', '2026-01-31'], ['2026-01-15', '2026-01-31'], ['2026-01-06', '2026-01-24'], ['2026-01-10', '2026-01-10']]) {
      const { filas } = await consultarDisponibilidad(db, { desde, hasta, limite: 500 });
      expect(filas.length).toBeGreaterThan(0);
      for (const f of filas) {
        const { rows } = await db.query<{ n: number }>('select fn_dias_con_existencia($1, $2::date, $3::date) as n', [f.producto_id, desde, hasta]);
        expect(f.dias_con_existencia, `${f.codigo} ${desde}..${hasta}`).toBe(rows[0].n);
        expect(f.dias_con_existencia + f.dias_sin_existencia).toBe(f.dias_periodo);
      }
    }
  });

  it('un periodo parcial arrastra la existencia de antes y solo cuenta las ventas de sus días', async () => {
    const { filas } = await consultarDisponibilidad(db, { desde: '2026-01-15', hasta: HASTA, limite: 500 });
    // El 15 aún no había repuesto: 20 al 31 son 12 días con existencia de 17.
    expect(resumen(fila(filas, 'PD-001'))).toMatchObject({ periodo: 17, con: 12, sin: 5, unidades: 0, stock: 5, estado: 'SIN_ROTACION' });
    expect(resumen(fila(filas, 'PD-002'))).toMatchObject({ periodo: 17, con: 17, unidades: 2 });       // la venta del 15 entra
    // Un periodo anterior a todo registro no tiene productos.
    expect((await consultarDisponibilidad(db, { desde: '2025-12-01', hasta: '2025-12-31' })).filas).toEqual([]);
  });

  it('los umbrales son parámetros: cambiarlos cambia el estado; sin parámetro no se calcula', async () => {
    await parametro('COBERTURA_RIESGO_DIAS', 5);
    const bajo = (await consultarDisponibilidad(db, { desde: DESDE, hasta: HASTA, limite: 500 })).filas;
    expect(fila(bajo, 'PD-001').estado_salud).toBe('SALUDABLE');                       // 8,8 días ya no es riesgo con umbral de 5
    await parametro('COBERTURA_RIESGO_DIAS', 15);
    await parametro('COBERTURA_SOBRESTOCK_DIAS', 1000);
    expect(fila((await consultarDisponibilidad(db, { desde: DESDE, hasta: HASTA, limite: 500 })).filas, 'PD-006').estado_salud).toBe('SALUDABLE');
    await parametro('COBERTURA_SOBRESTOCK_DIAS', 180);
    await parametro('VELOCIDAD_REPRIMIDA', 1);
    expect(fila((await consultarDisponibilidad(db, { desde: DESDE, hasta: HASTA, limite: 500 })).filas, 'PD-005').estado_salud).toBe('SALUDABLE');
    await parametro('VELOCIDAD_REPRIMIDA', 0.1);

    await parametro('COBERTURA_RIESGO_DIAS', null);
    await esperarError(consultarDisponibilidad(db, { desde: DESDE, hasta: HASTA }), 'Falta configurar el parámetro de inventario COBERTURA_RIESGO_DIAS');
    await db.query(`insert into parametro_inventario (codigo, descripcion, valor, unidad) values ('COBERTURA_RIESGO_DIAS', 'Riesgo de quiebre', 15, 'dias')`);
  });

  it('la venta perdida estimada vale los días sin existencia × velocidad ajustada × precio de la lista A vigente al cierre', async () => {
    // Los precios no se escriben en el pasado: la prueba suspende esa regla solo para fijar uno anterior al periodo.
    await db.exec('alter table precio disable trigger precio_inmutable');
    await db.query(`insert into precio (producto_id, lista, precio, vigente_desde) values ($1, 'A', 20, '2025-12-01')`, [prod['PD-001']]);
    await db.exec('alter table precio enable trigger precio_inmutable');
    const { filas } = await consultarDisponibilidad(db, { desde: DESDE, hasta: HASTA, limite: 500 });
    expect(num(fila(filas, 'PD-001').precio_lista_a_usd)).toBe(20);
    expect(num(fila(filas, 'PD-001').venta_perdida_usd)).toBe(114.28);               // 10 × 0,5714 × 20
    expect(fila(filas, 'PD-002').precio_lista_a_usd).toBeNull();                      // sin lista A no se inventa precio
    expect(num(fila(filas, 'PD-002').venta_perdida_usd)).toBe(0);
    expect(fila(filas, 'PD-008').venta_perdida_usd).toBeNull();
  });

  it('filtra, ordena y resume por estado de salud', async () => {
    const todos = { desde: DESDE, hasta: HASTA, limite: 500 };
    expect((await consultarDisponibilidad(db, { ...todos, estado: 'RIESGO_QUIEBRE' })).filas.map((f) => f.codigo).sort()).toEqual(['PD-001', 'PD-003', 'PD-008']);
    expect((await consultarDisponibilidad(db, { ...todos, texto: 'pd-005' })).filas.map((f) => f.codigo)).toEqual(['PD-005']);
    expect((await consultarDisponibilidad(db, { ...todos, estado: 'INVENTADO' })).filas).toHaveLength(7);   // un estado desconocido no filtra
    // Por omisión, de mayor a menor venta perdida.
    expect((await consultarDisponibilidad(db, todos)).filas[0].codigo).toBe('PD-001');
    expect((await consultarDisponibilidad(db, { ...todos, orden: 'dias_sin_existencia' })).filas.slice(0, 3).map((f) => f.codigo)).toEqual(['PD-008', 'PD-005', 'PD-003']);
    expect((await consultarDisponibilidad(db, { ...todos, orden: 'codigo', limite: 2 })).filas.map((f) => f.codigo)).toEqual(['PD-001', 'PD-002']);
    expect(await resumenSalud(db, DESDE, HASTA)).toEqual({
      RIESGO_QUIEBRE: 3, DEMANDA_REPRIMIDA: 1, SOBRESTOCK: 1, SIN_ROTACION: 1, SALUDABLE: 1,
    });
    expect(ESTADOS_SALUD).toHaveLength(5);
  });

  it('valida el periodo', async () => {
    expect(() => validarPeriodo('2026-02-01', '2026-01-01')).toThrow('no puede ser posterior');
    expect(() => validarPeriodo('01-02-2026', undefined)).toThrow('aaaa-mm-dd');
    expect(() => validarPeriodo('2020-01-01', '2026-01-01')).toThrow('tres años');
    await esperarError(consultarDisponibilidad(db, { desde: '2026-03-01', hasta: '2026-02-01' }), 'posterior');
  });

  it('la vista vw_disponibilidad usa la ventana del parámetro terminada hoy', async () => {
    const hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
    const { desde, hasta, filas } = await consultarDisponibilidad(db, { limite: 500 });
    expect(hasta).toBe(hoy);
    expect((await db.query<{ d: string }>('select ($1::date - 89)::text as d', [hoy])).rows[0].d).toBe(desde);
    const p7 = fila(filas, 'PD-007');
    expect(p7.dias_periodo).toBe(90);                          // su primer registro (1 de enero) es anterior a la ventana
    const v = async () => (await db.query<{ dias_periodo: number; codigo: string }>(`select dias_periodo, codigo from vw_disponibilidad where codigo = 'PD-007'`)).rows[0];
    expect((await v()).dias_periodo).toBe(90);
    await parametro('VENTANA_VELOCIDAD_DIAS', 10);
    expect((await v()).dias_periodo).toBe(10);
    await parametro('VENTANA_VELOCIDAD_DIAS', 90);
  });
});
