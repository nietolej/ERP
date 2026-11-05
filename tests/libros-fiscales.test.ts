import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import { crearFactura, guardarLinea, registrarFactura } from '@/lib/compras/facturas';
import { crearNota } from '@/lib/compras/notas-proveedor';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea as lineaOrden, type Usuario as UsuarioCompra } from '@/lib/compras/ordenes';
import { recibirMercancia } from '@/lib/compras/recepciones';
import type { Db } from '@/lib/db/tipos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { libroCompras, libroVentas, validarPeriodo } from '@/lib/fiscal/libros';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { crearGastoProveedor } from '@/lib/gastos/gastos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { anularFactura, facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Libros de ventas y de compras (spec §11.4; migración 0044). Tasa: USD a Bs 40; IVA general de 16 %.
 */
describe('libros fiscales: ventas y compras (R-CT a R-CW)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let gerente: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let comprador: UsuarioCompra;
  let mostrador = '';
  let a01 = '';
  let anio = 0;
  let mes = 0;
  let general = '';
  let hoy = '';
  let n = 0;

  const como = <T,>(u: { id: string }, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const suma = (filas: { base_ves?: string; iva_ves?: string }[], campo: 'base_ves' | 'iva_ves') => filas.reduce((s, f) => s + Number(f[campo]), 0);

  async function facturar(cliente: string, lineas: [string, string][]) {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    for (const [p, c] of lineas) await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: p, cantidad: c }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const { rows } = await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [f.facturaId]);
    return { id: f.facturaId, linea: rows[0].id };
  }

  const ventasFix: Record<string, { id: string; linea: string }> = {};
  const compra: { factura?: { id: string; linea: string }; gastoA?: string; gastoB?: string; nota?: string } = {};

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;
    const ids = {
      ger: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']),
      ven: await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']),
      sup: await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']),
      fac: await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']),
      alm: await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']),
      com: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']),
    };
    gerente = { id: ids.ger, roles: ['gerencia'] };
    ventas = { id: ids.ven, roles: ['ventas'] };
    supervisor = { id: ids.sup, roles: ['supervisor_ventas'] };
    facturacion = { id: ids.fac, roles: ['facturacion'] };
    almacenista = { id: ids.alm, roles: ['almacen'] };
    comprador = { id: ids.com, roles: ['compras'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_retencion_iva, agente_retencion_islr) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', true, false)`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const f = (await db.query<{ hoy: string; a: number; m: number }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as hoy, extract(year from (now() at time zone 'America/Caracas'))::int as a, extract(month from (now() at time zone 'America/Caracas'))::int as m`)).rows[0];
    hoy = f.hoy; anio = f.a; mes = f.m;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40.000000)`, [hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Compras', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction(async (tx) => { await asignarUsuarios(tx, mostrador, [ids.alm]); await asignarUsuarios(tx, a01, [ids.alm]); });
    const vend = await db.transaction((tx) => crearVendedor(tx, ids.ger, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: ids.ven }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, ids.fac, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, ids.ger, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    const clienteA = await cliente('J-00000010-7', 'Repuestos Lara, C.A.');

    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string, precio: string, costo: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      const id = await db.transaction((tx) => crearProducto(tx, ids.alm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
      await db.transaction((tx) => fijarPrecio(tx, id, 'B', precio, hoy));
      await como(almacenista, (tx) => tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
         values ('entrada_compra', $1, $2, 500, $3, 'prueba', gen_random_uuid())`, [id, mostrador, costo]));
      return id;
    };
    const aceite = await nuevo('AC-001', exento, '20.00', '6.50');        // exento
    const pastilla = await nuevo('PF-001', general, '10.00', '4.00');     // IVA general

    // ---- Ventas: f1 exenta Bs 800 · f2 gravada Bs 4.000 + 640 · f3 anulada · NC de 3 unidades de f2 (Bs 1.200 + 192)
    ventasFix.f1 = await facturar(clienteA, [[aceite, '1']]);
    ventasFix.f2 = await facturar(clienteA, [[pastilla, '10']]);
    ventasFix.f3 = await facturar(clienteA, [[pastilla, '2']]);
    await como(facturacion, (tx) => anularFactura(tx, facturacion, ventasFix.f3.id, { motivoId: OTRO, detalle: 'Error de captura' }, { servicio: new ImprentaSimulada() }));
    const nc = await como(ventas, (tx) => crearNotaCredito(tx, ventas, { facturaId: ventasFix.f2.id, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: ventasFix.f2.linea, cantidad: '3' }] }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, nc));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', nc, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, nc, { servicio: new ImprentaSimulada() }));

    // ---- Compras: un proveedor normal y una factura de mercancía con IVA, una nota de crédito y dos gastos
    const n8 = '66660001';
    const prov = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: 'Proveedora de Repuestos, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, prov.id, ids.ger, cr30));
    const orden = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: prov.id, almacenId: a01, moneda: 'USD' }));
    await como(comprador, (tx) => lineaOrden(tx, orden, { productoId: pastilla, cantidad: '100', precio: '4.0000' }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, orden));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', orden, gerente.id, 'aprobada'));
    const [lo] = (await detalleOrden(db, orden))!.lineas;
    await como(almacenista, (tx) => recibirMercancia(tx, almacenista, orden, [{ lineaId: lo.id, cantidad: '100' }]));
    const fid = await como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: orden, numeroFactura: 'FC-100', numeroControl: '00-100', fechaFactura: hoy }));
    await como(comprador, (tx) => guardarLinea(tx, fid, { ordenLineaId: lo.id, cantidad: '100', precio: '4.0000' }));
    await como(comprador, (tx) => registrarFactura(tx, comprador, fid));        // US$ 400 + 64 de IVA → Bs 16.000 + 2.560; retiene 75 % del IVA
    const fl = (await db.query<{ id: string }>('select id from factura_compra_linea where factura_id = $1', [fid])).rows[0].id;
    compra.factura = { id: fid, linea: fl };
    const nota = await como(comprador, (tx) => crearNota(tx, comprador, {
      facturaId: fid, tipo: 'nota_credito', clase: 'ajuste_precio', numeroDocumento: 'NC-P-1', numeroControl: '00-901', fecha: hoy, motivo: 'Descuento por volumen',
      lineas: [{ facturaLineaId: fl, monto: '40.00' }],                          // base US$ 40 + IVA 6,40 → Bs 1.600 + 256
    }));
    await como(gerente, (tx) => resolverAprobacion(tx, 'nota_proveedor', nota.id, gerente.id, 'aprobada'));
    compra.nota = nota.id;

    const almacen = almacenEnDisco(await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'libros-')));
    const soporte = () => ({ almacen, nombre: `s${++n}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% ${n}\n`) });
    const categoria = async (codigo: string) => (await db.query<{ id: string }>('select id from categoria_gasto where codigo = $1', [codigo])).rows[0].id;
    const gasto = async (cat: string, base: string, numero: string) => {
      const g = await como(comprador, (tx) => crearGastoProveedor(tx, comprador, {
        proveedorId: prov.id, categoriaId: cat, descripcion: 'Gasto de prueba', numeroFactura: numero, numeroControl: `00-${numero}`, fechaFactura: hoy, moneda: 'VES', base, alicuotaIvaId: general,
      }, soporte()));
      await como(gerente, (tx) => resolverAprobacion(tx, 'gasto_proveedor', g.id, gerente.id, 'aprobada'));
      return g.id;
    };
    compra.gastoA = await gasto(await categoria('ALQUILER'), '1000.00', 'GA-1');                    // IVA 160 con crédito fiscal
    compra.gastoB = await gasto(await categoria('COMISIONES_BANCARIAS'), '200.00', 'GB-1');         // IVA 32 sin crédito fiscal
    void OTRO;
  });
  afterAll(() => cerrar());

  describe('libro de ventas', () => {
    it('lista facturas, la nota de crédito (resta) y la anulada marcada, con número de control', async () => {
      const l = await libroVentas(db, anio, mes);
      expect(l.filas).toHaveLength(4);                                     // f1, f2, f3 (anulada) y la nota de crédito; la nota de entrega no entra
      expect(l.filas.every((f) => f.numero_control)).toBe(true);
      const nota = l.filas.filter((f) => f.tipo === 'nota_credito');
      expect(nota.map((f) => [f.base_ves, f.iva_ves, f.documento_afectado !== null])).toEqual([['-1200.00', '-192.00', true]]);
      const anulada = l.filas.filter((f) => f.estado === 'anulado');
      expect(anulada).toHaveLength(1);
      expect(anulada[0].incluido).toBe(false);
      expect(anulada[0].fecha_anulacion).toBe(hoy);
    });

    it('el resumen separa por alícuota, no suma lo anulado y da el débito fiscal', async () => {
      const l = await libroVentas(db, anio, mes);
      const gen = l.resumen.find((r) => Number(r.alicuota_pct) === 16)!;
      const exe = l.resumen.find((r) => Number(r.alicuota_pct) === 0)!;
      expect([gen.base, gen.iva]).toEqual(['2800.00', '448.00']);       // 4.000 − 1.200 · 640 − 192
      expect([exe.base, exe.iva, exe.tipo_libro]).toEqual(['800.00', '0.00', 'exenta']);
      expect(l.debito).toBe('448.00');
      expect(l.base).toBe('3600.00');
      expect(suma(l.filas.filter((f) => f.incluido), 'iva_ves')).toBe(448);
    });

    it('otro mes sale vacío y un periodo inválido se rechaza', async () => {
      const otro = mes === 1 ? 2 : mes - 1;
      expect((await libroVentas(db, anio, otro)).filas).toEqual([]);
      expect(() => validarPeriodo(anio, 13)).toThrow('mes y un año válidos');
      await esperarError(libroVentas(db, 1999, 5), 'mes y un año válidos');
    });
  });

  describe('libro de compras', () => {
    it('reúne la factura de mercancía, los gastos y la nota de crédito del proveedor (resta)', async () => {
      const l = await libroCompras(db, anio, mes);
      expect(l.filas.map((f) => f.origen).sort()).toEqual(['factura', 'gasto', 'gasto', 'nota']);
      const nota = l.filas.find((f) => f.origen === 'nota')!;
      expect([nota.tipo, nota.base_ves, nota.iva_ves, nota.documento_afectado]).toEqual(['nota_credito', '-1600.00', '-256.00', 'FC-100']);
      const fact = l.filas.find((f) => f.origen === 'factura')!;
      expect([fact.base_ves, fact.iva_ves, fact.credito_ves, fact.numero_control]).toEqual(['16000.00', '2560.00', '2560.00', '00-100']);
    });

    it('el IVA de un gasto sin derecho a crédito se muestra pero no suma al crédito fiscal', async () => {
      const l = await libroCompras(db, anio, mes);
      const b = l.filas.find((f) => f.documento_id === compra.gastoB)!;
      expect([b.base_ves, b.iva_ves, b.credito_ves]).toEqual(['200.00', '32.00', '0.00']);
      const a = l.filas.find((f) => f.documento_id === compra.gastoA)!;
      expect([a.iva_ves, a.credito_ves]).toEqual(['160.00', '160.00']);
      // Crédito = 2.560 − 256 + 160 + 0
      expect(l.credito).toBe('2464.00');
      expect(l.base).toBe('15600.00');                                     // 16.000 − 1.600 + 1.000 + 200
    });

    it('las retenciones practicadas aparecen una sola vez por documento y la nota de crédito resta lo retenido', async () => {
      const l = await libroCompras(db, anio, mes);
      const fact = l.filas.find((f) => f.origen === 'factura')!;
      const nota = l.filas.find((f) => f.origen === 'nota')!;
      expect(fact.retencion_iva_ves).toBe('1920.00');                      // 75 % de 2.560
      expect(nota.retencion_iva_ves).toBe('-192.00');                      // 75 % de 256
      expect(l.retencionIva).toBe('1872.00');                              // 1.920 − 192 + 120 y 24 de los dos gastos (75 % de su IVA)
      expect(l.retencionIslr).toBe('0.00');
    });

    it('el resumen por alícuota cuadra con el total del libro', async () => {
      const l = await libroCompras(db, anio, mes);
      const base = l.resumen.reduce((s, r) => s + Number(r.base), 0);
      const credito = l.resumen.reduce((s, r) => s + Number(r.credito), 0);
      expect([base.toFixed(2), credito.toFixed(2)]).toEqual([l.base, l.credito]);
    });
  });
});
