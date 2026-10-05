import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import {
  agregarLinea, anularNotaEntrega, anularPedido, buscarDocumentos, cambiarLinea, crearPedido, detalleDocumento, eliminarBorrador,
  emitirPedido, generarNotaEntrega, quitarLinea, reservarExistencia, type Usuario,
} from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

let MOTIVO_OTRO = '';
const motivoOtro = (detalle: string) => ({ motivoId: MOTIVO_OTRO, detalle });

describe('inventario: movimientos, costo promedio y reservas (§8, R-AG a R-AI, R-AK)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let usuario: string;
  let comercial: string;
  let transito: string;
  let producto: string;
  let servicio: string;

  const mover = (tipo: string, cantidad: string, costo: string | null, almacen = comercial, prod = producto) =>
    db.transaction(async (tx) => {
      await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
      await tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
         values ($1, $2, $3, $4, coalesce($5::numeric, 0), 'prueba', gen_random_uuid())`, [tipo, prod, almacen, cantidad, costo]);
    });
  const existencia = async (almacen = comercial, prod = producto) =>
    (await db.query<{ cantidad: string; reservado: string }>(
      'select cantidad::text, reservado::text from existencia where producto_id = $1 and almacen_id = $2', [prod, almacen])).rows[0];
  const costo = async (prod = producto) =>
    (await db.query<{ cantidad: string; valor_usd: string; costo_promedio_usd: string }>(
      'select cantidad::text, valor_usd::text, costo_promedio_usd::text from producto_costo where producto_id = $1', [prod])).rows[0];

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    usuario = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    comercial = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    transito = await db.transaction((tx) => crearAlmacen(tx, 'TRANS', { nombre: 'Tránsito', sucursalId: sucursal, esComercial: false, permiteVenta: false }));
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, inventariable: boolean) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, usuario, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable,
      }));
    };
    producto = await nuevo('F-1', true);
    servicio = await nuevo('SERV-1', false);
  });
  afterAll(() => cerrar());

  it('una entrada recalcula el costo promedio ponderado de toda la empresa; una salida lo conserva', async () => {
    await mover('entrada_compra', '10', '2.00');
    expect(await costo()).toEqual({ cantidad: '10.0000', valor_usd: '20.00', costo_promedio_usd: '2.0000' });
    await mover('entrada_compra', '10', '4.00', transito);               // otro almacén, mismo promedio de empresa
    expect(await costo()).toEqual({ cantidad: '20.0000', valor_usd: '60.00', costo_promedio_usd: '3.0000' });
    await mover('salida_venta', '-5', null);
    expect(await costo()).toEqual({ cantidad: '15.0000', valor_usd: '45.00', costo_promedio_usd: '3.0000' });
    const { rows } = await db.query<{ costo_unitario_usd: string; costo_total_usd: string }>(
      `select costo_unitario_usd::text, costo_total_usd::text from movimiento_inventario where tipo = 'salida_venta'`);
    expect(rows[0]).toEqual({ costo_unitario_usd: '3.0000', costo_total_usd: '-15.00' });
    expect(await existencia()).toEqual({ cantidad: '5.0000', reservado: '0.0000' });
  });

  it('la salida que vacía el producto se lleva todo su valor: no quedan centavos huérfanos', async () => {
    await mover('entrada_compra', '3', '0.3333', comercial);              // valor 1.00 (3 × 0.3333 = 0.9999 → 1.00)
    await mover('salida_venta', '-4', null);                               // deja 4 en comercial y 10 en tránsito
    await mover('salida_venta', '-4', null);
    await mover('salida_venta', '-10', null, transito);
    const c = await costo();
    expect(c.cantidad).toBe('0.0000');
    expect(c.valor_usd).toBe('0.00');
  });

  it('un almacén comercial no admite existencia negativa (R-AI); uno que no lo es, sí', async () => {
    await esperarError(mover('salida_venta', '-1', null), 'negativo');
    await mover('salida_venta', '-2', null, transito);
    expect((await existencia(transito)).cantidad).toBe('-2.0000');
  });

  it('un movimiento no se edita ni se borra, y la existencia no se toca a mano (R-AG)', async () => {
    await esperarError(db.query(`update movimiento_inventario set cantidad = 99`), 'no se modifica ni se borra');
    await esperarError(db.query('delete from movimiento_inventario'), 'no se modifica ni se borra');
    await esperarError(db.query(`update existencia set cantidad = 99`), 'solo cambia con un movimiento');
    await esperarError(db.query(`update existencia set reservado = 1`), 'solo cambia con un movimiento');
    await esperarError(db.query('delete from existencia'), 'no se borra');
  });

  it('los productos no inventariables no tienen movimientos y el signo debe corresponder al tipo', async () => {
    await esperarError(mover('entrada_compra', '1', '1', comercial, servicio), 'inventariables');
    await esperarError(mover('entrada_compra', '-1', '1'), 'violates check constraint');
    await esperarError(mover('salida_venta', '1', '1'), 'violates check constraint');
  });
});

describe('pedidos y notas de entrega (§6.1, §6.2)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente: string;
  let supervisor: string;
  let ventas: Usuario;
  let otroVentas: Usuario;
  let facturacion: Usuario;
  let almacenista: string;
  let sucursal: string;
  let almacen: string;
  let vendedor: { id: string };
  let contado: string;       // cliente de contado
  let credito: string;       // cliente a crédito con límite
  let ajeno: string;         // cliente de otro vendedor
  let pastilla: string;      // US$ 10 lista B, IVA general
  let aceite: string;        // US$ 20 lista B, exento
  let servicio: string;      // sin inventario

  const hoy = () => db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`).then((r) => r.rows[0].d);
  const como = <T,>(usuario: string, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  const stock = (prod: string, cantidad: string, costo = '4.00') => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('entrada_compra', $1, $2, $3, $4, 'prueba', gen_random_uuid())`, [prod, almacen, cantidad, costo]));
  const existencia = async (prod: string) =>
    (await db.query<{ cantidad: string; reservado: string }>(
      'select cantidad::text, reservado::text from existencia where producto_id = $1 and almacen_id = $2', [prod, almacen])).rows[0];
  const pedido = async (u: Usuario, cliente: string, lineas: [string, string][]): Promise<string> => {
    const id = await como(u.id, (tx) => crearPedido(tx, u, { clienteId: cliente, almacenId: almacen }));
    for (const [p, c] of lineas) await como(u.id, (tx) => agregarLinea(tx, u, id, { productoId: p, cantidad: c }));
    return id;
  };
  const emitir = (u: Usuario, id: string) => como(u.id, (tx) => emitirPedido(tx, u, id));
  const doc = async (id: string) => (await detalleDocumento(db, id))!;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    MOTIVO_OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    supervisor = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    almacenista = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idVentas = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idOtro = await usuarioDePrueba(db, 'ventas2@prueba.test', ['ventas']);
    const idFact = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    ventas = { id: idVentas, roles: ['ventas'] };
    otroVentas = { id: idOtro, roles: ['ventas'] };
    facturacion = { id: idFact, roles: ['facturacion'] };

    sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    almacen = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);

    vendedor = await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVentas }));
    const otro = await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Ana Gómez', tipo: 'interno', usuarioId: idOtro }));

    const cliente = async (rif: string, nombre: string, vend: string, condicion: string, limite: string, descuento = '0') => {
      const c = await db.transaction((tx) => crearCliente(tx, idFact, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
        comercial: { vendedorId: vend },
      }));
      const cond = (await db.query<{ id: string }>('select id from condicion_pago where codigo = $1', [condicion])).rows[0].id;
      await db.transaction((tx) => aprobarCliente(tx, c.id, gerente, { condicionPagoId: cond, limiteCreditoUsd: limite, nivelPrecio: 'B', descuentoPct: descuento }));
      return c.id;
    };
    contado = await cliente('J-12345678-4', 'Repuestos Lara, C.A.', vendedor.id, 'CONTADO', '0');
    credito = await cliente('J-00000010-7', 'Frenos del Centro, C.A.', vendedor.id, 'CR30', '100');
    ajeno = await cliente('J-00000020-4', 'Autopartes Sur, C.A.', otro.id, 'CR30', '5000');

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string, inventariable: boolean) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, almacenista, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable,
      }));
    };
    pastilla = await nuevo('PF-001', general, true);
    aceite = await nuevo('AC-001', exento, true);
    servicio = await nuevo('SERV-001', general, false);
    const fecha = await hoy();
    await db.transaction(async (tx) => {
      await fijarPrecio(tx, pastilla, 'B', '10.00', fecha);
      await fijarPrecio(tx, aceite, 'B', '20.00', fecha);
      await fijarPrecio(tx, servicio, 'B', '5.00', fecha);
    });
    await stock(pastilla, '10');
    await stock(aceite, '2');
  });
  afterAll(() => cerrar());

  it('el precio sale de la lista del cliente y los totales se calculan con la alícuota vigente', async () => {
    const id = await pedido(ventas, contado, [[pastilla, '3'], [aceite, '1']]);
    const d = await doc(id);
    expect(d.estado).toBe('borrador');
    expect(d.numero).toBeNull();
    const [l1, l2] = d.lineas;
    expect([l1.precio_unitario, l1.base, l1.iva, l1.total]).toEqual(['10.0000', '30.00', '4.80', '34.80']);
    expect([l2.precio_unitario, l2.base, l2.iva, l2.total]).toEqual(['20.0000', '20.00', '0.00', '20.00']);
    expect([d.subtotal, d.base_imponible, d.exento, d.iva, d.total]).toEqual(['50.00', '30.00', '20.00', '4.80', '54.80']);
    expect(d.tasa).toBe('40.000000');
    expect(d.total_ves).toBe('2192.00');
  });

  it('el descuento del cliente y el de la línea se aplican por línea y se redondean a centavos', async () => {
    const id = await pedido(ventas, contado, [[pastilla, '3']]);
    const linea = (await doc(id)).lineas[0].id;
    const volumen = (await db.query<{ id: string }>(`select id from motivo where tipo = 'descuento' and codigo = 'VOLUMEN'`)).rows[0].id;
    await esperarError(como(ventas.id, (tx) => cambiarLinea(tx, ventas, id, linea, { cantidad: '7', descuentoPct: '12.5' })), 'motivo del descuento');
    await como(ventas.id, (tx) => cambiarLinea(tx, ventas, id, linea, { cantidad: '7', descuentoPct: '12.5', motivoDescuentoId: volumen }));
    const d = await doc(id);
    // 7 × 10 = 70; 12,5 % = 8,75; base 61,25; IVA 16 % = 9,80
    expect([d.lineas[0].base, d.lineas[0].iva, d.total]).toEqual(['61.25', '9.80', '71.05']);
    await como(ventas.id, (tx) => quitarLinea(tx, ventas, id, linea));
    expect((await doc(id)).total).toBe('0.00');
    await como(ventas.id, (tx) => eliminarBorrador(tx, ventas, id));
    expect(await detalleDocumento(db, id)).toBeNull();
  });

  it('valida cliente activo, almacén de venta, precio vigente, producto repetido y cantidades', async () => {
    const pendiente = await db.transaction(async (tx) => {
      const c = await crearCliente(tx, facturacion.id, {
        rif: 'J-00000030-1', tercero: { razonSocial: 'Cliente nuevo, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
        comercial: { vendedorId: vendedor.id },
      });
      return c.id;
    });
    await esperarError(como(facturacion.id, (tx) => crearPedido(tx, facturacion, { clienteId: pendiente, almacenId: almacen })), 'clientes activos');
    const id = await pedido(ventas, contado, []);
    await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '0' })), 'mayor que cero');
    await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '1.00001' })), 'mayor que cero');
    await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '1', descuentoPct: '101' })), 'entre 0 y 100');
    await como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '1' }));
    await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '1' })), 'ya está en el pedido');
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const baseSP = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-SP', { descripcion: 'Artículo sin precio' }));
    const marcaSP = (await db.query<{ id: string }>(`select id from marca limit 1`)).rows[0].id;
    const sinPrecio = await db.transaction((tx) => crearProducto(tx, almacenista, 'SP-1', {
      descripcion: 'Sin precio vigente', productoBaseId: baseSP.id, marcaId: marcaSP, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
    await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: sinPrecio, cantidad: '1' })), 'no tiene precio vigente');
    await como(ventas.id, (tx) => eliminarBorrador(tx, ventas, id));
  });

  it('emitir asigna el número correlativo, guarda la tasa y congela el documento (R-AJ)', async () => {
    const a = await pedido(ventas, contado, [[pastilla, '1']]);
    const b = await pedido(ventas, contado, [[pastilla, '1']]);
    expect((await emitir(ventas, a)).situacion).toBe('aprobado');
    expect((await emitir(ventas, b)).situacion).toBe('aprobado');
    const da = await doc(a);
    const dbb = await doc(b);
    expect(Number(dbb.numero)).toBe(Number(da.numero) + 1);
    expect(da.estado).toBe('emitido');
    expect(da.tasa).toBe('40.000000');
    await esperarError(db.query(`update documento_venta set total = 1 where id = $1`, [a]), 'no se edita');
    await esperarError(db.query(`update documento_venta_linea set cantidad = 9 where documento_id = $1`, [a]), 'no se modifican');
    await esperarError(db.query(`delete from documento_venta where id = $1`, [a]), 'no se borra');
    await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, a, { productoId: aceite, cantidad: '1' })), 'borrador');
    await esperarError(db.query(`update documento_venta set estado = 'borrador' where id = $1`, [a]), 'no vuelve a borrador');
    await como(ventas.id, (tx) => anularPedido(tx, ventas, a, motivoOtro('Cliente desistió')));
    await como(ventas.id, (tx) => anularPedido(tx, ventas, b, motivoOtro('Cliente desistió')));
  });

  it('un pedido emitido se anula con motivo y libera su reserva; uno anulado no se toca', async () => {
    const antes = await existencia(pastilla);
    const id = await pedido(ventas, contado, [[pastilla, '4']]);
    await emitir(ventas, id);
    expect((await existencia(pastilla)).reservado).toBe(`${(Number(antes.reservado) + 4).toFixed(4)}`);
    await esperarError(como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro(' '))), 'motivo');
    await como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('Error de digitación')));
    expect(await existencia(pastilla)).toEqual(antes);
    const d = await doc(id);
    expect(d.estado).toBe('anulado');
    expect(d.anulado_motivo).toBe('Otro motivo (explicar): Error de digitación');
    await esperarError(db.query(`update documento_venta set observaciones = 'x' where id = $1`, [id]), 'anulado no se modifica');
  });

  it('reserva lo disponible, registra la demanda no atendida y no deja reservar de más (R-AI)', async () => {
    // Hay 2 de aceite y se piden 5: reserva 2 y registra 3 como demanda no atendida.
    const id = await pedido(ventas, contado, [[aceite, '5']]);
    await emitir(ventas, id);
    const d = await doc(id);
    expect(d.lineas[0].reservado).toBe('2.0000');
    expect(await existencia(aceite)).toEqual({ cantidad: '2.0000', reservado: '2.0000' });
    const { rows } = await db.query<{ cantidad: string }>('select cantidad::text from demanda_no_atendida where documento_id = $1', [id]);
    expect(rows).toEqual([{ cantidad: '3.0000' }]);

    // Otro pedido del mismo producto no encuentra nada disponible.
    const otro = await pedido(ventas, contado, [[aceite, '1']]);
    await emitir(ventas, otro);
    expect((await doc(otro)).lineas[0].reservado).toBe('0.0000');
    expect(await existencia(aceite)).toEqual({ cantidad: '2.0000', reservado: '2.0000' });

    // Al llegar mercancía se puede reservar el saldo, sin repetir la demanda ya registrada.
    await stock(aceite, '10');
    const r = await como(ventas.id, (tx) => reservarExistencia(tx, id, { registrarDemanda: false }));
    expect(r.faltante).toBe(0);
    expect((await doc(id)).lineas[0].reservado).toBe('5.0000');
    expect((await db.query('select 1 from demanda_no_atendida where documento_id = $1', [id])).rows).toHaveLength(1);

    // Un movimiento que dejaría la existencia por debajo de lo reservado se rechaza.
    await esperarError(como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('ajuste_negativo', $1, $2, -10, 0, 'prueba', gen_random_uuid())`, [aceite, almacen])), 'por debajo de lo reservado');
    await como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('Prueba')));
    await como(ventas.id, (tx) => anularPedido(tx, ventas, otro, motivoOtro('Prueba')));
  });

  it('los productos sin inventario no reservan ni generan demanda', async () => {
    const id = await pedido(ventas, contado, [[servicio, '2']]);
    await emitir(ventas, id);
    expect((await db.query('select 1 from reserva_inventario where pedido_id = $1', [id])).rows).toHaveLength(0);
    expect((await db.query('select 1 from demanda_no_atendida where documento_id = $1', [id])).rows).toHaveLength(0);
    await como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('Prueba')));
  });

  describe('crédito (§6.2, regla 2)', () => {
    it('un pedido de cliente a crédito dentro de su límite se aprueba solo; uno que lo excede queda retenido', async () => {
      const ok = await pedido(ventas, credito, [[pastilla, '5']]);                // 5 × 10 × 1,16 = US$ 58
      expect((await emitir(ventas, ok)).situacion).toBe('aprobado');
      const excede = await pedido(ventas, credito, [[pastilla, '5']]);            // otros 58: 116 > 100
      const r = await emitir(ventas, excede);
      expect(r.situacion).toBe('retenido_credito');
      expect(r.motivo).toContain('116.00');
      const d = await doc(excede);
      expect(d.situacion).toBe('retenido_credito');
      expect(d.lineas[0].reservado).toBe('0.0000');                                // sin reserva hasta que Gerencia decida

      expect(await puedeDecidirObjeto(db, gerente, 'pedido_credito', excede)).toBe(true);
      expect(await puedeDecidirObjeto(db, supervisor, 'pedido_credito', excede)).toBe(false);
      await esperarError(como(supervisor, (tx) => resolverAprobacion(tx, 'pedido_credito', excede, supervisor, 'aprobada')), 'rol');
      await como(gerente, (tx) => resolverAprobacion(tx, 'pedido_credito', excede, gerente, 'aprobada'));
      const aprobado = await doc(excede);
      expect(aprobado.situacion).toBe('aprobado');
      expect(aprobado.lineas[0].reservado).toBe('5.0000');
      const { rows } = await db.query<{ aprobado_por: string | null }>('select aprobado_por from documento_venta where id = $1', [excede]);
      expect(rows[0].aprobado_por).toBe(gerente);

      await como(ventas.id, (tx) => anularPedido(tx, ventas, ok, motivoOtro('Prueba')));
      await como(ventas.id, (tx) => anularPedido(tx, ventas, excede, motivoOtro('Prueba')));
    });

    it('si Gerencia rechaza el pedido retenido, se anula con su motivo y no reserva', async () => {
      const grande = await pedido(ventas, credito, [[pastilla, '9']]);            // 9 × 10 × 1,16 = 104,40 > 100
      expect((await emitir(ventas, grande)).situacion).toBe('retenido_credito');
      await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'pedido_credito', grande, gerente, 'rechazada')), 'motivo');
      await como(gerente, (tx) => resolverAprobacion(tx, 'pedido_credito', grande, gerente, 'rechazada', { comentario: 'Cliente con deuda' }));
      const d = await doc(grande);
      expect(d.estado).toBe('anulado');
      expect(d.anulado_motivo).toBe('Rechazado por crédito: Cliente con deuda');
      expect(d.lineas[0].reservado).toBe('0.0000');
    });

    it('lo ya comprometido (pedidos aprobados y notas de entrega) cuenta contra el límite', async () => {
      const uno = await pedido(ventas, credito, [[pastilla, '6']]);               // 69,60
      expect((await emitir(ventas, uno)).situacion).toBe('aprobado');
      expect((await detalleDocumento(db, uno))!.exposicion).toBe('69.60');
      const nota = await como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, uno));
      expect((await detalleDocumento(db, uno))!.exposicion).toBe('69.60');         // ahora está en la nota, no se cuenta dos veces
      const dos = await pedido(ventas, credito, [[pastilla, '3']]);               // 34,80 → 104,40 > 100
      expect((await emitir(ventas, dos)).situacion).toBe('retenido_credito');
      await como(gerente, (tx) => resolverAprobacion(tx, 'pedido_credito', dos, gerente, 'rechazada', { comentario: 'No procede' }));
      await como(ventas.id, (tx) => anularNotaEntrega(tx, ventas, nota, motivoOtro('Prueba')));
      await como(ventas.id, (tx) => anularPedido(tx, ventas, uno, motivoOtro('Prueba')));
    });

    it('un cliente de contado no usa el límite de crédito', async () => {
      const id = await pedido(ventas, contado, [[pastilla, '8']]);                // límite 0, pero se paga al entregar
      expect((await emitir(ventas, id)).situacion).toBe('aprobado');
      await como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('Prueba')));
    });
  });

  describe('nota de entrega (§6)', () => {
    it('toma lo reservado, conserva precios e IVA del pedido y deja la mercancía "en nota"', async () => {
      const id = await pedido(ventas, contado, [[pastilla, '4'], [aceite, '3']]);
      await emitir(ventas, id);
      const antes = await existencia(aceite);
      const notaId = await como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, id));
      const nota = await doc(notaId);
      expect(nota.tipo).toBe('nota_entrega');
      expect(nota.estado).toBe('emitido');
      expect(nota.origen_id).toBe(id);
      expect(nota.lineas.map((l) => [l.codigo, l.cantidad, l.precio_unitario, l.iva])).toEqual([
        ['PF-001', '4.0000', '10.0000', '6.40'],
        ['AC-001', '3.0000', '20.0000', '0.00'],
      ]);
      expect(nota.total).toBe('106.40');
      // La reserva sigue vigente (ya no está "activa", está "en nota") y no hay otra para entregar.
      expect(await existencia(aceite)).toEqual(antes);
      await esperarError(como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, id)), 'no tiene existencia reservada');
      const { rows } = await db.query<{ estado: string }>('select distinct estado from reserva_inventario where pedido_id = $1', [id]);
      expect(rows).toEqual([{ estado: 'en_nota' }]);
      expect((await doc(id)).notas.map((n) => n.id)).toEqual([notaId]);
      await esperarError(como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('x1x'))), 'notas de entrega vigentes');

      // Anular la nota devuelve la mercancía a reserva del pedido y permite generar otra.
      await como(ventas.id, (tx) => anularNotaEntrega(tx, ventas, notaId, motivoOtro('Se emitió por error')));
      expect((await doc(notaId)).estado).toBe('anulado');
      const otraNota = await como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, id));
      expect((await doc(otraNota)).total).toBe('106.40');
      await como(ventas.id, (tx) => anularNotaEntrega(tx, ventas, otraNota, motivoOtro('Prueba')));
      await como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('Prueba')));
    });

    it('una nota tiene su propio número correlativo y no se edita', async () => {
      const id = await pedido(ventas, contado, [[pastilla, '1']]);
      await emitir(ventas, id);
      const n1 = await como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, id));
      const d1 = await doc(n1);
      await esperarError(db.query(`update documento_venta set total = 1 where id = $1`, [n1]), 'no se edita');
      await esperarError(db.query(`delete from documento_venta where id = $1`, [n1]), 'no se borra');
      await esperarError(db.query(`insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, created_by)
        values ('nota_entrega', $1, $2, $3, $4)`, [sucursal, almacen, contado, gerente]), 'violates check constraint');
      expect(d1.numero).toMatch(/^\d+$/);
      await como(ventas.id, (tx) => anularNotaEntrega(tx, ventas, n1, motivoOtro('Prueba')));
      await como(ventas.id, (tx) => anularPedido(tx, ventas, id, motivoOtro('Prueba')));
    });

    it('solo se entrega un pedido aprobado y emitido', async () => {
      const borrador = await pedido(ventas, contado, [[pastilla, '1']]);
      await esperarError(como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, borrador)), 'pedido aprobado');
      await como(ventas.id, (tx) => eliminarBorrador(tx, ventas, borrador));
    });
  });

  describe('seguridad por fila y permisos (§4.3)', () => {
    it('quien solo tiene el rol Ventas vende a su cartera y ve solo sus pedidos', async () => {
      await esperarError(como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: ajeno, almacenId: almacen })), 'no está en su cartera');
      const mio = await pedido(ventas, contado, [[pastilla, '1']]);
      const ajenoPedido = await pedido(facturacion, ajeno, [[pastilla, '1']]);
      expect((await buscarDocumentos(db, ventas, 'pedido', {})).map((f) => f.id)).toContain(mio);
      expect((await buscarDocumentos(db, ventas, 'pedido', {})).map((f) => f.id)).not.toContain(ajenoPedido);
      expect((await buscarDocumentos(db, otroVentas, 'pedido', {})).map((f) => f.id)).toContain(ajenoPedido);
      expect((await buscarDocumentos(db, facturacion, 'pedido', {})).map((f) => f.id)).toEqual(expect.arrayContaining([mio, ajenoPedido]));
      await esperarError(como(ventas.id, (tx) => emitirPedido(tx, ventas, ajenoPedido)), 'otro vendedor');
      await esperarError(como(ventas.id, (tx) => eliminarBorrador(tx, ventas, ajenoPedido)), 'otro vendedor');
      await como(ventas.id, (tx) => eliminarBorrador(tx, ventas, mio));
      await como(facturacion.id, (tx) => eliminarBorrador(tx, facturacion, ajenoPedido));
      expect(await buscarDocumentos(db, { id: gerente, roles: ['tesoreria'] }, 'pedido', {})).toEqual([]);
    });

    it('la bandeja de aprobaciones de crédito solo la decide Gerencia (auditoría y segregación)', async () => {
      const id = await pedido(facturacion, ajeno, [[pastilla, '1000']]);          // excede el límite de 5000
      expect((await emitir(facturacion, id)).situacion).toBe('retenido_credito');
      expect(await puedeDecidirObjeto(db, gerente, 'pedido_credito', id)).toBe(true);
      expect(await puedeDecidirObjeto(db, facturacion.id, 'pedido_credito', id)).toBe(false);
      await como(gerente, (tx) => resolverAprobacion(tx, 'pedido_credito', id, gerente, 'rechazada', { comentario: 'Excede' }));
    });
  });
});
