import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import {
  actualizarOrden, anularOrden, buscarOrdenes, crearOrden, detalleOrden, eliminarBorrador, enviarOrden, faltantesDe, guardarComponente, iniciarOrden, quitarComponente, terminarOrden,
  type UsuarioProd,
} from '@/lib/produccion/ordenes';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Producción o ensamblaje: órdenes simples (spec §8.4; migración 0043). Los componentes salen al costo promedio y el terminado entra por la suma.
 */
describe('producción: órdenes simples (R-CQ a R-CS)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacenista: UsuarioProd;
  let otroAlmacenista: UsuarioProd;
  let gerente: UsuarioProd;
  let otroGerente: UsuarioProd;
  let comprador: UsuarioProd;
  let a01 = '';
  let a02 = '';
  let kit = '';          // producto terminado
  let pastilla = '';
  let caja = '';
  let aceite = '';
  let servicio = '';

  const como = <T,>(u: UsuarioProd, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const stock = (prod: string, almacen: string, cantidad: string, costo: string) => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('entrada_compra', $1, $2, $3, $4, 'prueba', gen_random_uuid())`, [prod, almacen, cantidad, costo]));
  const existencia = async (prod: string, almacen = a01) =>
    Number((await db.query<{ c: string }>('select coalesce((select cantidad from existencia where producto_id = $1 and almacen_id = $2), 0)::text as c', [prod, almacen])).rows[0].c);
  const costo = async (prod: string) => (await db.query<{ c: string; v: string }>('select costo_promedio_usd::text as c, valor_usd::text as v from producto_costo where producto_id = $1', [prod])).rows[0];
  /** Orden en borrador con sus componentes. */
  const nueva = async (cantidad: string, comps: [string, string][], u = almacenista, almacen = a01) => {
    const o = await como(u, (tx) => crearOrden(tx, u, { productoId: kit, cantidad, almacenId: almacen }));
    for (const [p, c] of comps) await como(u, (tx) => guardarComponente(tx, u, o.id, { productoId: p, cantidad: c }));
    return o.id;
  };
  const liberar = async (id: string, u = almacenista) => {
    await como(u, (tx) => enviarOrden(tx, u, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_produccion', id, gerente.id, 'aprobada'));
  };
  const estado = async (id: string) => (await detalleOrden(db, id))!.estado;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const ids = {
      alm: await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']),
      alm2: await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']),
      ger: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']),
      ger2: await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']),
      com: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']),
    };
    almacenista = { id: ids.alm, roles: ['almacen'] };
    otroAlmacenista = { id: ids.alm2, roles: ['almacen'] };
    gerente = { id: ids.ger, roles: ['gerencia'] };
    otroGerente = { id: ids.ger2, roles: ['gerencia'] };
    comprador = { id: ids.com, roles: ['compras'] };
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    a02 = await db.transaction((tx) => crearAlmacen(tx, '02', { nombre: 'Otro', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction(async (tx) => { await asignarUsuarios(tx, a01, [ids.alm]); await asignarUsuarios(tx, a02, [ids.alm2]); });
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const crear = async (codigo: string, inventariable = true) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, ids.alm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable,
      }));
    };
    kit = await crear('KIT-001');
    pastilla = await crear('PF-001');
    caja = await crear('CJ-001');
    aceite = await crear('AC-001');
    servicio = await crear('SERV-001', false);
    await stock(pastilla, a01, '100', '2.0000');
    await stock(caja, a01, '50', '0.5000');
    await stock(aceite, a01, '10', '3.0000');
  });
  afterAll(() => cerrar());

  it('se arma en borrador: validaciones de producto, almacén y componentes', async () => {
    await esperarError(como(comprador, (tx) => crearOrden(tx, comprador, { productoId: kit, cantidad: '5', almacenId: a01 })), 'Solo Almacén o Gerencia');
    await esperarError(como(almacenista, (tx) => crearOrden(tx, almacenista, { productoId: kit, cantidad: '5', almacenId: a02 })), 'no está entre los suyos');
    await esperarError(como(almacenista, (tx) => crearOrden(tx, almacenista, { productoId: kit, cantidad: '0', almacenId: a01 })), 'mayor que cero');
    await esperarError(como(almacenista, (tx) => crearOrden(tx, almacenista, { productoId: servicio, cantidad: '5', almacenId: a01 })), 'inventariable');
    const o = await como(almacenista, (tx) => crearOrden(tx, almacenista, { productoId: kit, cantidad: '5', almacenId: a01 }));
    await esperarError(como(almacenista, (tx) => guardarComponente(tx, almacenista, o.id, { productoId: kit, cantidad: '1' })), 'de sí mismo');
    await esperarError(como(almacenista, (tx) => guardarComponente(tx, almacenista, o.id, { productoId: servicio, cantidad: '1' })), 'inventariables');
    await esperarError(como(almacenista, (tx) => enviarOrden(tx, almacenista, o.id)), 'al menos un componente');
    await como(almacenista, (tx) => guardarComponente(tx, almacenista, o.id, { productoId: pastilla, cantidad: '2' }));
    await como(almacenista, (tx) => guardarComponente(tx, almacenista, o.id, { productoId: pastilla, cantidad: '4' }));   // reemplaza la cantidad
    const d = (await detalleOrden(db, o.id))!;
    expect(d.componentes_detalle).toHaveLength(1);
    expect(Number(d.componentes_detalle[0].cantidad)).toBe(4);
    await como(almacenista, (tx) => actualizarOrden(tx, almacenista, o.id, { productoId: kit, cantidad: '6', almacenId: a01, observaciones: 'Lote 1' }));
    const [c] = d.componentes_detalle;
    await como(almacenista, (tx) => quitarComponente(tx, almacenista, o.id, c.id));
    await como(almacenista, (tx) => eliminarBorrador(tx, almacenista, o.id));
    expect(await detalleOrden(db, o.id)).toBeNull();
  });

  it('liberar la decide Gerencia, distinta de quien creó la orden, y no reserva nada', async () => {
    const id = await nueva('10', [[pastilla, '20'], [caja, '10']]);
    await como(almacenista, (tx) => enviarOrden(tx, almacenista, id));
    expect(await estado(id)).toBe('pendiente');
    await esperarError(como(almacenista, (tx) => iniciarOrden(tx, almacenista, id)), 'liberada');
    await expect(como(almacenista, (tx) => resolverAprobacion(tx, 'orden_produccion', id, almacenista.id, 'aprobada'))).rejects.toThrow();
    const g: UsuarioProd = { id: gerente.id, roles: ['gerencia'] };
    const propia = await como(g, (tx) => crearOrden(tx, g, { productoId: kit, cantidad: '1', almacenId: a01 }));
    await como(g, (tx) => guardarComponente(tx, g, propia.id, { productoId: caja, cantidad: '1' }));
    await como(g, (tx) => enviarOrden(tx, g, propia.id));
    await expect(como(g, (tx) => resolverAprobacion(tx, 'orden_produccion', propia.id, g.id, 'aprobada'))).rejects.toThrow();
    await como(otroGerente, (tx) => resolverAprobacion(tx, 'orden_produccion', propia.id, otroGerente.id, 'aprobada'));
    expect(await estado(propia.id)).toBe('liberada');
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_produccion', id, gerente.id, 'aprobada'));
    expect(await estado(id)).toBe('liberada');
    expect(await existencia(pastilla)).toBe(100);                       // nada se movió ni se reservó
    const r = (await db.query<{ reservado: string }>('select reservado::text from existencia where producto_id = $1 and almacen_id = $2', [pastilla, a01])).rows[0];
    expect(Number(r.reservado)).toBe(0);
    await como(almacenista, (tx) => anularOrden(tx, almacenista, id, 'Se cancela el lote'));
    await como(g, (tx) => anularOrden(tx, g, propia.id, 'Se cancela el lote'));
  });

  it('una orden rechazada queda cerrada y no mueve nada', async () => {
    const id = await nueva('3', [[caja, '3']]);
    await como(almacenista, (tx) => enviarOrden(tx, almacenista, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_produccion', id, gerente.id, 'rechazada', { comentario: 'No hay demanda' }));
    expect(await estado(id)).toBe('rechazada');
    await esperarError(como(almacenista, (tx) => anularOrden(tx, almacenista, id, 'Ya no')), 'todavía no se terminó');
    await esperarError(db.query(`update orden_produccion set cantidad = 9 where id = $1`, [id]), 'rechazada no se modifica');
  });

  it('terminar consume los componentes al costo promedio y da entrada al terminado por la suma', async () => {
    const id = await nueva('10', [[pastilla, '20'], [caja, '10']]);       // 20 × 2.00 + 10 × 0.50 = 45.00
    await liberar(id);
    await como(almacenista, (tx) => iniciarOrden(tx, almacenista, id));
    expect(await estado(id)).toBe('en_proceso');
    const r = await como(almacenista, (tx) => terminarOrden(tx, almacenista, id));
    expect(r).toEqual({ costoTotalUsd: '45.00', costoUnitarioUsd: '4.5000', redondeo: '0.00' });
    expect([await existencia(pastilla), await existencia(caja), await existencia(kit)]).toEqual([80, 40, 10]);
    expect(await costo(kit)).toEqual({ c: '4.5000', v: '45.00' });
    expect((await costo(pastilla)).c).toBe('2.0000');                      // una salida conserva el promedio
    const d = (await detalleOrden(db, id))!;
    expect([d.estado, d.costo_total_usd, d.costo_unitario_usd]).toEqual(['terminada', '45.00', '4.5000']);
    expect(d.componentes_detalle.map((c) => c.costo_total_usd)).toEqual(['40.00', '5.00']);
    const movs = (await db.query<{ tipo: string; cantidad: string }>(
      `select tipo, cantidad::text from movimiento_inventario where origen_tipo = 'orden_produccion' and origen_id = $1 order by id`, [id])).rows;
    expect(movs.map((m) => m.tipo)).toEqual(['consumo_produccion', 'consumo_produccion', 'entrada_produccion']);
  });

  it('una orden terminada no se modifica ni se anula', async () => {
    const id = (await buscarOrdenes(db, gerente, 'terminada'))[0].id;
    await esperarError(db.query(`update orden_produccion set cantidad = 1 where id = $1`, [id]), 'terminada no se modifica');
    await esperarError(db.query(`update orden_produccion_componente set cantidad = 1 where orden_id = $1`, [id]), 'no se modifican');
    await esperarError(como(almacenista, (tx) => anularOrden(tx, almacenista, id, 'Ya no')), 'todavía no se terminó');
    await esperarError(como(almacenista, (tx) => terminarOrden(tx, almacenista, id)), 'Solo se termina una orden en proceso');
  });

  it('no se termina sin todos los componentes: nada se consume y la orden sigue en proceso', async () => {
    const id = await nueva('2', [[caja, '10'], [aceite, '25']]);          // el aceite solo tiene 10
    await liberar(id);
    await como(almacenista, (tx) => iniciarOrden(tx, almacenista, id));
    expect((await faltantesDe(db, id)).map((f) => f.codigo)).toEqual(['AC-001']);
    await esperarError(como(almacenista, (tx) => terminarOrden(tx, almacenista, id)), 'No hay existencia suficiente');
    expect([await existencia(caja), await existencia(aceite), await existencia(kit)]).toEqual([40, 10, 10]);
    expect(await estado(id)).toBe('en_proceso');
    await stock(aceite, a01, '15', '3.0000');                             // llega el faltante
    await como(almacenista, (tx) => terminarOrden(tx, almacenista, id));
    expect(await estado(id)).toBe('terminada');
    expect([await existencia(aceite), await existencia(kit)]).toEqual([0, 12]);
  });

  it('la existencia reservada para pedidos no se consume', async () => {
    await stock(aceite, a01, '5', '3.0000');
    await db.query(`select set_config('app.inventario_interno', '1', false)`);
    await db.query('update existencia set reservado = 4 where producto_id = $1 and almacen_id = $2', [aceite, a01]);
    const id = await nueva('1', [[aceite, '2']]);
    await liberar(id);
    await como(almacenista, (tx) => iniciarOrden(tx, almacenista, id));
    await esperarError(como(almacenista, (tx) => terminarOrden(tx, almacenista, id)), 'No hay existencia suficiente');
    await db.query('update existencia set reservado = 0 where producto_id = $1 and almacen_id = $2', [aceite, a01]);
    await como(almacenista, (tx) => terminarOrden(tx, almacenista, id));
  });

  it('el costo unitario lleva 4 decimales: la diferencia de centavos se asienta y el auxiliar sigue igual al mayor', async () => {
    await stock(pastilla, a01, '10', '1.3333');                            // el promedio cambia y deja decimales largos
    const id = await nueva('7', [[pastilla, '13']]);
    await liberar(id);
    await como(almacenista, (tx) => iniciarOrden(tx, almacenista, id));
    const r = await como(almacenista, (tx) => terminarOrden(tx, almacenista, id));
    const dif = Number(r.costoTotalUsd) - Number((await detalleOrden(db, id))!.componentes_detalle[0].costo_total_usd);
    expect(Number(r.redondeo)).toBeCloseTo(dif, 2);
    if (Number(r.redondeo) !== 0) {
      const n = (await db.query<{ n: number }>(`select count(*)::int as n from asiento where origen_tipo = 'orden_produccion' and origen_id = $1 and tipo = 'automatico'`, [id])).rows[0].n;
      expect(n).toBe(1);
    }
    const g = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
    expect([Number(g.ves), Number(g.usd)]).toEqual([0, 0]);
  });

  it('anular libera la solicitud pendiente y exige motivo; cada almacenista ve solo sus órdenes', async () => {
    const id = await nueva('2', [[caja, '2']]);
    await como(almacenista, (tx) => enviarOrden(tx, almacenista, id));
    await esperarError(como(almacenista, (tx) => anularOrden(tx, almacenista, id, 'x')), 'motivo');
    await esperarError(como(otroAlmacenista, (tx) => anularOrden(tx, otroAlmacenista, id, 'No es mía')), 'no está entre los suyos');
    await como(almacenista, (tx) => anularOrden(tx, almacenista, id, 'Cambio de planes'));
    const pend = (await db.query<{ n: number }>(`select count(*)::int as n from solicitud_aprobacion where objeto_tipo = 'orden_produccion' and objeto_id = $1 and estado = 'pendiente'`, [id])).rows[0].n;
    expect(pend).toBe(0);
    expect((await buscarOrdenes(db, otroAlmacenista)).length).toBe(0);
    expect((await buscarOrdenes(db, gerente)).length).toBeGreaterThan(3);
    expect(await buscarOrdenes(db, { id: comprador.id, roles: ['ventas'] })).toEqual([]);
  });
});
