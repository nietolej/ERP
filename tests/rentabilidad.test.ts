import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import { estadosDelMes } from '@/lib/contabilidad/estados';
import { cifrasDe, rentabilidadPor, rentabilidadTotal } from '@/lib/contabilidad/rentabilidad';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

describe('rentabilidad por dimensión (spec §12.5; R-DT)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let aceite: string;
  let motivoDevolucion = '';
  let anioActual = 0;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  async function facturar(cliente: string, cantidad: string): Promise<{ facturaId: string; lineaId: string }> {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: aceite, cantidad }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const { rows } = await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [f.facturaId]);
    return { facturaId: f.facturaId, lineaId: rows[0].id };
  }
  async function devolver(f: { facturaId: string; lineaId: string }, cantidad: string): Promise<void> {
    const id = await como(ventas, (tx) => crearNotaCredito(tx, ventas, {
      facturaId: f.facturaId, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: f.lineaId, cantidad }],
    }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, id));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', id, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, id, { servicio: new ImprentaSimulada() }));
  }

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    ventas = { id: idVen, roles: ['ventas'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const h = (await db.query<{ d: string; a: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as d, extract(year from now() at time zone 'America/Caracas')::int as a`)).rows[0];
    anioActual = h.a;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [h.d]);

    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
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
    const clienteC = await cliente('J-00000030-1', 'Frenos del Centro, C.A.');

    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-AC-001', { descripcion: 'Artículo AC-001' }));
    aceite = await db.transaction((tx) => crearProducto(tx, idAlm, 'AC-001', {
      descripcion: 'Aceite de motor', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
    await db.transaction((tx) => fijarPrecio(tx, aceite, 'B', '20.00', h.d));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 500, 6.5, 'prueba', gen_random_uuid())`, [aceite, mostrador]));
    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;

    // A: 50 und (US$ 1.000), devuelve 2 (US$ 40 = 4 %: MODERADO). B: 20 und (US$ 400), devuelve 10 (US$ 200 = 50 %: CRÍTICO).
    // C: 5 und (US$ 100) sin devolución.
    const fa = await facturar(clienteA, '50');
    const fb = await facturar(clienteB, '20');
    await facturar(clienteC, '5');
    await devolver(fa, '2');
    await devolver(fb, '10');
  });
  afterAll(() => cerrar());

  const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  const rango = () => [`${anioActual}-01-01`, hoy()] as const;

  it('el total: venta, devoluciones, venta neta, costo (menos el que reingresa) y margen', async () => {
    const t = await rentabilidadTotal(db, ...rango());
    expect([t.ventaUsd, t.devolucionUsd, t.descuentoPosteriorUsd, t.prontoPagoUsd, t.ventaNetaUsd].map((x) => x.toFixed(2))).toEqual(['1500.00', '240.00', '0.00', '0.00', '1260.00']);
    expect([t.costoUsd.toFixed(2), t.margenUsd.toFixed(2), t.margenPct]).toEqual(['409.50', '850.50', '67.50']);       // costo 487,50 − 78,00 reingresado
  });

  it('por cliente: cada uno con su venta neta, costo y margen, de mayor a menor margen', async () => {
    const f = await rentabilidadPor(db, 'cliente', ...rango());
    expect(f.map((x) => [x.nombre, x.ventaNetaUsd.toFixed(2), x.costoUsd.toFixed(2), x.margenUsd.toFixed(2), x.margenPct])).toEqual([
      ['Repuestos Lara, C.A.', '960.00', '312.00', '648.00', '67.50'],
      ['Autopartes Sur, C.A.', '200.00', '65.00', '135.00', '67.50'],
      ['Frenos del Centro, C.A.', '100.00', '32.50', '67.50', '67.50'],
    ]);
  });

  it('cualquier dimensión suma el mismo total', async () => {
    const t = await rentabilidadTotal(db, ...rango());
    for (const dim of ['cliente', 'producto', 'grupo', 'marca', 'vendedor', 'sucursal'] as const) {
      const f = await rentabilidadPor(db, dim, ...rango());
      expect(f.reduce((s, x) => s.plus(x.ventaNetaUsd), t.ventaNetaUsd.minus(t.ventaNetaUsd)).toFixed(2), dim).toBe(t.ventaNetaUsd.toFixed(2));
      expect(f.reduce((s, x) => s.plus(x.margenUsd), t.margenUsd.minus(t.margenUsd)).toFixed(2), dim).toBe(t.margenUsd.toFixed(2));
    }
    const prod = await rentabilidadPor(db, 'producto', ...rango());
    expect(prod.map((x) => [x.codigo, x.margenUsd.toFixed(2)])).toEqual([['AC-001', '850.50']]);
    const ven = await rentabilidadPor(db, 'vendedor', ...rango());
    expect(ven.map((x) => [x.nombre, x.ventaUsd.toFixed(2)])).toEqual([['Pedro Pérez', '1500.00']]);
    expect((await rentabilidadPor(db, 'grupo', ...rango()))[0].nombre).toBe('Sin grupo');
  });

  it('cuadra con el estado de resultados: la misma venta neta y el mismo costo de ventas del mayor', async () => {
    const t = await rentabilidadTotal(db, ...rango());
    const mes = Number(hoy().slice(5, 7));
    const e = await estadosDelMes(db, anioActual, mes);
    const r = e.resultados.acumuladoAnio;
    expect(r.ventasNetas.usd.toFixed(2)).toBe(t.ventaNetaUsd.toFixed(2));
    expect(r.costoVentas.total.usd.toFixed(2)).toBe(t.costoUsd.toFixed(2));
    expect(r.utilidadBruta.usd.toFixed(2)).toBe(t.margenUsd.toFixed(2));
  });

  it('un rango sin ventas da ceros y margen sin porcentaje; un rango o dimensión inválidos se rechazan', async () => {
    const t = await rentabilidadTotal(db, '2000-01-01', '2000-12-31');
    expect([t.ventaNetaUsd.toFixed(2), t.margenUsd.toFixed(2), t.margenPct]).toEqual(['0.00', '0.00', null]);
    expect(await rentabilidadPor(db, 'cliente', '2000-01-01', '2000-12-31')).toEqual([]);
    await expect(rentabilidadPor(db, 'cliente', '2026-02-01', '2026-01-01')).rejects.toThrow('no puede ser anterior');
    await expect(rentabilidadPor(db, 'cliente', 'ayer', '2026-01-01')).rejects.toThrow('rango de fechas válido');
    await expect(rentabilidadPor(db, 'color' as never, ...rango())).rejects.toThrow('dimensión válida');
  });

  it('las cifras derivadas usan decimales exactos y no dividen entre cero', () => {
    const c = cifrasDe({ venta: '100.10', desc_linea: '5.00', devolucion: '10.00', desc_post: '0.05', pronto: '0.05', costo: '60.00', comision: '3.00' });
    expect([c.ventaNetaUsd.toFixed(2), c.margenUsd.toFixed(2), c.margenPct]).toEqual(['90.00', '27.00', '30.00']);
    expect(cifrasDe({ venta: '0', desc_linea: '0', devolucion: '0', desc_post: '0', pronto: '0', costo: '5', comision: '0' }).margenPct).toBeNull();
  });
});
