import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida, despacharParcial } from '@/lib/ventas/despacho';
import {
  agregarLinea, anularNotaEntrega, anularPedido, crearPedido, detalleDocumento, emitirPedido, generarNotaEntrega, type Usuario,
} from '@/lib/ventas/pedidos';
import {
  buscarOrdenes, cambiarPrioridad, detalleOrden, empacarOrden, esperarFaltante, finalizarOrden, iniciarOrden, registrarRecogida, tomarOrden,
} from '@/lib/ventas/picking';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

let MOTIVO_OTRO = '';
const motivoOtro = (detalle: string) => ({ motivoId: MOTIVO_OTRO, detalle });

describe('picking, salida de mercancía y despacho parcial (§6.4, §8.2, §12.3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacenista: Usuario;
  let otroAlmacenista: Usuario;
  let gerente: Usuario;
  let supervisor: Usuario;
  let ventas: Usuario;
  let a01: string;          // con picking
  let mostrador: string;    // sin picking
  let cliente: string;
  let pastilla: string;     // US$ 10, IVA general, costo 4,00
  let aceite: string;       // US$ 20, exento, costo 6,50

  const como = <T,>(usuario: string, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  const stock = (prod: string, almacen: string, cantidad: string, costo: string) => como(almacenista.id, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('entrada_compra', $1, $2, $3, $4, 'prueba', gen_random_uuid())`, [prod, almacen, cantidad, costo]));
  const existencia = async (prod: string, almacen: string) =>
    (await db.query<{ cantidad: string; reservado: string }>(
      'select cantidad::text, reservado::text from existencia where producto_id = $1 and almacen_id = $2', [prod, almacen])).rows[0];

  /** Pedido aprobado con sus líneas y su nota de entrega; devuelve ids del pedido, la nota y la orden de picking (si la hay). */
  async function nota(almacen: string, lineas: [string, string][]) {
    const pedido = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: almacen }));
    for (const [p, c] of lineas) await como(ventas.id, (tx) => agregarLinea(tx, ventas, pedido, { productoId: p, cantidad: c }));
    await como(ventas.id, (tx) => emitirPedido(tx, ventas, pedido));
    const notaId = await como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, pedido));
    const { rows } = await db.query<{ id: string }>(`select id from orden_picking where nota_entrega_id = $1 and estado <> 'cancelada'`, [notaId]);
    return { pedido, notaId, orden: rows[0]?.id as string };
  }
  /** Lleva la orden por todo el picking recogiendo lo indicado por producto (por defecto, todo). */
  async function recoger(orden: string, cantidades: Record<string, string> = {}, motivo = 'No estaba en la ubicación') {
    await como(almacenista.id, (tx) => iniciarOrden(tx, almacenista, orden));
    const d = (await detalleOrden(db, orden))!;
    for (const l of d.lineas) {
      const c = cantidades[l.codigo] ?? l.pedida;
      await como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, l.id, { cantidad: c, motivoFaltante: c === l.pedida ? undefined : motivo }));
    }
    return como(almacenista.id, (tx) => finalizarOrden(tx, almacenista, orden));
  }

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    MOTIVO_OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const idGerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idAlm2 = await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']);
    const idVentas = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idFact = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    gerente = { id: idGerente, roles: ['gerencia'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    otroAlmacenista = { id: idAlm2, roles: ['almacen'] };
    ventas = { id: idVentas, roles: ['ventas'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.query('update almacen set usa_picking = false where id = $1', [mostrador]);
    await db.transaction(async (tx) => {
      await asignarUsuarios(tx, a01, [idAlm]);
      await asignarUsuarios(tx, mostrador, [idAlm, idAlm2]);
    });

    const vendedor = await db.transaction((tx) => crearVendedor(tx, idGerente, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVentas }));
    const c = await db.transaction((tx) => crearCliente(tx, idFact, {
      rif: 'J-12345678-4', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: { vendedorId: vendedor.id },
    }));
    cliente = c.id;
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    await db.transaction((tx) => aprobarCliente(tx, cliente, idGerente, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
    };
    pastilla = await nuevo('PF-001', general);
    aceite = await nuevo('AC-001', exento);
    const hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
    await db.transaction(async (tx) => {
      await fijarPrecio(tx, pastilla, 'B', '10.00', hoy);
      await fijarPrecio(tx, aceite, 'B', '20.00', hoy);
    });
    await stock(pastilla, a01, '100', '4.00');
    await stock(aceite, a01, '100', '6.50');
    await stock(pastilla, mostrador, '20', '4.00');
  });
  afterAll(() => cerrar());

  it('la nota de entrega crea su orden de picking, que avanza por sus estados con marcas de hora de la base', async () => {
    const { orden, notaId } = await nota(a01, [[pastilla, '5']]);
    let d = (await detalleOrden(db, orden))!;
    expect([d.estado, d.prioridad, d.lineas.length, d.nota_id]).toEqual(['pendiente', 3, 1, notaId]);
    expect(d.lineas[0]).toMatchObject({ codigo: 'PF-001', pedida: '5.0000', recogida: '0.0000' });

    await esperarError(como(otroAlmacenista.id, (tx) => tomarOrden(tx, otroAlmacenista, orden)), 'no está entre los suyos');
    await como(almacenista.id, (tx) => cambiarPrioridad(tx, almacenista, orden, 1));
    await esperarError(como(almacenista.id, (tx) => cambiarPrioridad(tx, almacenista, orden, 9)), 'va de 1');
    await como(almacenista.id, (tx) => tomarOrden(tx, almacenista, orden));
    await esperarError(como(almacenista.id, (tx) => tomarOrden(tx, almacenista, orden)), 'pendiente');
    await esperarError(como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, d.lineas[0].id, { cantidad: '1' })), 'en proceso');
    await como(almacenista.id, (tx) => iniciarOrden(tx, almacenista, orden));
    await esperarError(como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, d.lineas[0].id, { cantidad: '6' })), 'más de lo pedido');
    await esperarError(como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, d.lineas[0].id, { cantidad: 'x' })), 'número');
    await como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, d.lineas[0].id, { cantidad: '5' }));
    expect(await como(almacenista.id, (tx) => finalizarOrden(tx, almacenista, orden))).toBe('completa');
    await esperarError(como(almacenista.id, (tx) => iniciarOrden(tx, almacenista, orden)), 'pendiente o asignada');
    await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    await esperarError(como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden)), 'ya está empacada');

    d = (await detalleOrden(db, orden))!;
    expect(d.estado).toBe('completa');
    expect(d.asignada_a).not.toBeNull();
    const { rows } = await db.query<{ asignada_at: string | null; iniciada_at: string | null; finalizada_at: string | null; empacada_at: string | null }>(
      'select asignada_at::text, iniciada_at::text, finalizada_at::text, empacada_at::text from orden_picking where id = $1', [orden]);
    expect(Object.values(rows[0]).every((v) => v !== null)).toBe(true);
    // La orden y sus líneas no se editan fuera de las transiciones válidas.
    await esperarError(db.query(`update orden_picking set estado = 'pendiente' where id = $1`, [orden]), 'no pasa a pendiente');
    await esperarError(db.query(`update orden_picking set nota_entrega_id = $2 where id = $1`, [orden, (await nota(a01, [[aceite, '1']])).notaId]), 'no cambia de nota');
    await esperarError(db.query(`delete from orden_picking where id = $1`, [orden]), 'se cancela');
    await esperarError(db.query(`update orden_picking_linea set cantidad_pedida = 9 where orden_id = $1`, [orden]), 'cantidad pedida');
    await esperarError(db.query(`delete from orden_picking_linea where orden_id = $1`, [orden]), 'no se borran');
    await como(supervisor.id, (tx) => anularNotaEntrega(tx, supervisor, notaId, motivoOtro('Prueba')));
  });

  it('los tiempos salen de las marcas de hora: espera, picking, ciclo, líneas por hora y objetivo (R-AM)', async () => {
    const { orden } = await nota(a01, [[pastilla, '2'], [aceite, '1']]);
    await recoger(orden);
    await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    await db.query(`insert into almacen_picking_objetivo (almacen_id, prioridad, horas) values ($1, 3, 1.5)`, [a01]);
    // Se fijan marcas conocidas: creada 10:00, iniciada 10:30, finalizada 11:00 (2 líneas), empacada 11:15.
    await db.exec(`alter table orden_picking disable trigger orden_picking_antes`);
    await db.query(
      `update orden_picking set creada_at = '2026-03-02 10:00-04', iniciada_at = '2026-03-02 10:30-04',
              finalizada_at = '2026-03-02 11:00-04', empacada_at = '2026-03-02 11:15-04' where id = $1`, [orden]);
    await db.exec(`alter table orden_picking enable trigger orden_picking_antes`);
    const { rows } = await db.query<Record<string, string | boolean | null>>(
      `select espera_seg::text, picking_seg::text, ciclo_seg::text, lineas_por_hora::text, objetivo_horas::text, cumple_objetivo
         from vw_picking_tiempos where orden_id = $1`, [orden]);
    expect(rows[0]).toEqual({ espera_seg: '1800', picking_seg: '1800', ciclo_seg: '4500', lineas_por_hora: '4.00', objetivo_horas: '1.50', cumple_objetivo: true });
    await db.query(`update almacen_picking_objetivo set horas = 1 where almacen_id = $1`, [a01]);
    expect((await db.query<{ c: boolean }>(`select cumple_objetivo as c from vw_picking_tiempos where orden_id = $1`, [orden])).rows[0].c).toBe(false);
  });

  it('confirmar la salida descuenta existencia al costo promedio, guarda el costo por línea y genera el asiento (R-AO)', async () => {
    const antesP = await existencia(pastilla, a01);
    const antesA = await existencia(aceite, a01);
    const { notaId, orden } = await nota(a01, [[pastilla, '10'], [aceite, '4']]);
    expect((await existencia(pastilla, a01)).reservado).toBe(`${(Number(antesP.reservado) + 10).toFixed(4)}`);

    // Sin picking completo y empacado no sale la mercancía.
    await esperarError(como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId)), 'todavía no está completo');
    await recoger(orden);
    await esperarError(como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId)), 'empaque');
    await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    await esperarError(como(otroAlmacenista.id, (tx) => confirmarSalida(tx, otroAlmacenista, notaId)), 'no está entre los suyos');

    const r = await como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId));
    expect(r.costoUsd).toBe('66.00');                                     // 10 × 4,00 + 4 × 6,50
    expect(r.asiento).toMatch(/^\d+$/);

    const p = await existencia(pastilla, a01);
    const a = await existencia(aceite, a01);
    expect(Number(p.cantidad)).toBe(Number(antesP.cantidad) - 10);
    expect(Number(a.cantidad)).toBe(Number(antesA.cantidad) - 4);
    expect(p.reservado).toBe(antesP.reservado);
    expect(a.reservado).toBe(antesA.reservado);

    const { rows: movs } = await db.query<{ tipo: string; cantidad: string; costo_total_usd: string }>(
      `select tipo, cantidad::text, costo_total_usd::text from movimiento_inventario where origen_tipo = 'nota_entrega' and origen_id = $1 order by id`, [notaId]);
    expect(movs).toEqual([
      { tipo: 'salida_venta', cantidad: '-10.0000', costo_total_usd: '-40.00' },
      { tipo: 'salida_venta', cantidad: '-4.0000', costo_total_usd: '-26.00' },
    ]);
    const d = (await detalleDocumento(db, notaId))!;
    expect(d.lineas.map((l) => l.codigo)).toEqual(['PF-001', 'AC-001']);
    const { rows: costos } = await db.query<{ costo_unitario_usd: string }>(
      'select costo_unitario_usd::text from documento_venta_linea where documento_id = $1 order by linea', [notaId]);
    expect(costos.map((c) => c.costo_unitario_usd)).toEqual(['4.0000', '6.5000']);

    // Asiento: Dr Costo de ventas / Cr Inventario, 66,00 USD a la tasa 40 = 2.640,00 Bs.
    const { rows: lineas } = await db.query<{ codigo: string; debe_usd: string; haber_usd: string; debe_ves: string; haber_ves: string; estado: string }>(
      `select c.codigo, l.debe_usd::text, l.haber_usd::text, l.debe_ves::text, l.haber_ves::text, a.estado
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = 'nota_entrega' and a.origen_id = $1 order by l.id`, [notaId]);
    expect(lineas).toEqual([
      { codigo: '5.1.01', debe_usd: '66.00', haber_usd: '0.00', debe_ves: '2640.00', haber_ves: '0.00', estado: 'contabilizado' },
      { codigo: '1.3.01', debe_usd: '0.00', haber_usd: '66.00', debe_ves: '0.00', haber_ves: '2640.00', estado: 'contabilizado' },
    ]);

    // La nota despachada no vuelve a salir ni se anula, y su pedido no se anula tampoco.
    await esperarError(como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId)), 'ya salió');
    await esperarError(como(ventas.id, (tx) => anularNotaEntrega(tx, ventas, notaId, motivoOtro('Prueba'))), 'ya salió');
    await esperarError(db.query(`update documento_venta set estado = 'anulado', anulado_motivo = 'xxx' where id = $1`, [notaId]), 'ya salió');
    await esperarError(db.query(`update documento_venta set salida_at = null, salida_por = null where id = $1`, [notaId]), 'salida');
    await esperarError(db.query(`update documento_venta_linea set cantidad = 1 where documento_id = $1`, [notaId]), 'no se modifican');
    await esperarError(db.query(`update documento_venta_linea set costo_unitario_usd = 1 where documento_id = $1`, [notaId]), 'no se modifican');
  });

  it('el costo de venta usa el promedio vigente después de nuevas entradas', async () => {
    await stock(aceite, a01, '50', '9.50');                              // el promedio sube
    const { rows: c } = await db.query<{ costo_promedio_usd: string }>('select costo_promedio_usd::text from producto_costo where producto_id = $1', [aceite]);
    const promedio = Number(c[0].costo_promedio_usd);
    expect(promedio).toBeGreaterThan(6.5);
    const { notaId, orden } = await nota(a01, [[aceite, '2']]);
    await recoger(orden);
    await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    const r = await como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId));
    expect(Number(r.costoUsd)).toBeCloseTo(2 * promedio, 2);
  });

  describe('faltantes en el picking (§6.4)', () => {
    it('un faltante exige motivo y deja la orden con faltante: la salida queda bloqueada hasta que se decida', async () => {
      const { orden, notaId } = await nota(a01, [[pastilla, '6']]);
      await como(almacenista.id, (tx) => iniciarOrden(tx, almacenista, orden));
      const l = (await detalleOrden(db, orden))!.lineas[0];
      await como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, l.id, { cantidad: '4' }));
      await esperarError(como(almacenista.id, (tx) => finalizarOrden(tx, almacenista, orden)), 'motivo del faltante');
      await como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, l.id, { cantidad: '4', motivoFaltante: 'Caja dañada' }));
      expect(await como(almacenista.id, (tx) => finalizarOrden(tx, almacenista, orden))).toBe('con_faltante');
      await esperarError(como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden)), 'picking completo');
      await esperarError(como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId)), 'faltante pendiente');

      // Esperar: la orden vuelve a estar en proceso y se puede completar.
      await como(supervisor.id, (tx) => esperarFaltante(tx, orden));
      await como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, l.id, { cantidad: '6' }));
      expect(await como(almacenista.id, (tx) => finalizarOrden(tx, almacenista, orden))).toBe('completa');
      await como(supervisor.id, (tx) => anularNotaEntrega(tx, supervisor, notaId, motivoOtro('Prueba')));
    });

    it('despachar parcial: registra la demanda, emite otra nota con lo recogido y conserva la misma orden y sus tiempos', async () => {
      const antes = await existencia(pastilla, a01);
      const { pedido, orden, notaId } = await nota(a01, [[pastilla, '10'], [aceite, '3']]);
      expect(await recoger(orden, { 'PF-001': '6' })).toBe('con_faltante');
      const tiempos = (await db.query<{ iniciada_at: string; finalizada_at: string }>(
        'select iniciada_at::text, finalizada_at::text from orden_picking where id = $1', [orden])).rows[0];

      const r = await como(supervisor.id, (tx) => despacharParcial(tx, supervisor, orden));
      expect(r.notaNuevaId).not.toBeNull();
      const vieja = (await detalleDocumento(db, notaId))!;
      const nueva = (await detalleDocumento(db, r.notaNuevaId!))!;
      expect(vieja.estado).toBe('anulado');
      expect(nueva.estado).toBe('emitido');
      expect(nueva.lineas.map((l) => [l.codigo, l.cantidad])).toEqual([['PF-001', '6.0000'], ['AC-001', '3.0000']]);

      const dem = await db.query<{ cantidad: string }>('select cantidad::text from demanda_no_atendida where documento_id = $1', [pedido]);
      expect(dem.rows).toEqual([{ cantidad: '4.0000' }]);

      // Lo que faltó deja de estar reservado: solo quedan reservadas 6 pastillas del pedido.
      expect((await existencia(pastilla, a01)).reservado).toBe(`${(Number(antes.reservado) + 6).toFixed(4)}`);

      // La misma orden sigue: completa, con la nota nueva, lo recogido como pedido y los tiempos originales.
      const o = (await detalleOrden(db, orden))!;
      expect([o.estado, o.nota_id]).toEqual(['completa', r.notaNuevaId]);
      expect(o.lineas.map((l) => [l.codigo, l.pedida, l.recogida])).toEqual([['AC-001', '3.0000', '3.0000'], ['PF-001', '6.0000', '6.0000']]);
      const despues = (await db.query<{ iniciada_at: string; finalizada_at: string }>(
        'select iniciada_at::text, finalizada_at::text from orden_picking where id = $1', [orden])).rows[0];
      expect(despues).toEqual(tiempos);
      expect((await db.query('select 1 from orden_picking where nota_entrega_id = $1', [r.notaNuevaId])).rows).toHaveLength(1);
      expect((await db.query('select 1 from orden_picking where nota_entrega_id = $1', [notaId])).rows).toHaveLength(0);

      await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
      const salida = await como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, r.notaNuevaId!));
      expect(salida.costoUsd).toBe(`${(6 * 4 + 3 * Number((await db.query<{ c: string }>('select costo_promedio_usd::text as c from producto_costo where producto_id = $1', [aceite])).rows[0].c)).toFixed(2)}`);
      expect(Number((await existencia(pastilla, a01)).cantidad)).toBe(Number(antes.cantidad) - 6);

      // El pedido conserva lo que falta por entregar: 4 pastillas pendientes, que se pueden reservar de nuevo.
      const p = (await detalleDocumento(db, pedido))!;
      expect(p.lineas.find((x) => x.codigo === 'PF-001')!.entregado).toBe('6.0000');
    });

    it('si no se recogió nada, despachar parcial anula la nota y cancela la orden', async () => {
      const antes = await existencia(pastilla, a01);
      const { orden, notaId } = await nota(a01, [[pastilla, '5']]);
      expect(await recoger(orden, { 'PF-001': '0' })).toBe('con_faltante');
      const r = await como(supervisor.id, (tx) => despacharParcial(tx, supervisor, orden));
      expect(r.notaNuevaId).toBeNull();
      expect((await detalleDocumento(db, notaId))!.estado).toBe('anulado');
      expect((await detalleOrden(db, orden))!.estado).toBe('cancelada');
      expect(await existencia(pastilla, a01)).toEqual(antes);
    });

    it('solo se despacha parcial una orden con faltante', async () => {
      const { orden, notaId } = await nota(a01, [[pastilla, '1']]);
      await esperarError(como(supervisor.id, (tx) => despacharParcial(tx, supervisor, orden)), 'no tiene faltante');
      await esperarError(como(supervisor.id, (tx) => esperarFaltante(tx, orden)), 'no tiene faltante');
      await como(supervisor.id, (tx) => anularNotaEntrega(tx, supervisor, notaId, motivoOtro('Prueba')));
      expect((await detalleOrden(db, orden))!.estado).toBe('cancelada');
    });
  });

  it('un almacén sin picking despacha directo desde la nota de entrega (R-AL)', async () => {
    const { notaId, orden } = await nota(mostrador, [[pastilla, '3']]);
    expect(orden).toBeUndefined();
    const r = await como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId));
    expect(r.costoUsd).toBe('12.00');
    expect((await detalleDocumento(db, notaId))!.estado).toBe('emitido');
    expect((await db.query<{ n: number }>(`select count(*)::int as n from documento_venta where id = $1 and salida_at is not null`, [notaId])).rows[0].n).toBe(1);
  });

  it('la salida sin periodo contable abierto se rechaza y revierte todo', async () => {
    const { notaId, orden } = await nota(a01, [[pastilla, '1']]);
    await recoger(orden);
    await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    const antes = await existencia(pastilla, a01);
    await db.query(`update periodo_contable set estado = 'cerrado'`);
    await esperarError(como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId)), 'eriodo');
    await db.query(`update periodo_contable set estado = 'abierto'`);
    expect(await existencia(pastilla, a01)).toEqual(antes);
    expect((await db.query('select 1 from documento_venta where id = $1 and salida_at is not null', [notaId])).rows).toHaveLength(0);
    await como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId));
  });

  it('el almacenista solo ve las órdenes de sus almacenes', async () => {
    const mias = await buscarOrdenes(db, almacenista, {});
    const ajenas = await buscarOrdenes(db, otroAlmacenista, {});
    expect(mias.length).toBeGreaterThan(0);
    expect(ajenas).toEqual([]);                                          // solo tiene asignado el mostrador, que no usa picking
    expect((await buscarOrdenes(db, gerente, {})).length).toBe(mias.length);
    expect(await buscarOrdenes(db, ventas, {})).toEqual([]);
  });

  it('un pedido con notas despachadas no se anula', async () => {
    const { pedido, notaId, orden } = await nota(a01, [[pastilla, '1']]);
    await recoger(orden);
    await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    await como(almacenista.id, (tx) => confirmarSalida(tx, almacenista, notaId));
    await esperarError(como(ventas.id, (tx) => anularPedido(tx, ventas, pedido, motivoOtro('Prueba'))), 'notas de entrega vigentes');
  });
});
