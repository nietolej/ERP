import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import {
  ROLES_GESTIONAN_CUENTAS, ROLES_VEN_CUENTAS, actualizarCuentaBancaria, buscarCuentasBancarias, crearCuentaBancaria, listarInstrumentos,
} from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import {
  ROLES_COBRAN, ROLES_VEN_COBROS, aplicarAnticipo, anularCobro, buscarCobros, cuadreCxC, detalleCobro, partidasAbiertas, registrarCobro,
  resumenCxC, type DatosCobro,
} from '@/lib/ventas/cobros';
import { anularFactura, facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('cobros y su aplicación a las cuentas por cobrar (R-BR a R-BU, §6.3, §12.3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let cobranzas: Usuario;
  let tesoreria: Usuario;
  let gerente: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let ventas: Usuario;
  let mostrador: string;
  let clienteA: string;
  let clienteB: string;
  let clientePendiente: string;
  let aceite: string;        // US$ 20, exento
  let pastilla: string;      // US$ 10, IVA general
  let cuentaVes: string;     // banco nacional en bolívares
  let cuentaUsd: string;     // banco en dólares
  let transferencia = '';
  let zelle = '';
  let OTRO = '';
  let hoy = '';
  const F: Record<string, { partida: string; factura: string }> = {};

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const tasaUsd = (t: number) => db.query(`update tasa_cambio set tasa = $1 where fecha = $2 and moneda = 'USD'`, [t, hoy]);
  const cobrar = (d: Partial<DatosCobro> & Pick<DatosCobro, 'monto'>, u: Usuario = cobranzas) => como(u, (tx) => registrarCobro(tx, u, {
    clienteId: clienteA, fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, ...d,
  }));
  const partida = async (f: string) => (await db.query<{ saldo: string; saldo_usd: string; estado: string }>(
    'select saldo::text, saldo_usd::text, estado from partida_cxc where id = $1', [F[f].partida])).rows[0];
  const lineas = async (tipo: string, id: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [tipo, id])).rows;
  const fila = (codigo: string, dv: string, hv: string, du: string, hu: string) => ({ codigo, debe_ves: dv, haber_ves: hv, debe_usd: du, haber_usd: hu });
  const cuadra = async () => {
    const c = await cuadreCxC(db);
    expect(c, JSON.stringify(c)).toMatchObject({ cuadra: true });
    return c;
  };

  async function facturar(cliente: string, lineas: [string, string][]) {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    for (const [p, c] of lineas) await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: p, cantidad: c }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const { rows } = await db.query<{ id: string }>('select id from partida_cxc where documento_id = $1', [f.facturaId]);
    return { partida: rows[0].id, factura: f.facturaId };
  }

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    const idTes = await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    gerente = { id: idGer, roles: ['gerencia'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };
    tesoreria = { id: idTes, roles: ['tesoreria'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    ventas = { id: idVen, roles: ['ventas'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string, aprobar = true) => {
      const c = await db.transaction((tx) => crearCliente(tx, idFac, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
      }));
      if (aprobar) await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    clienteA = await cliente('J-00000010-7', 'Repuestos Lara, C.A.');
    clienteB = await cliente('J-00000020-4', 'Autopartes Sur, C.A.');
    clientePendiente = await cliente('J-00000030-1', 'Frenos del Centro, C.A.', false);

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string, precio: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      const id = await db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
      await db.transaction((tx) => fijarPrecio(tx, id, 'B', precio, hoy));
      await como(almacenista, (tx) => tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
         values ('entrada_compra', $1, $2, 500, 4, 'prueba', gen_random_uuid())`, [id, mostrador]));
      return id;
    };
    aceite = await nuevo('AC-001', exento, '20.00');
    pastilla = await nuevo('PF-001', general, '10.00');

    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    cuentaUsd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-0000-22' }))).id;
    const instrumentos = await listarInstrumentos(db);
    transferencia = instrumentos.find((i) => i.codigo === 'TRANSFERENCIA')!.id;
    zelle = instrumentos.find((i) => i.codigo === 'ZELLE')!.id;

    // Facturas a la tasa de hoy (40): cada una en bolívares y con su valor en USD congelado. Después sube la tasa.
    F.f1 = await facturar(clienteA, [[aceite, '5']]);       // Bs 4.000 · US$ 100
    F.f2 = await facturar(clienteA, [[aceite, '10']]);      // Bs 8.000 · US$ 200
    F.f3 = await facturar(clienteA, [[pastilla, '10']]);    // Bs 4.640 · US$ 116 (IVA 16 %)
    F.f4 = await facturar(clienteB, [[aceite, '1']]);       // Bs 800 · US$ 20
    F.f6 = await facturar(clienteA, [[aceite, '5']]);
    F.f7 = await facturar(clienteA, [[aceite, '5']]);
    F.f9 = await facturar(clienteA, [[aceite, '5']]);
    await tasaUsd(44);
  });
  afterAll(() => cerrar());

  it('las facturas abren su partida con su valor en USD congelado y el auxiliar cuadra con el mayor desde el inicio', async () => {
    expect(await partida('f1')).toEqual({ saldo: '4000.00', saldo_usd: '100.00', estado: 'abierta' });
    expect(await partida('f3')).toEqual({ saldo: '4640.00', saldo_usd: '116.00', estado: 'abierta' });
    const c = await cuadra();
    expect(c.auxiliar_ves).toBe(c.mayor_ves);
    expect(c.auxiliar_usd).toBe(c.mayor_usd);
  });

  it('las cuentas bancarias tienen su subcuenta contable propia, con el código siguiente de su cuenta de agrupación', async () => {
    const cuentas = await buscarCuentasBancarias(db);
    expect(cuentas.map((c) => [c.codigo, c.nombre, c.moneda, c.cuenta_contable])).toEqual([
      ['CB0001', 'Banco Nacional Bs', 'VES', '1.1.02.01'],
      ['CB0002', 'Banco Nacional USD', 'USD', '1.1.03.01'],
    ]);
    const caja = await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Caja de dólares', tipo: 'caja', moneda: 'USD' }));
    expect(caja.cuentaContable).toBe('1.1.01.03');                                  // 1.1.01.01 y .02 ya existían en el plan
    const banco = (await db.query<{ id: string }>('select id from banco limit 1')).rows[0].id;
    const otra = await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs 2', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-33' }));
    expect(otra.cuentaContable).toBe('1.1.02.02');
    const { rows: cc } = await db.query<{ moneda: string; controlada_por: string; imputable: boolean }>(
      `select moneda, controlada_por, imputable from cuenta_contable where codigo = '1.1.02.01'`);
    expect(cc[0]).toEqual({ moneda: 'VES', controlada_por: 'banco', imputable: true });
    await esperarError(como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Repetida', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' })), 'Ya existe una cuenta con ese número');
    await esperarError(como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Sin banco', tipo: 'banco', moneda: 'VES' })), 'Seleccione el banco');
    await esperarError(como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Custodia en bolívares', tipo: 'custodia', moneda: 'VES' })), 'divisas');
    await esperarError(db.query('delete from cuenta_bancaria where id = $1', [caja.id]), 'se inactiva');
    await esperarError(db.query(`update cuenta_bancaria set moneda = 'VES' where id = $1`, [caja.id]), 'no se cambian');
    await como(tesoreria, (tx) => actualizarCuentaBancaria(tx, otra.id, { nombre: 'Banco Nacional Bs 2', activa: false }));
    expect((await buscarCuentasBancarias(db, { soloActivas: true })).map((c) => c.codigo)).not.toContain(otra.codigo);
    // Una cuenta controlada por el auxiliar de bancos no admite asientos manuales.
    const manual = (await db.query<{ id: string }>(
      `insert into asiento (fecha, tipo, descripcion, created_by) values ($1, 'manual', 'prueba', $2) returning id`, [hoy, tesoreria.id])).rows[0].id;
    await esperarError(db.query(
      `insert into asiento_linea (asiento_id, cuenta_id, debe_ves, moneda_original, monto_original, tasa)
       values ($1, (select id from cuenta_contable where codigo = '1.1.02.01'), 1, 'VES', 1, 1)`, [manual]), 'controlada por');
  });

  it('un cobro en bolívares que liquida una factura: el diferencial cambiario va solo en USD (la tasa subió de 40 a 44)', async () => {
    const r = await cobrar({ monto: '4000', referencia: 'TR-0001', aplicaciones: [{ partidaId: F.f1.partida, monto: '4000' }] });
    expect(r).toMatchObject({ numero: '1', anticipo: '0.00' });
    expect(await partida('f1')).toEqual({ saldo: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    // Banco 4.000 Bs = US$ 90,91 a la tasa de hoy; la factura valía US$ 100: pérdida cambiaria de US$ 9,09 (en bolívares, ninguna).
    expect(await lineas('cobro', r.id)).toEqual([
      fila('1.1.02.01', '4000.00', '0.00', '90.91', '0.00'),
      fila('6.3.02', '0.00', '0.00', '9.09', '0.00'),
      fila('1.2.01', '0.00', '4000.00', '0.00', '100.00'),
    ]);
    const d = (await detalleCobro(db, r.id))!;
    expect(d).toMatchObject({ estado: 'registrado', moneda: 'VES', tasa: '1.000000', monto_ves: '4000.00', monto_usd: '90.91', por_aplicar: '0.00' });
    expect(d.aplicaciones[0]).toMatchObject({ monto_partida: '4000.00', usd_partida: '100.00', base_ves: '4000.00', base_usd: '90.91', dif_ves: '0.00', dif_usd: '9.09', origen: 'registro' });
    expect(d.asiento).toMatch(/^\d+$/);
    await cuadra();
  });

  it('un cobro parcial deja saldo en bolívares y en USD proporcional; el último cobro se lleva el resto exacto, sin centavos huérfanos', async () => {
    const a = await cobrar({ monto: '3000', referencia: 'TR-0002', aplicaciones: [{ partidaId: F.f2.partida, monto: '3000' }] });
    expect(await partida('f2')).toEqual({ saldo: '5000.00', saldo_usd: '125.00', estado: 'abierta' });      // 200 × 5.000 ÷ 8.000
    expect((await detalleCobro(db, a.id))!.aplicaciones[0]).toMatchObject({ usd_partida: '75.00', base_usd: '68.18', dif_usd: '6.82' });
    await cuadra();
    const b = await cobrar({ monto: '5000', referencia: 'TR-0003', aplicaciones: [{ partidaId: F.f2.partida, monto: '5000' }] });
    expect(await partida('f2')).toEqual({ saldo: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    expect((await detalleCobro(db, b.id))!.aplicaciones[0]).toMatchObject({ usd_partida: '125.00', base_usd: '113.64', dif_usd: '11.36' });
    await cuadra();
  });

  it('un cobro en divisas cancela monto × tasa BCV bolívares; si liquida, cancela el saldo exacto y la diferencia de centavos va al diferencial', async () => {
    // US$ 105,45 × 44 = Bs 4.639,80 contra una factura de Bs 4.640,00 (US$ 116 a la tasa de la factura).
    await esperarError(cobrar({ monto: '100', cuentaBancariaId: cuentaUsd, instrumentoId: zelle, aplicaciones: [{ partidaId: F.f6.partida, monto: '100', liquida: true }] }), 'no liquida la factura');
    const r = await cobrar({ monto: '105.45', cuentaBancariaId: cuentaUsd, instrumentoId: zelle, referencia: 'ZL-1', aplicaciones: [{ partidaId: F.f3.partida, monto: '105.45', liquida: true }] });
    expect(await partida('f3')).toEqual({ saldo: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    expect(await lineas('cobro', r.id)).toEqual([
      fila('1.1.03.01', '4639.80', '0.00', '105.45', '0.00'),
      fila('6.3.02', '0.20', '0.00', '0.00', '0.00'),            // los 20 céntimos de bolívar de la conversión
      fila('6.3.02', '0.00', '0.00', '10.55', '0.00'),           // 116 − 105,45
      fila('1.2.01', '0.00', '4640.00', '0.00', '116.00'),
    ]);
    expect((await detalleCobro(db, r.id))!).toMatchObject({ moneda: 'USD', tasa: '44.000000', monto_ves: '4639.80', monto_usd: '105.45' });
    await cuadra();
  });

  it('sin liquidar, el cobro en divisas cancela solo lo que vale a la tasa del día y la factura conserva el resto', async () => {
    const r = await cobrar({ monto: '50', cuentaBancariaId: cuentaUsd, instrumentoId: zelle, aplicaciones: [{ partidaId: F.f6.partida, monto: '50' }] });
    expect(await partida('f6')).toEqual({ saldo: '1800.00', saldo_usd: '45.00', estado: 'abierta' });        // 4.000 − 50 × 44; 100 × 1.800 ÷ 4.000
    expect((await detalleCobro(db, r.id))!.aplicaciones[0]).toMatchObject({ monto_partida: '2200.00', usd_partida: '55.00', base_usd: '50.00', dif_usd: '5.00' });
    await cuadra();
    await como(gerente, (tx) => anularCobro(tx, gerente, r.id, { motivoId: OTRO, detalle: 'Prueba' }));
    expect(await partida('f6')).toEqual({ saldo: '4000.00', saldo_usd: '100.00', estado: 'abierta' });
    await cuadra();
  });

  it('el cobro que no se aplica es un anticipo (pasivo); después se aplica a facturas con su diferencial en bolívares y en USD', async () => {
    const r = await cobrar({ monto: '50', cuentaBancariaId: cuentaUsd, instrumentoId: zelle, referencia: 'ZL-2' });
    expect(r.anticipo).toBe('50.00');
    expect(await lineas('cobro', r.id)).toEqual([
      fila('1.1.03.01', '2200.00', '0.00', '50.00', '0.00'),
      fila('2.1.08', '0.00', '2200.00', '0.00', '50.00'),
    ]);
    let c = await cuadra();
    expect([c.anticipos_auxiliar_ves, c.anticipos_auxiliar_usd, c.anticipos_mayor_ves, c.anticipos_mayor_usd]).toEqual(['2200.00', '50.00', '2200.00', '50.00']);
    expect((await resumenCxC(db, cobranzas)).find((x) => x.cliente_id === clienteA)!.anticipos_usd).toBe('50.00');

    // La tasa sube a 46 antes de aplicarlo: 30 de los 50 cancelan Bs 1.380; en los libros valían Bs 1.320 y US$ 30.
    await tasaUsd(46);
    const a1 = await como(cobranzas, (tx) => aplicarAnticipo(tx, cobranzas, r.id, { aplicaciones: [{ partidaId: F.f6.partida, monto: '30' }] }));
    expect(a1.anticipo).toBe('20.00');
    expect(await partida('f6')).toEqual({ saldo: '2620.00', saldo_usd: '65.50', estado: 'abierta' });
    const origen = (await db.query<{ id: string }>(`select id from aplicacion_cobro where cobro_id = $1 order by created_at limit 1`, [r.id])).rows[0].id;
    expect(await lineas('aplicacion_cobro', origen)).toEqual([
      fila('2.1.08', '1320.00', '0.00', '30.00', '0.00'),
      fila('6.3.02', '60.00', '0.00', '0.00', '0.00'),
      fila('6.3.02', '0.00', '0.00', '4.50', '0.00'),
      fila('1.2.01', '0.00', '1380.00', '0.00', '34.50'),
    ]);
    c = await cuadra();
    expect([c.anticipos_mayor_ves, c.anticipos_mayor_usd]).toEqual(['880.00', '20.00']);

    // Lo último que queda del anticipo se lleva su valor en los libros exacto.
    await como(cobranzas, (tx) => aplicarAnticipo(tx, cobranzas, r.id, { aplicaciones: [{ partidaId: F.f6.partida, monto: '20' }] }));
    expect(await partida('f6')).toEqual({ saldo: '1700.00', saldo_usd: '42.50', estado: 'abierta' });
    expect((await detalleCobro(db, r.id))!).toMatchObject({ por_aplicar: '0.00', por_aplicar_ves: '0.00', por_aplicar_usd: '0.00' });
    c = await cuadra();
    expect([c.anticipos_mayor_ves, c.anticipos_mayor_usd]).toEqual(['0.00', '0.00']);
    await esperarError(como(cobranzas, (tx) => aplicarAnticipo(tx, cobranzas, r.id, { aplicaciones: [{ partidaId: F.f6.partida, monto: '1' }] })), 'no tiene anticipo por aplicar');
    // Un cobro con un anticipo ya aplicado a facturas no se anula.
    await esperarError(como(gerente, (tx) => anularCobro(tx, gerente, r.id, { motivoId: OTRO, detalle: 'Prueba' })), 'anticipo ya aplicado');
    await tasaUsd(44);
  });

  it('valida el cobro y sus aplicaciones, también en la base de datos', async () => {
    const p = F.f7.partida;
    await esperarError(cobrar({ monto: '0' }), 'mayor que cero');
    await esperarError(cobrar({ monto: '10.123' }), 'hasta 2 decimales');
    await esperarError(cobrar({ monto: '100', fecha: 'hoy' }), 'fecha del cobro');
    await esperarError(cobrar({ monto: '100', aplicaciones: [{ partidaId: p, monto: '60' }, { partidaId: p, monto: '40' }] }), 'dos veces');
    await esperarError(cobrar({ monto: '100', aplicaciones: [{ partidaId: p, monto: '200' }] }), 'supera el monto del cobro');
    await esperarError(cobrar({ monto: '9000', aplicaciones: [{ partidaId: p, monto: '9000' }] }), 'excede el saldo');
    await esperarError(cobrar({ monto: '100', clienteId: clienteB, aplicaciones: [{ partidaId: p, monto: '100' }] }), 'clientes distintos');
    await esperarError(cobrar({ monto: '100', aplicaciones: [{ partidaId: F.f1.partida, monto: '100' }] }), 'no tiene saldo por cobrar');
    await esperarError(cobrar({ monto: '100', clienteId: clientePendiente }), 'todavía no está aprobado');
    await esperarError(cobrar({ monto: '100', fecha: await dias(1) }), 'futura');
    await esperarError(cobrar({ monto: '100', cuentaBancariaId: '00000000-0000-0000-0000-000000000000' }), 'cuenta');
    // Los cobros no cambian de moneda de la cuenta ni usan una cuenta inactiva.
    const inactiva = (await buscarCuentasBancarias(db)).find((c) => !c.activa)!;
    await esperarError(cobrar({ monto: '100', cuentaBancariaId: inactiva.id }), 'activa');
    // La referencia no se repite en la misma cuenta mientras el cobro esté vigente.
    await esperarError(cobrar({ monto: '10', referencia: ' tr-0001 ' }), 'unique');
    // Los importes de una aplicación los calcula la base: lo que se escriba a mano se ignora (la prueba se revierte).
    const r = await cobrar({ monto: '1000' });
    let forzada: { monto_partida: string; usd_partida: string; base_ves: string } | undefined;
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.usuario_id', $1, true)", [cobranzas.id]);
      const { rows } = await tx.query<{ monto_partida: string; usd_partida: string; base_ves: string }>(
        `insert into aplicacion_cobro (cobro_id, partida_id, origen, fecha, monto_cobro, monto_partida, usd_partida, base_ves, base_usd, tasa)
         values ($1, $2, 'registro', $3::date, 100, 999, 999, 999, 999, 99) returning monto_partida::text, usd_partida::text, base_ves::text`, [r.id, p, hoy]);
      forzada = rows[0];
      throw new Error('revertir');
    }).catch(() => undefined);
    expect(forzada).toEqual({ monto_partida: '100.00', usd_partida: '2.50', base_ves: '100.00' });
    expect(await partida('f7')).toEqual({ saldo: '4000.00', saldo_usd: '100.00', estado: 'abierta' });
    await como(gerente, (tx) => anularCobro(tx, gerente, r.id, { motivoId: OTRO, detalle: 'Prueba' }));
  });
  const dias = async (n: number) => (await db.query<{ d: string }>(`select (((now() at time zone 'America/Caracas')::date) + $1::int)::text as d`, [n])).rows[0].d;

  it('anular un cobro: reverso del asiento, la factura recupera su saldo, el número queda y la referencia se puede volver a usar; con cobros, la factura no se anula', async () => {
    const r = await cobrar({ monto: '1000', referencia: 'TR-7777', aplicaciones: [{ partidaId: F.f7.partida, monto: '1000' }] });
    expect(await partida('f7')).toEqual({ saldo: '3000.00', saldo_usd: '75.00', estado: 'abierta' });
    await esperarError(como(facturacion, (tx) => anularFactura(tx, facturacion, F.f7.factura, { motivoId: OTRO, detalle: 'Prueba' }, { servicio: new ImprentaSimulada() })), 'tiene cobros');
    await esperarError(como(gerente, (tx) => anularCobro(tx, gerente, r.id, { motivoId: OTRO, detalle: '' })), 'Explique el motivo');
    await como(gerente, (tx) => anularCobro(tx, gerente, r.id, { motivoId: OTRO, detalle: 'Se depositó dos veces' }));

    const d = (await detalleCobro(db, r.id))!;
    expect(d).toMatchObject({ estado: 'anulado', por_aplicar: '0.00' });
    expect(d.anulado_motivo).toMatch(/Se depositó dos veces/);
    expect(d.aplicaciones.every((a) => a.revertida)).toBe(true);
    expect(await partida('f7')).toEqual({ saldo: '4000.00', saldo_usd: '100.00', estado: 'abierta' });
    const { rows: asientos } = await db.query<{ tipo: string; n: number }>(
      `select tipo, count(*)::int as n from asiento where origen_tipo = 'cobro' and origen_id = $1 group by tipo order by tipo`, [r.id]);
    expect(asientos).toEqual([{ tipo: 'automatico', n: 1 }, { tipo: 'reverso', n: 1 }]);
    await cuadra();
    await esperarError(como(gerente, (tx) => anularCobro(tx, gerente, r.id, { motivoId: OTRO, detalle: 'otra vez' })), 'ya está anulado');
    // La referencia vuelve a estar libre (el cobro de 10 queda como anticipo).
    await cobrar({ monto: '10', referencia: 'TR-7777' });
    await cuadra();
  });

  it('la base de datos no deja tocar saldos, cobros ni aplicaciones por fuera del flujo', async () => {
    const cobro = (await db.query<{ id: string }>(`select id from cobro where estado = 'registrado' limit 1`)).rows[0].id;
    await esperarError(db.query('update partida_cxc set saldo = saldo - 1 where id = $1', [F.f6.partida]), 'solo cambia con un cobro');
    await esperarError(db.query('update partida_cxc set saldo_usd = 1 where id = $1', [F.f6.partida]), 'solo cambia con un cobro');
    await esperarError(db.query('update cobro set monto = monto + 1 where id = $1', [cobro]), 'no se edita');
    await esperarError(db.query('update cobro set por_aplicar = por_aplicar + 0.01 where id = $1', [cobro]), 'solo cambia con una aplicación');
    await esperarError(db.query('delete from cobro where id = $1', [cobro]), 'se anula');
    await esperarError(db.query('delete from aplicacion_cobro'), 'no se borra');
    await esperarError(db.query('update aplicacion_cobro set monto_cobro = 1'), 'no se modifica');
    await esperarError(db.query(`update cobro set estado = 'registrado' where id = $1`, [cobro]).then(() => db.query(`update cobro set estado = 'anulado' where id = $1`, [cobro])), 'motivo');
    await esperarError(db.query(`update cobro set estado = 'conciliado' where estado = 'anulado'`), 'no pasa a');
    // El comprobante de pago es un adjunto del cobro.
    const insertar = (entidad: string) => db.query(
      `insert into adjunto (entidad_tipo, entidad_id, nombre, tipo_contenido, tamano_bytes, hash_sha256, subido_por)
       values ('cobro', $1, 'comprobante.pdf', 'application/pdf', 10, repeat('b', 64), $2)`, [entidad, cobranzas.id]);
    await insertar(cobro);
    await esperarError(insertar('00000000-0000-0000-0000-000000000000'), 'no existe');
  });

  it('la antigüedad de saldos agrupa el saldo en USD por tramo de vencimiento y suma anticipos sin aplicar', async () => {
    // Se retrocede la factura 9 por SQL (las partidas no se editan) para ver sus días: emitida hace 60 días y vencida hace 45.
    await db.exec('alter table partida_cxc disable trigger partida_cxc_reglas');
    await db.query(`update partida_cxc set fecha = fecha - 60, vencimiento = vencimiento - 45 - 0 where id = $1`, [F.f9.partida]);
    await db.exec('alter table partida_cxc enable trigger partida_cxc_reglas');
    const { rows } = await db.query<{ dias_vencida: number; dias_emitida: number; tramo: string }>(
      'select dias_vencida, dias_emitida, tramo from vw_cxc_antiguedad where partida_id = $1', [F.f9.partida]);
    expect(rows[0]).toEqual({ dias_vencida: 45, dias_emitida: 60, tramo: 'v_31_60' });
    const a = (await resumenCxC(db, cobranzas)).find((x) => x.cliente_id === clienteA)!;
    expect(a.tramos).toEqual({ por_vencer: '142.50', v_1_30: '0.00', v_31_60: '100.00', v_61_90: '0.00', v_mas_90: '0.00' });   // 6 (resto) y 7 por vencer; 9 vencida
    expect(Number(a.saldo_usd)).toBe(242.5);
    expect(a.facturas).toBe(3);
    expect((await resumenCxC(db, cobranzas)).map((x) => x.cliente_id)).toEqual([clienteA, clienteB]);                           // por saldo, de mayor a menor
    expect(await resumenCxC(db, cobranzas, 'autopartes')).toHaveLength(1);
    expect(await resumenCxC(db, facturacion)).toEqual([]);                                                                       // Facturación no ve cobranzas
    expect((await partidasAbiertas(db, clienteA)).map((x) => x.tramo)).toEqual(['v_31_60', 'por_vencer', 'por_vencer']);
    await cuadra();
  });

  it('lista y busca cobros; cada rol ve y hace lo suyo', async () => {
    const todos = await buscarCobros(db, cobranzas);
    expect(todos.length).toBeGreaterThanOrEqual(5);
    expect(todos[0].numero > todos[todos.length - 1].numero || todos.length === 1).toBeTruthy();
    expect((await buscarCobros(db, cobranzas, { estado: 'anulado' })).every((c) => c.estado === 'anulado')).toBe(true);
    expect((await buscarCobros(db, cobranzas, { texto: 'ZL-2' })).map((c) => c.referencia)).toEqual(['ZL-2']);
    expect((await buscarCobros(db, cobranzas, { clienteId: clienteB })).length).toBe(0);
    expect(await buscarCobros(db, facturacion)).toEqual([]);
    expect(await buscarCobros(db, ventas)).toEqual([]);
    expect([...ROLES_COBRAN].sort()).toEqual(['cobranzas', 'gerencia', 'tesoreria']);
    expect(ROLES_COBRAN as readonly string[]).not.toContain('facturacion');                      // quien factura no aplica cobros
    expect([...ROLES_VEN_COBROS].sort()).toEqual(['auditor', 'cobranzas', 'contabilidad', 'gerencia', 'jefe_contabilidad', 'supervisor_ventas', 'tesoreria']);
    expect([...ROLES_GESTIONAN_CUENTAS].sort()).toEqual(['gerencia', 'tesoreria']);
    expect(ROLES_VEN_CUENTAS as readonly string[]).toContain('cobranzas');
  });

  it('al final, el auxiliar de cuentas por cobrar y el de anticipos coinciden con el mayor, en bolívares y en USD, al centavo', async () => {
    const c = await cuadreCxC(db);
    expect(c).toMatchObject({ cuadra: true });
    expect(c.auxiliar_ves).toBe(c.mayor_ves);
    expect(c.auxiliar_usd).toBe(c.mayor_usd);
    // Saldo del mayor: las partidas abiertas (f4 de B; resto de f6, f7 y f9 de A) y nada más.
    expect(Number(c.auxiliar_ves)).toBe(800 + 1700 + 4000 + 4000);
    const { rows: asientos } = await db.query<{ n: number }>(`select count(*)::int as n from asiento where estado <> 'contabilizado' and tipo = 'automatico'`);
    expect(asientos[0].n).toBe(0);
  });
});
