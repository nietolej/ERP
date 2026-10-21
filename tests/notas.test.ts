import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada, type ServicioNumeroControl } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { cuadreCxC, registrarCobro } from '@/lib/ventas/cobros';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { anularFactura, facturarNotas } from '@/lib/ventas/facturas';
import {
  ROLES_CREAN_NOTAS, ROLES_EMITEN_NOTAS, asignarControlNota, buscarNotas, crearNotaCredito, crearNotaDebito, detalleNota, eliminarNota, emitirNota,
  enviarAprobacion, lineasFacturables, notasDeFactura, type DatosNotaCredito,
} from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('notas de crédito y de débito (R-BV a R-BX, §6.2 regla 7, §12.3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let supervisor2: Usuario;
  let gerente: Usuario;
  let facturacion: Usuario;
  let cobranzas: Usuario;
  let almacenista: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let aceite: string;        // US$ 20, exento, costo 6,50
  let pastilla: string;      // US$ 10, IVA general, costo 4,00
  let intereses: string;     // concepto no inventariable
  let motivoDevolucion = '';
  let motivoDescuento = '';
  let OTRO = '';
  const F: Record<string, { id: string; linea: string }> = {};

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const lineasAsiento = async (tipo: string, id: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [tipo, id])).rows;
  const fila = (codigo: string, dv: string, hv: string, du: string, hu: string) => ({ codigo, debe_ves: dv, haber_ves: hv, debe_usd: du, haber_usd: hu });
  const partida = async (factura: string) => (await db.query<{ saldo: string; saldo_usd: string; estado: string }>(
    'select saldo::text, saldo_usd::text, estado from partida_cxc where documento_id = $1', [factura])).rows[0];
  const existencia = async (producto: string) => Number((await db.query<{ c: string }>(
    'select cantidad::text as c from existencia where producto_id = $1 and almacen_id = $2', [producto, mostrador])).rows[0].c);
  const cuadra = async () => {
    const c = await cuadreCxC(db);
    expect(c, JSON.stringify(c)).toMatchObject({ cuadra: true });
  };

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
  /** Nota de crédito creada, enviada y aprobada por el Supervisor; lista para emitir. */
  async function aprobada(d: DatosNotaCredito, creador: Usuario = ventas) {
    const id = await como(creador, (tx) => crearNotaCredito(tx, creador, d));
    await como(creador, (tx) => enviarAprobacion(tx, creador, id));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', id, supervisor.id, 'aprobada'));
    return id;
  }
  const emitir = (id: string, servicio?: ServicioNumeroControl) => como(facturacion, (tx) => emitirNota(tx, facturacion, id, { servicio: servicio ?? new ImprentaSimulada() }));
  const devolver = (factura: string, linea: string, cantidad: string): DatosNotaCredito => ({ facturaId: factura, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: linea, cantidad }] });

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;
    motivoDescuento = (await db.query<{ id: string }>(`select id from motivo where tipo = 'descuento' and codigo = 'VOLUMEN'`)).rows[0].id;
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    const idSup2 = await usuarioDePrueba(db, 'supervisor2@prueba.test', ['supervisor_ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idTes = await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']);
    gerente = { id: idGer, roles: ['gerencia'] };
    ventas = { id: idVen, roles: ['ventas'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    supervisor2 = { id: idSup2, roles: ['supervisor_ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
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

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string, precio: string, costo: string | null) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      const id = await db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: costo !== null,
      }));
      if (costo !== null) {
        await db.transaction((tx) => fijarPrecio(tx, id, 'B', precio, hoy));
        await como(almacenista, (tx) => tx.query(
          `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
           values ('entrada_compra', $1, $2, 500, $3, 'prueba', gen_random_uuid())`, [id, mostrador, costo]));
      }
      return id;
    };
    aceite = await nuevo('AC-001', exento, '20.00', '6.50');
    pastilla = await nuevo('PF-001', general, '10.00', '4.00');
    intereses = await nuevo('SV-INT', general, '0', null);

    F.f1 = await facturar(clienteA, [[aceite, '10']]);       // Bs 8.000 · US$ 200 · exenta
    F.f2 = await facturar(clienteA, [[pastilla, '10']]);     // Bs 4.640 · US$ 116 (base 4.000 + IVA 640)
    F.f3 = await facturar(clienteB, [[aceite, '1']]);        // Bs 800 · US$ 20

    // Una cuenta bancaria para cobrar la nota de débito.
    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    await como({ id: idTes, roles: ['tesoreria'] }, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-11' }));
  });
  afterAll(() => cerrar());

  it('devolución parcial de mercancía exenta: se aprueba, se emite, reduce la factura y reingresa la mercancía al costo original', async () => {
    const antes = await existencia(aceite);
    const id = await como(ventas, (tx) => crearNotaCredito(tx, ventas, devolver(F.f1.id, F.f1.linea, '4')));
    let d = (await detalleNota(db, id))!;
    expect(d).toMatchObject({ tipo: 'nota_credito', estado: 'borrador', situacion: null, motivo_nc: 'devolucion', base_imponible: '0.00', exento: '3200.00', iva: '0.00', total: '3200.00' });
    expect(d.lineas[0]).toMatchObject({ cantidad: '4.0000', precio_unitario: '800.0000', alicuota_pct: '0.00', total: '3200.00' });

    // Antes de aprobarse no se emite; quien la creó no la aprueba.
    await esperarError(emitir(id), 'aprobada');
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, id));
    d = (await detalleNota(db, id))!;
    expect(d.situacion).toBe('pendiente_aprobacion');
    await expect(como(ventas, (tx) => resolverAprobacion(tx, 'nota_credito', id, ventas.id, 'aprobada'))).rejects.toThrow();
    await esperarError(emitir(id), 'aprobada');
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', id, supervisor.id, 'aprobada'));
    expect((await detalleNota(db, id))).toMatchObject({ situacion: 'aprobada', aprobador: 'Usuario de prueba' });

    const r = await emitir(id);
    expect(r).toMatchObject({ numero: 'A-1', contingencia: false });
    expect(r.numeroControl).toMatch(/^00-\d{8}$/);
    expect(await partida(F.f1.id)).toEqual({ saldo: '4800.00', saldo_usd: '120.00', estado: 'abierta' });          // 200 − 200 × 3.200 ÷ 8.000
    expect(await lineasAsiento('nota_credito', id)).toEqual([
      fila('4.1.02', '3200.00', '0.00', '80.00', '0.00'),
      fila('1.2.01', '0.00', '3200.00', '0.00', '80.00'),
    ]);
    // Reingreso: 4 × 6,50 = US$ 26,00 a la tasa del día.
    expect(await existencia(aceite)).toBe(antes + 4);
    expect(await lineasAsiento('reingreso_devolucion', id)).toEqual([
      fila('1.3.01', '1040.00', '0.00', '26.00', '0.00'),
      fila('5.1.01', '0.00', '1040.00', '0.00', '26.00'),
    ]);
    const { rows: mov } = await db.query<{ tipo: string; cantidad: string; costo_total_usd: string }>(
      `select tipo, cantidad::text, costo_total_usd::text from movimiento_inventario where origen_tipo = 'nota_credito' and origen_id = $1`, [id]);
    expect(mov).toEqual([{ tipo: 'devolucion_cliente', cantidad: '4.0000', costo_total_usd: '26.00' }]);
    d = (await detalleNota(db, id))!;
    expect(d).toMatchObject({ estado: 'emitido', numero: 'A-1', usd_aplicado: '80.00' });
    expect(d.asientos.map((a) => a.evento).sort()).toEqual(['nota_credito', 'reingreso_devolucion']);
    await cuadra();
  });

  it('devolución con IVA: el IVA y la base se revierten a la alícuota de la factura y a su valor en USD histórico', async () => {
    const antes = await existencia(pastilla);
    const r = await emitir(await aprobada(devolver(F.f2.id, F.f2.linea, '3')));
    expect(r.numero).toBe('A-2');
    expect(await partida(F.f2.id)).toEqual({ saldo: '3248.00', saldo_usd: '81.20', estado: 'abierta' });             // 4.640 − 1.392; 116 − 34,80
    const id = (await db.query<{ id: string }>(`select id from documento_venta where tipo = 'nota_credito' and numero = 2`)).rows[0].id;
    expect(await lineasAsiento('nota_credito', id)).toEqual([
      fila('4.1.02', '1200.00', '0.00', '30.00', '0.00'),
      fila('2.1.03', '192.00', '0.00', '4.80', '0.00'),
      fila('1.2.01', '0.00', '1392.00', '0.00', '34.80'),
    ]);
    expect(await existencia(pastilla)).toBe(antes + 3);
    expect((await lineasAsiento('reingreso_devolucion', id))[0]).toEqual(fila('1.3.01', '480.00', '0.00', '12.00', '0.00'));
    await cuadra();
  });

  it('no se devuelve más de lo facturado menos lo que ya devolvieron otras notas vigentes', async () => {
    let l = (await lineasFacturables(db, F.f2.id))[0];
    expect([l.cantidad, l.devuelta, l.disponible]).toEqual(['10.0000', '3.0000', '7.0000']);
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, devolver(F.f2.id, F.f2.linea, '8'))), 'Se devuelve más de lo facturado');
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, devolver(F.f2.id, F.f2.linea, '0'))), 'mayor que cero');
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, { ...devolver(F.f2.id, F.f2.linea, '1'), lineas: [] })), 'qué líneas');
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, { ...devolver(F.f2.id, F.f2.linea, '1'), motivoId: motivoDescuento })), 'motivo de devolución');
    // Una nota pendiente también reserva lo que va a devolver; al eliminarla, vuelve a estar disponible.
    const pendiente = await como(ventas, (tx) => crearNotaCredito(tx, ventas, devolver(F.f2.id, F.f2.linea, '7')));
    l = (await lineasFacturables(db, F.f2.id))[0];
    expect(l.disponible).toBe('0.0000');
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, devolver(F.f2.id, F.f2.linea, '1'))), 'Se devuelve más de lo facturado');
    await como(ventas, (tx) => eliminarNota(tx, ventas, pendiente));
    expect((await lineasFacturables(db, F.f2.id))[0].disponible).toBe('7.0000');
    // Línea de otra factura, o la misma sobre una base de datos que se manipula a mano.
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, devolver(F.f2.id, F.f1.linea, '1'))), 'no pertenece a la factura');
  });

  it('descuento por pronto pago: porcentaje sobre el precio neto de la factura, con el IVA de cada línea y sin mover inventario', async () => {
    const antes = await existencia(pastilla);
    const id = await aprobada({ facturaId: F.f2.id, clase: 'pronto_pago', porcentaje: '20' });
    expect(await detalleNota(db, id)).toMatchObject({ motivo: 'Descuento por pronto pago', base_imponible: '800.00', iva: '128.00', total: '928.00' });
    const r = await emitir(id);
    expect(r.asientoInventario).toBeNull();
    expect(await existencia(pastilla)).toBe(antes);
    expect(await partida(F.f2.id)).toEqual({ saldo: '2320.00', saldo_usd: '58.00', estado: 'abierta' });
    expect(await lineasAsiento('nota_credito', id)).toEqual([
      fila('4.1.03', '800.00', '0.00', '20.00', '0.00'),
      fila('2.1.03', '128.00', '0.00', '3.20', '0.00'),
      fila('1.2.01', '0.00', '928.00', '0.00', '23.20'),
    ]);
    await cuadra();
    // Un descuento comercial con motivo propio, sobre una sola línea.
    const c = await aprobada({ facturaId: F.f1.id, clase: 'descuento_comercial', motivoId: motivoDescuento, porcentaje: '5', lineaIds: [F.f1.linea] });
    expect(await detalleNota(db, c)).toMatchObject({ exento: '400.00', total: '400.00', motivo: 'Volumen de compra' });
    await emitir(c);
    expect(await partida(F.f1.id)).toEqual({ saldo: '4400.00', saldo_usd: '110.00', estado: 'abierta' });
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, { facturaId: F.f1.id, clase: 'descuento_comercial', porcentaje: '5' })), 'motivo del descuento');
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, { facturaId: F.f1.id, clase: 'pronto_pago', porcentaje: '0' })), 'porcentaje');
    await esperarError(como(ventas, (tx) => crearNotaCredito(tx, ventas, { facturaId: F.f1.id, clase: 'pronto_pago', porcentaje: '101' })), 'porcentaje');
    await cuadra();
  });

  it('una nota de crédito no supera el saldo de la factura, y una factura sin saldo no se reduce', async () => {
    // Factura 1: saldo Bs 4.400. Un ajuste del 100 % (Bs 8.000) no cabe.
    const grande = await aprobada({ facturaId: F.f1.id, clase: 'ajuste_precio', motivoId: motivoDescuento, porcentaje: '100' });
    await esperarError(emitir(grande), 'supera el saldo');
    expect((await detalleNota(db, grande))!.estado).toBe('borrador');                         // no quedó emitida a medias
    expect(await partida(F.f1.id)).toMatchObject({ saldo: '4400.00' });
    // Factura 3: el 100 % la liquida; otra nota ya no puede reducirla.
    const todo = await aprobada({ facturaId: F.f3.id, clase: 'descuento_comercial', motivoId: motivoDescuento, porcentaje: '100' });
    await emitir(todo);
    expect(await partida(F.f3.id)).toEqual({ saldo: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    const otra = await aprobada({ facturaId: F.f3.id, clase: 'descuento_comercial', motivoId: motivoDescuento, porcentaje: '10' });
    await esperarError(emitir(otra), 'ya no tiene saldo');
    await cuadra();
  });

  it('el Supervisor aprueba, nunca quien creó la nota; una vez enviada no se edita; un rechazo exige motivo y se puede eliminar', async () => {
    const propia = await como(supervisor, (tx) => crearNotaCredito(tx, supervisor, devolver(F.f2.id, F.f2.linea, '1')));
    await como(supervisor, (tx) => enviarAprobacion(tx, supervisor, propia));
    await expect(como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', propia, supervisor.id, 'aprobada'))).rejects.toThrow();
    await esperarError(db.query(`update documento_venta set situacion = 'aprobada', aprobado_por = $2 where id = $1`, [propia, supervisor.id]), 'Quien creó la nota');
    await esperarError(db.query(`update documento_venta set situacion = 'aprobada', aprobado_por = $2 where id = $1`, [propia, gerente.id]), 'Supervisor de ventas');
    // Enviada: sus líneas y su motivo no cambian.
    await esperarError(db.query(`update documento_venta_linea set cantidad = 2 where documento_id = $1`, [propia]), 'ya se envió a aprobación');
    await esperarError(db.query(`update documento_venta set motivo_nc = 'pronto_pago' where id = $1`, [propia]), 'no cambia de factura ni de motivo');
    await esperarError(como(supervisor, (tx) => eliminarNota(tx, supervisor, propia)), 'en aprobación');
    await esperarError(como(supervisor, (tx) => enviarAprobacion(tx, supervisor, propia)), 'en borrador');
    // Gerencia, sin el rol de Supervisor, tampoco la aprueba por el motor.
    await expect(como(gerente, (tx) => resolverAprobacion(tx, 'nota_credito', propia, gerente.id, 'aprobada'))).rejects.toThrow();

    // Rechazo: lo decide otro supervisor, con su motivo; quien no es supervisor no decide.
    await expect(como(ventas, (tx) => resolverAprobacion(tx, 'nota_credito', propia, ventas.id, 'rechazada', { comentario: 'No procede' }))).rejects.toThrow();
    await esperarError(como(supervisor2, (tx) => resolverAprobacion(tx, 'nota_credito', propia, supervisor2.id, 'rechazada', { comentario: 'x' })), 'motivo del rechazo');
    await como(supervisor2, (tx) => resolverAprobacion(tx, 'nota_credito', propia, supervisor2.id, 'rechazada', { comentario: 'Sin soporte del cliente' }));
    expect(await detalleNota(db, propia)).toMatchObject({ situacion: 'rechazada', rechazo_motivo: 'Sin soporte del cliente' });
    await esperarError(emitir(propia), 'aprobada');
    await esperarError(db.query(`update documento_venta set situacion = 'pendiente_aprobacion' where id = $1`, [propia]), 'no pasa de rechazada');
    await como(supervisor, (tx) => eliminarNota(tx, supervisor, propia));
    expect(await detalleNota(db, propia)).toBeNull();
  });

  it('la nota de débito abre su propia partida con su IVA y su asiento, y se cobra como cualquier factura', async () => {
    const nd = await como(ventas, (tx) => crearNotaDebito(tx, ventas, {
      facturaId: F.f1.id, motivo: 'intereses', observaciones: 'Mora de 30 días', lineas: [{ productoId: intereses, cantidad: '1', precio: '100,00' }],
    }));
    expect(await detalleNota(db, nd)).toMatchObject({ tipo: 'nota_debito', base_imponible: '100.00', iva: '16.00', total: '116.00', motivo_nc: 'intereses' });
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, nd));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_debito', nd, supervisor.id, 'aprobada'));
    const r = await emitir(nd);
    expect(r.numero).toBe('A-1');                                                       // numeración propia de las notas de débito
    const { rows } = await db.query<{ saldo: string; saldo_usd: string; monto_usd: string; vencimiento: string; hoy: string }>(
      `select saldo::text, saldo_usd::text, monto_usd::text, vencimiento::text, ((now() at time zone 'America/Caracas')::date)::text as hoy from partida_cxc where documento_id = $1`, [nd]);
    expect(rows[0]).toMatchObject({ saldo: '116.00', saldo_usd: '2.90', monto_usd: '2.90' });
    expect(rows[0].vencimiento).toBe(rows[0].hoy);                                      // cliente de contado
    expect(await lineasAsiento('nota_debito', nd)).toEqual([
      fila('1.2.01', '116.00', '0.00', '2.90', '0.00'),
      fila('4.2.02', '0.00', '100.00', '0.00', '2.50'),
      fila('2.1.03', '0.00', '16.00', '0.00', '0.40'),
    ]);
    await cuadra();

    // Un cobro se aplica a la nota de débito como a una factura.
    const cuenta = (await db.query<{ id: string }>('select id from cuenta_bancaria limit 1')).rows[0].id;
    const transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;
    const partidaNd = (await db.query<{ id: string }>('select id from partida_cxc where documento_id = $1', [nd])).rows[0].id;
    await como(cobranzas, (tx) => registrarCobro(tx, cobranzas, {
      clienteId: clienteA, fecha: rows[0].hoy, instrumentoId: transferencia, cuentaBancariaId: cuenta, monto: '116', aplicaciones: [{ partidaId: partidaNd, monto: '116' }],
    }));
    expect((await db.query<{ saldo: string; estado: string }>('select saldo::text, estado from partida_cxc where id = $1', [partidaNd])).rows[0]).toEqual({ saldo: '0.00', estado: 'cancelada' });
    await cuadra();

    // Ajuste de precio: otro concepto, ventas y no otros ingresos.
    const aj = await como(ventas, (tx) => crearNotaDebito(tx, ventas, { facturaId: F.f1.id, motivo: 'ajuste_precio', lineas: [{ productoId: intereses, descripcion: 'Ajuste por diferencia de precio', cantidad: '2', precio: '50' }] }));
    await como(ventas, (tx) => enviarAprobacion(tx, ventas, aj));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_debito', aj, supervisor.id, 'aprobada'));
    await emitir(aj);
    expect((await lineasAsiento('nota_debito', aj)).map((x) => x.codigo)).toEqual(['1.2.01', '4.1.01', '2.1.03']);
    await esperarError(como(ventas, (tx) => crearNotaDebito(tx, ventas, { facturaId: F.f1.id, motivo: 'intereses', lineas: [] })), 'al menos un concepto');
    await esperarError(como(ventas, (tx) => crearNotaDebito(tx, ventas, { facturaId: F.f1.id, motivo: 'intereses', lineas: [{ productoId: intereses, cantidad: '1', precio: '0' }] })), 'mayor que cero');
    await cuadra();
  });

  it('sin servicio de control la nota se emite en contingencia y recibe su número después', async () => {
    const roto: ServicioNumeroControl = {
      proveedor: 'Roto', esReal: false, async solicitar() { throw new Error('imprenta fuera de línea'); }, async anular() { /* nada */ },
    };
    const id = await aprobada({ facturaId: F.f2.id, clase: 'descuento_comercial', motivoId: motivoDescuento, porcentaje: '1' });
    const r = await emitir(id, roto);
    expect(r).toMatchObject({ contingencia: true, numeroControl: null });
    expect(await detalleNota(db, id)).toMatchObject({ contingencia: true, numero_control: null });
    expect((await detalleNota(db, id))!.contingencia_motivo).toMatch(/imprenta fuera de línea/);
    const control = await como(facturacion, (tx) => asignarControlNota(tx, id, { servicio: new ImprentaSimulada() }));
    expect(control).toMatch(/^00-\d{8}$/);
    expect(await detalleNota(db, id)).toMatchObject({ contingencia: false, numero_control: control });
    await esperarError(como(facturacion, (tx) => asignarControlNota(tx, id)), 'no está pendiente');
  });

  it('la base de datos protege las notas emitidas y sus referencias', async () => {
    const emitida = (await db.query<{ id: string }>(`select id from documento_venta where tipo = 'nota_credito' and estado = 'emitido' order by numero limit 1`)).rows[0].id;
    await esperarError(db.query('update documento_venta set total = 1 where id = $1', [emitida]), 'no se edita');
    await esperarError(db.query('delete from documento_venta where id = $1', [emitida]), 'no se borra');
    await esperarError(db.query(`update documento_venta set estado = 'anulado', anulado_motivo = 'x', anulado_motivo_id = $2 where id = $1`, [emitida, OTRO]), 'no se anula');
    await esperarError(db.query('update documento_venta_linea set cantidad = 1 where documento_id = $1', [emitida]), 'no se modifican');
    await esperarError(db.query('update aplicacion_nota_credito set monto = 1'), 'no se modifica');
    await esperarError(db.query('delete from aplicacion_nota_credito'), 'no se modifica');
    // Referencias: la factura de origen existe, está emitida, es del mismo cliente y va en bolívares.
    const pedido = (await db.query<{ id: string }>(`select id from documento_venta where tipo = 'pedido' limit 1`)).rows[0].id;
    const ins = (origen: string, cliente: string, moneda = 'VES') => como(ventas, (tx) => tx.query(
      `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, documento_origen_id, moneda, motivo_nc, created_by)
       select 'nota_credito', sucursal_id, almacen_id, $2, $1, $3, 'pronto_pago', $4 from documento_venta where id = $1`, [origen, cliente, moneda, ventas.id]));
    await esperarError(ins(pedido, clienteA), 'factura emitida');
    await esperarError(ins(F.f1.id, clienteB), 'mismo cliente');
    await esperarError(ins(F.f1.id, clienteA, 'USD'), 'bolívares');
    // La factura con notas aplicadas no se anula.
    await esperarError(como(facturacion, (tx) => anularFactura(tx, facturacion, F.f1.id, { motivoId: OTRO, detalle: 'Prueba' }, { servicio: new ImprentaSimulada() })), 'notas de crédito aplicados');
  });

  it('numeración correlativa, listas por rol y roles de creación y emisión', async () => {
    const todas = await buscarNotas(db, supervisor);
    const numeros = todas.filter((n) => n.tipo === 'nota_credito' && n.numero).map((n) => Number(n.numero!.split('-')[1])).sort((a, b) => a - b);
    expect(numeros).toEqual(numeros.map((_, i) => i + 1));                                    // sin huecos
    expect((await buscarNotas(db, supervisor, { tipo: 'nota_debito' })).every((n) => n.tipo === 'nota_debito')).toBe(true);
    expect((await buscarNotas(db, supervisor, { estado: 'emitida' })).every((n) => n.estado === 'emitido')).toBe(true);
    expect((await buscarNotas(db, ventas)).length).toBeGreaterThan(0);                        // el vendedor ve las de su cartera
    expect(await buscarNotas(db, { id: ventas.id, roles: ['almacen'] })).toEqual([]);          // Almacén no ve notas
    expect((await notasDeFactura(db, F.f1.id)).length).toBeGreaterThanOrEqual(4);
    expect([...ROLES_CREAN_NOTAS].sort()).toEqual(['facturacion', 'gerencia', 'supervisor_ventas', 'ventas']);
    expect([...ROLES_EMITEN_NOTAS].sort()).toEqual(['facturacion', 'gerencia']);
    // Un vendedor no hace notas sobre facturas de otro vendedor.
    const otro = { id: (await usuarioDePrueba(db, 'ventas2@prueba.test', ['ventas'])), roles: ['ventas'] } as Usuario;
    await esperarError(como(otro, (tx) => crearNotaCredito(tx, otro, devolver(F.f1.id, F.f1.linea, '1'))), 'no es de su cartera');
  });

  it('una factura con una nota de débito (o cualquier nota viva) no se anula, aunque no tenga cobros', async () => {
    const f = await facturar(clienteA, [[aceite, '1']]);
    const nd = await como(ventas, (tx) => crearNotaDebito(tx, ventas, { facturaId: f.id, motivo: 'intereses', lineas: [{ productoId: intereses, cantidad: '1', precio: '10' }] }));
    const anular = () => como(facturacion, (tx) => anularFactura(tx, facturacion, f.id, { motivoId: OTRO, detalle: 'Prueba de anulación' }, { servicio: new ImprentaSimulada() }));
    await esperarError(anular(), 'notas de crédito o de débito');                              // incluso con la nota en borrador
    await como(ventas, (tx) => eliminarNota(tx, ventas, nd));
    await anular();                                                                          // sin notas vivas, se anula
    await cuadra();
  });

  it('al final el auxiliar de cuentas por cobrar cuadra con el mayor, en bolívares y en USD, al centavo', async () => {
    await cuadra();
    const c = await cuadreCxC(db);
    expect(c.auxiliar_ves).toBe(c.mayor_ves);
    expect(c.auxiliar_usd).toBe(c.mayor_usd);
  });
});
