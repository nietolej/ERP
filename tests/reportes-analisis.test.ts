import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { registrarCobro } from '@/lib/ventas/cobros';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import {
  histogramaPedidos, patronesMorosidad, quiebresPorMes, quiebresPorProducto, tramosDePedido, velocidadTrasQuiebre,
} from '@/lib/reportes/analisis';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const NADIE = '00000000-0000-0000-0000-000000000000';

describe('M7 Análisis Avanzado (spec_reportes §14)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let mostrador = '';
  let sucursal = '';
  let clienteA = '';
  let clienteB = '';
  let vendedorId = '';
  let aceite = '';
  let filtro = '';
  let sinHistoria = '';
  let cuentaVes = '';
  let transferencia = '';
  let hoy = '';
  let anioActual = 0;
  let f1 = '';
  let f2 = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const fecha = async (dias: number) => (await db.query<{ d: string }>('select ($1::date + $2::int)::text as d', [hoy, dias])).rows[0].d;

  async function facturar(cliente: string, cantidad: string): Promise<string> {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: aceite, cantidad }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    return f.facturaId;
  }
  async function retroceder(facturaId: string, diasEmision: number, diasVencimiento: number): Promise<void> {
    await db.query('alter table partida_cxc disable trigger partida_cxc_reglas');
    await db.query('update partida_cxc set fecha = fecha - $2::int, vencimiento = vencimiento - $3::int where documento_id = $1',
      [facturaId, diasEmision, diasVencimiento]);
    await db.query('alter table partida_cxc enable trigger partida_cxc_reglas');
  }
  async function pagarSaldo(cliente: string, facturaId: string): Promise<void> {
    const { rows } = await db.query<{ id: string; saldo: string }>('select id, saldo::text from partida_cxc where documento_id = $1', [facturaId]);
    await como(cobranzas, (tx) => registrarCobro(tx, cobranzas, {
      clienteId: cliente, fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, monto: rows[0].saldo,
      aplicaciones: [{ partidaId: rows[0].id, monto: rows[0].saldo, liquida: true }],
    }));
  }
  const movimiento = (tipo: 'entrada_compra' | 'salida_venta', producto: string, cantidad: number, cuando: string | null) => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, fecha)
     values ($1, $2, $3, $4, 1, 'prueba', gen_random_uuid(), coalesce($5::date::timestamptz, now()))`,
    [tipo, producto, mostrador, tipo === 'salida_venta' ? -cantidad : cantidad, cuando]));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    ventas = { id: idVen, roles: ['ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const h = (await db.query<{ d: string; a: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as d, extract(year from now() at time zone 'America/Caracas')::int as a`)).rows[0];
    hoy = h.d; anioActual = h.a;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [hoy]);

    sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    vendedorId = vend.id;
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, idFac, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    clienteA = await cliente('J-00000010-7', 'Repuestos Lara, C.A.');
    clienteB = await cliente('J-00000020-4', 'Autopartes Sur, C.A.');
    await db.query(`update cliente set zona = 'Centro' where tercero_id = $1`, [clienteA]);
    await db.query(`update cliente set zona = 'Occidente' where tercero_id = $1`, [clienteB]);

    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const producto = async (codigo: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
      }));
    };
    aceite = await producto('AC-001');
    filtro = await producto('FI-001');
    sinHistoria = await producto('SM-002');
    await db.transaction((tx) => fijarPrecio(tx, aceite, 'B', '20.00', hoy));
    await db.transaction((tx) => fijarPrecio(tx, filtro, 'A', '10.00', hoy));
    await movimiento('entrada_compra', aceite, 500, null);

    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(cobranzas, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;

    // Pedidos (precio B = US$ 20, exento). Cliente A: f1 (US$ 20, contado, cobrada hoy); luego cambia a crédito de 30 días:
    // f2 (US$ 60, 30 días, emitida hace 40 y vencida hace 10, sin cobrar). Cliente B (contado): f3 (US$ 1.200, cobrada a los 40 días);
    // f4 (US$ 20, emitida hace 30 y vencida hace 20, sin cobrar).
    f1 = await facturar(clienteA, '1');
    await pagarSaldo(clienteA, f1);
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    await db.query('update cliente set condicion_pago_id = $2, limite_credito_usd = 100000 where tercero_id = $1', [clienteA, cr30]);
    f2 = await facturar(clienteA, '3');
    await retroceder(f2, 40, 40);
    const f3 = await facturar(clienteB, '60');
    await retroceder(f3, 40, 0);
    await pagarSaldo(clienteB, f3);
    const f4 = await facturar(clienteB, '1');
    await retroceder(f4, 30, 20);

    // Quiebres del producto FI-001 en el almacén comercial (ventana de 15 días):
    //   existencia: 50 desde hace 100 días; en cero hace 40 días; 100 desde hace 30 días (episodio 1, 10 días); en cero otra vez hace 5 días
    //   (episodio 2, sigue abierto). Ventas: 30 hace 50 días (antes del episodio 1) y 60 hace 20 días (después del 1, antes del 2).
    // SM-002 nace con existencia cero: no es un episodio.
    await movimiento('entrada_compra', filtro, 200, null);
    await movimiento('salida_venta', filtro, 30, await fecha(-50));
    await movimiento('salida_venta', filtro, 60, await fecha(-20));
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.inventario_interno', '1', true)");
      await tx.query('delete from existencia_diaria where producto_id = any($1::uuid[])', [[filtro, sinHistoria]]);
      const filas: [string, number, number][] = [[filtro, -100, 50], [filtro, -40, 0], [filtro, -30, 100], [filtro, -5, 0], [sinHistoria, -10, 0]];
      for (const [p, dias, cantidad] of filas) {
        await tx.query('insert into existencia_diaria (fecha, producto_id, almacen_id, cantidad, reservado) values ($1::date + $2::int, $3, $4, $5, 0)',
          [hoy, dias, p, mostrador, cantidad]);
      }
    });
  });
  afterAll(() => cerrar());

  it('la factura congela la condición de pago del cliente: un cambio posterior no la altera y no se puede editar', async () => {
    const { rows } = await db.query<{ id: string; codigo: string; dias: number; venc: string; emision: string }>(
      `select d.id, cp.codigo, d.dias_credito as dias, d.fecha_vencimiento::text as venc, (d.fecha_emision at time zone 'America/Caracas')::date::text as emision
         from documento_venta d join condicion_pago cp on cp.id = d.condicion_pago_id where d.id = any($1::uuid[])`, [[f1, f2]]);
    const a = rows.find((r) => r.id === f1)!;
    const b = rows.find((r) => r.id === f2)!;
    expect([a.codigo, a.dias]).toEqual(['CONTADO', 0]);
    expect([b.codigo, b.dias]).toEqual(['CR30', 30]);
    expect(a.venc).toBe(a.emision);
    await esperarError(db.query('update documento_venta set dias_credito = 99 where id = $1', [f1]), 'Un documento emitido no se edita');
  });

  it('tramos: el índice sale de los parámetros y el último es el tramo abierto', async () => {
    const { rows } = await db.query<{ a: number; b: number; c: number; d: number; e: number }>(
      'select fn_tramo_pedido(0) as a, fn_tramo_pedido(49.99) as b, fn_tramo_pedido(50) as c, fn_tramo_pedido(999.99) as d, fn_tramo_pedido(1000) as e');
    expect(rows[0]).toEqual({ a: 0, b: 0, c: 1, d: 19, e: 20 });
    expect(tramosDePedido(50, 1000)).toHaveLength(21);
    const t = tramosDePedido(50, 120);          // 0-50, 50-100, 100-150 y "más de 150"
    expect(t).toHaveLength(4);
    expect(t[3]).toMatchObject({ desdeUsd: 150, hastaUsd: null });
  });

  it('histograma de pedidos: cantidad, % del total, monto y promedio por tramo (todos los tramos, aunque vacíos)', async () => {
    const h = await histogramaPedidos(db, { anios: [anioActual] });
    expect(h).toMatchObject({ tramoUsd: 50, topeUsd: 1000, totalPedidos: 4 });
    expect(h.filas).toHaveLength(21);
    expect(h.filas[0]).toMatchObject({ pedidos: 2, pct: 50, montoUsd: '40.00', promedioUsd: '20.00' });
    expect(h.filas[1]).toMatchObject({ pedidos: 1, pct: 25, montoUsd: '60.00', promedioUsd: '60.00' });
    expect(h.filas[2]).toMatchObject({ pedidos: 0, pct: 0, montoUsd: '0.00', promedioUsd: null });
    expect(h.filas[20]).toMatchObject({ desdeUsd: 1000, hastaUsd: null, pedidos: 1, montoUsd: '1200.00' });
    expect(h.filas.reduce((s, f) => s + f.pedidos, 0)).toBe(4);
  });

  it('filtros del histograma: zona, búsqueda de cliente, sucursal y cartera del vendedor', async () => {
    expect((await histogramaPedidos(db, { zona: 'Centro' })).totalPedidos).toBe(2);
    expect((await histogramaPedidos(db, { texto: 'Autopartes' })).totalPedidos).toBe(2);
    expect((await histogramaPedidos(db, { texto: 'J-nada' })).totalPedidos).toBe(0);
    expect((await histogramaPedidos(db, { sucursalId: sucursal })).totalPedidos).toBe(4);
    expect((await histogramaPedidos(db, { sucursalId: NADIE })).totalPedidos).toBe(0);
    expect((await histogramaPedidos(db, { vendedorId })).totalPedidos).toBe(4);
    expect((await histogramaPedidos(db, { vendedorId: NADIE })).totalPedidos).toBe(0);
  });

  it('morosidad: tramo × días de crédito congelados, días de pago ponderados, % de mora y celdas marcadas', async () => {
    const m = await patronesMorosidad(db, { anios: [anioActual] });
    expect(m.umbralPct).toBe(20);
    expect(m.filas.map((f) => [f.tramo, f.diasCredito, f.facturas, f.enMora, f.moraPct, f.deudaUsd, f.marcada])).toEqual([
      [0, 0, 2, 1, 50, '20.00', true],       // f1 (cobrada) y f4 (vencida sin cobrar)
      [1, 30, 1, 1, 100, '60.00', true],     // f2: el plazo es el que tenía al facturar (30), no el actual del cliente
      [20, 0, 1, 0, 0, '0.00', false],       // f3: cobrada, sin mora
    ]);
    expect(m.filas[0].diasPago).toBe(0);     // lo cobrado de la celda se pagó el mismo día
    expect(m.filas[1].diasPago).toBeNull();  // todavía sin cobros
    expect(m.filas[2].diasPago).toBe(40);
  });

  it('morosidad: se ordena por % de mora o por días de pago, de mayor a menor', async () => {
    const porMora = await patronesMorosidad(db, { anios: [anioActual] }, 'mora');
    expect(porMora.filas.map((f) => f.moraPct)).toEqual([100, 50, 0]);
    const porDias = await patronesMorosidad(db, { anios: [anioActual] }, 'dias');
    expect(porDias.filas.map((f) => f.diasPago)).toEqual([40, 0, null]);
  });

  it('morosidad: el filtro de zona deja solo las facturas de esa zona', async () => {
    const m = await patronesMorosidad(db, { zona: 'Occidente' });
    expect(m.filas.reduce((s, f) => s + f.facturas, 0)).toBe(2);
  });

  it('velocidad tras quiebre: episodio cerrado con velocidad antes/después y variación; episodio abierto sin "después"', async () => {
    const v = await velocidadTrasQuiebre(db, { anios: [anioActual] });
    expect(v.ventanaDias).toBe(15);
    const mios = v.filas.filter((f) => f.codigo === 'FI-001');
    expect(mios).toHaveLength(2);
    expect(v.filas.some((f) => f.codigo === 'SM-002')).toBe(false); // nació en cero: no hay episodio
    const [cerrado, abierto] = mios;                                // variación descendente: el abierto (sin variación) al final
    expect(cerrado).toMatchObject({ inicio: await fecha(-40), reposicion: await fecha(-30), duracionDias: 10, velocidadAntes: '2.0000', velocidadDespues: '4.0000', variacionPct: 100 });
    expect(abierto).toMatchObject({ inicio: await fecha(-5), reposicion: null, duracionDias: 5, velocidadAntes: '4.0000', velocidadDespues: null, variacionPct: null });
  });

  it('quiebres por producto: episodios, duración total y promedio, y venta perdida a precio de lista A', async () => {
    const q = await quiebresPorProducto(db, { anios: [anioActual] });
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ codigo: 'FI-001', episodios: 2, duracionTotalDias: 15, duracionPromedioDias: 7.5, ventaPerdidaUsd: '400.00' });
    // 10 días × 2 u/día × US$ 10 + 5 días × 4 u/día × US$ 10
    expect((await quiebresPorProducto(db, {}, 'duracion'))[0].codigo).toBe('FI-001');
    expect((await quiebresPorProducto(db, {}, 'venta_perdida'))[0].codigo).toBe('FI-001');
  });

  it('quiebres: los filtros de almacén y grupo se aplican y el conteo mensual suma los episodios', async () => {
    expect(await quiebresPorProducto(db, { almacenId: NADIE })).toEqual([]);
    expect(await quiebresPorProducto(db, { grupoId: NADIE })).toEqual([]);
    expect(await quiebresPorProducto(db, { almacenId: mostrador })).toHaveLength(1);
    const meses = await quiebresPorMes(db, {});
    expect(meses.reduce((s, m) => s + m.episodios, 0)).toBe(2);
    expect(meses.every((m) => m.mes >= 1 && m.mes <= 12)).toBe(true);
  });
});
