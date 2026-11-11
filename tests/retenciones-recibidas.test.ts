import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cifrasIva, declarar, type UsuarioDecl } from '@/lib/fiscal/declaraciones';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { cuadreCxC, registrarCobro } from '@/lib/ventas/cobros';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import { anularRetencion, documentosRetenibles, listarRetenciones, registrarRetencion } from '@/lib/ventas/retenciones';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Retenciones de IVA e ISLR que nos practican los clientes (§6.3, §11.2, §11.4; migración 0059, R-RR1 a R-RR5).
 * Tasa fija de 40 Bs. por US$. Cada factura: 10 pastillas de US$ 10 → base Bs. 4.000, IVA 16 % Bs. 640, total Bs. 4.640 (US$ 116).
 * P1 = hace dos meses, P2 = el mes pasado. PGlite toma la hora de Date.now(): se adelanta o atrasa el reloj para emitir en esos meses.
 */
describe('retenciones recibidas de clientes (R-RR1 a R-RR5)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let contador: UsuarioDecl;
  let gerente: Usuario;
  let cliente = '';
  let mostrador = '';
  let pastilla = '';
  let cuentaVes = '';
  let transferencia = '';
  let hoy = '';
  let p1 = { anio: 0, mes: 0, dia: '' };
  let p2 = { anio: 0, mes: 0, dia: '' };
  const F: Record<string, string> = {};
  const R: Record<string, string> = {};

  const real = Date.now.bind(Date);
  let desfase = 0;
  Date.now = () => real() + desfase;
  /** Lleva el reloj al mediodía de Caracas de `fecha`. */
  const reloj = (fecha: string | null) => { desfase = fecha ? Date.parse(`${fecha}T16:00:00Z`) - real() : 0; };

  const como = <T,>(u: { id: string }, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const partida = async (doc: string) => (await db.query<{ saldo: string; saldo_usd: string; estado: string }>(
    'select saldo::text, saldo_usd::text, estado from partida_cxc where documento_id = $1', [doc])).rows[0];
  const asiento = async (id: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = 'retencion_venta' and a.origen_id = $1 order by l.id`, [id])).rows;
  const cuadra = async () => expect(await cuadreCxC(db)).toMatchObject({ cuadra: true });

  async function facturar(): Promise<string> {
    const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: pastilla, cantidad: '10' }));
    await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
    const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    return (await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }))).facturaId;
  }
  const retener = (documentoId: string, d: { impuesto?: 'iva' | 'islr'; comprobante?: string; fecha: string; base?: string; porcentaje?: string; monto?: string }) =>
    como(cobranzas, (tx) => registrarRetencion(tx, cobranzas, {
      documentoId, impuesto: d.impuesto ?? 'iva', numeroComprobante: d.comprobante ?? `${d.fecha.slice(0, 4)}${d.fecha.slice(5, 7)}${String(Object.keys(R).length + 1).padStart(8, '0')}`,
      fechaComprobante: d.fecha, base: d.base, porcentaje: d.porcentaje ?? '75', monto: d.monto,
    }));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const usuario = async (email: string, roles: string[]) => ({ id: await usuarioDePrueba(db, email, roles), roles });
    gerente = await usuario('gerente@prueba.test', ['gerencia']);
    ventas = await usuario('ventas@prueba.test', ['ventas']);
    facturacion = await usuario('facturacion@prueba.test', ['facturacion']);
    almacenista = await usuario('almacen@prueba.test', ['almacen']);
    cobranzas = await usuario('cobranzas@prueba.test', ['cobranzas']);
    contador = await usuario('contador@prueba.test', ['contabilidad']);
    const tesoreria = await usuario('tesoreria@prueba.test', ['tesoreria']);

    const f = (await db.query<{ hoy: string; p1: string; p2: string }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as hoy,
              (date_trunc('month', (now() at time zone 'America/Caracas')::date) - interval '2 months')::date::text as p1,
              (date_trunc('month', (now() at time zone 'America/Caracas')::date) - interval '1 month')::date::text as p2`)).rows[0];
    hoy = f.hoy;
    p1 = { anio: Number(f.p1.slice(0, 4)), mes: Number(f.p1.slice(5, 7)), dia: `${f.p1.slice(0, 8)}10` };
    p2 = { anio: Number(f.p2.slice(0, 4)), mes: Number(f.p2.slice(5, 7)), dia: `${f.p2.slice(0, 8)}05` };
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    for (const a of new Set([p1.anio, p2.anio, Number(hoy.slice(0, 4))])) await db.query('select fn_crear_periodos($1)', [a]);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series($1::date - 75, $1::date, interval '1 day') d`, [hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [almacenista.id]));
    const vend = await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: ventas.id }));
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    // Cliente contribuyente especial, agente de retención de IVA.
    const c = await db.transaction((tx) => crearCliente(tx, facturacion.id, {
      rif: 'J-00000010-7', tercero: { razonSocial: 'Transporte Lara, C.A.', domiciliado: true, contribuyenteEspecial: true, agenteRetencionIva: true }, comercial: { vendedorId: vend.id },
    }));
    cliente = c.id;
    await db.transaction((tx) => aprobarCliente(tx, cliente, gerente.id, { condicionPagoId: cr30, limiteCreditoUsd: '100000', nivelPrecio: 'B', descuentoPct: '0' }));

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-PF', { descripcion: 'Pastilla de freno' }));
    pastilla = await db.transaction((tx) => crearProducto(tx, almacenista.id, 'PF-001', {
      descripcion: 'Pastilla de freno', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
    reloj(f.p1);                                                   // el precio y la existencia rigen desde P1
    await db.transaction((tx) => fijarPrecio(tx, pastilla, 'B', '10.00', f.p1));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 500, 4, 'prueba', gen_random_uuid())`, [pastilla, mostrador]));
    reloj(null);
    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-11' }))).id;
    transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;

    // P1: tres facturas. P2: una.
    reloj(p1.dia);
    F.f1 = await facturar();
    F.f2 = await facturar();
    F.f5 = await facturar();
    reloj(p2.dia);
    F.f3 = await facturar();
    reloj(null);
  }, 120_000);
  afterAll(async () => { Date.now = real; await cerrar(); });

  it('retención de IVA del 75 %: el monto lo calcula la base, baja la cuenta por cobrar a su valor histórico y genera su asiento', async () => {
    const r = await retener(F.f1, { fecha: p1.dia });
    R.f1 = r.id;
    expect(r.monto).toBe('480.00');                               // 640 × 75 %
    expect(await partida(F.f1)).toEqual({ saldo: '4160.00', saldo_usd: '104.00', estado: 'abierta' });   // 116 − 116 × 480 ÷ 4.640
    expect(await asiento(r.id)).toEqual([
      { codigo: '1.2.04', debe_ves: '480.00', haber_ves: '0.00', debe_usd: '12.00', haber_usd: '0.00' },
      { codigo: '1.2.01', debe_ves: '0.00', haber_ves: '480.00', debe_usd: '0.00', haber_usd: '12.00' },
    ]);
    await cuadra();
    const [fila] = await listarRetenciones(db, { periodo: `${p1.dia.slice(0, 7)}` });
    expect(fila).toMatchObject({ impuesto: 'iva', base: '640.00', porcentaje: '75.00', monto: '480.00', estado: 'registrada' });
  });

  it('valida porcentaje vigente, IVA sujeto, comprobante, fechas, saldo y una sola retención por documento e impuesto', async () => {
    await db.query('update tercero set agente_retencion_iva = false where id = $1', [cliente]);
    await esperarError(retener(F.f2, { fecha: p1.dia }), 'no está marcado como agente de retención');
    await db.query('update tercero set agente_retencion_iva = true where id = $1', [cliente]);
    await esperarError(retener(F.f2, { fecha: p1.dia, porcentaje: '50' }), 'uno de los vigentes');
    await esperarError(retener(F.f2, { fecha: p1.dia, base: '641' }), 'supera el IVA del documento');
    await esperarError(retener(F.f2, { fecha: p1.dia, comprobante: '123' }), '14 dígitos');
    await esperarError(retener(F.f2, { fecha: '2099-01-01' }), 'futura');
    await esperarError(retener(F.f2, { fecha: '2000-01-01' }), 'anterior al documento');
    await esperarError(retener(F.f1, { fecha: p1.dia }), 'ya tiene su retención de IVA');                    // F1 ya tiene su retención de IVA
    // ISLR: el monto no pasa del porcentaje de la base, y la base no pasa de la del documento.
    await esperarError(retener(F.f2, { impuesto: 'islr', comprobante: 'ISLR-1', fecha: p1.dia, base: '4000', porcentaje: '2', monto: '81' }), 'supera el 2');
    await esperarError(retener(F.f2, { impuesto: 'islr', comprobante: 'ISLR-1', fecha: p1.dia, base: '4001', porcentaje: '2', monto: '10' }), 'base imponible');
    const islr = await retener(F.f2, { impuesto: 'islr', comprobante: 'ISLR-1', fecha: p1.dia, base: '4000', porcentaje: '2', monto: '80' });
    R.islr = islr.id;
    expect((await asiento(islr.id)).map((l) => [l.codigo, l.debe_ves, l.haber_ves])).toEqual([['1.2.05', '80.00', '0.00'], ['1.2.01', '0.00', '80.00']]);
    expect(await partida(F.f2)).toMatchObject({ saldo: '4560.00' });
    // No se edita ni se borra.
    await esperarError(como(gerente, (tx) => tx.query('update retencion_venta set monto = 1 where id = $1', [R.f1])), 'no se edita');
    await esperarError(como(gerente, (tx) => tx.query('delete from retencion_venta where id = $1', [R.f1])), 'no se borra');
    await cuadra();
  });

  it('el cobro neto más la retención cancelan la factura', async () => {
    await como(cobranzas, async (tx) => registrarCobro(tx, cobranzas, {
      clienteId: cliente, fecha: p1.dia, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, referencia: 'T-1', monto: '4160.00',
      aplicaciones: [{ partidaId: (await tx.query<{ id: string }>('select id from partida_cxc where documento_id = $1', [F.f1])).rows[0].id, monto: '4160.00' }],
    }));
    expect(await partida(F.f1)).toEqual({ saldo: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    // Una factura cancelada ya no admite retención: no tiene saldo.
    expect((await documentosRetenibles(db, cliente)).map((d) => d.id)).not.toContain(F.f1);
    await cuadra();
  });

  it('la retención de IVA se declara en el mes del comprobante, aunque la factura sea de otro mes', async () => {
    const r = await retener(F.f2, { fecha: p2.dia });            // factura de P1, comprobante de P2
    R.f2 = r.id;
    const [fila] = (await listarRetenciones(db, { impuesto: 'iva' })).filter((x) => x.id === r.id);
    expect(fila.periodo).toBe(`${p2.dia.slice(5, 7)}-${p2.dia.slice(0, 4)}`);
  });

  it('declaración de P1: la cuota baja por las retenciones del mes; anular una retención declarada se rechaza', async () => {
    const c = await cifrasIva(db, p1.anio, p1.mes);
    // Débito: 3 facturas × 640 = 1.920. Retenciones de P1: solo la de F1 (480); la de F2 es de P2.
    expect(c).toMatchObject({ debito: '1920.00', credito: '0.00', resultado: '1920.00', retencionesSoportadas: '480.00', retencionesAnteriores: '0.00',
      retencionesDescontadas: '480.00', cuotaPagar: '1440.00', retencionesSiguiente: '0.00' });
    await como(contador, (tx) => declarar(tx, contador, { tipo: 'iva', anio: p1.anio, mes: p1.mes }));
    await esperarError(como(contador, (tx) => anularRetencion(tx, contador as Usuario, R.f1, 'Comprobante duplicado')), 'ya está declarado');
  });

  it('un comprobante de un mes ya declarado se descuenta en el mes en que se registra', async () => {
    const r = await retener(F.f5, { fecha: p1.dia });            // P1 ya está declarado
    R.f5 = r.id;
    const [fila] = (await listarRetenciones(db, { impuesto: 'iva' })).filter((x) => x.id === r.id);
    expect(fila.periodo).toBe(`${hoy.slice(5, 7)}-${hoy.slice(0, 4)}`);
  });

  it('retenciones mayores que la cuota: lo que sobra se traslada al mes siguiente', async () => {
    // P2: débito 640 (F3). Retenciones de P2: F2 (480) + F3 al 100 % (640) = 1.120 → se descuentan 640 y se trasladan 480.
    const r = await retener(F.f3, { fecha: p2.dia, porcentaje: '100' });
    expect(r.monto).toBe('640.00');
    const c = await cifrasIva(db, p2.anio, p2.mes);
    expect(c).toMatchObject({ debito: '640.00', resultado: '640.00', retencionesSoportadas: '1120.00', retencionesDescontadas: '640.00', cuotaPagar: '0.00', retencionesSiguiente: '480.00' });
    await como(contador, (tx) => declarar(tx, contador, { tipo: 'iva', anio: p2.anio, mes: p2.mes }));
    const { rows } = await db.query<{ r: string }>(`select retenciones_siguiente::text as r from declaracion_fiscal where tipo = 'iva' and anio = $1 and mes = $2`, [p2.anio, p2.mes]);
    expect(rows[0].r).toBe('480.00');
    // El mes actual las recibe: 480 que trae + 480 de F5.
    const actual = await cifrasIva(db, Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)));
    expect(actual).toMatchObject({ retencionesAnteriores: '480.00', retencionesSoportadas: '480.00', debito: '0.00', cuotaPagar: '0.00', retencionesSiguiente: '960.00' });
  });

  it('anular una retención no declarada devuelve el saldo y reversa el asiento; un documento con retención no se anula', async () => {
    await esperarError(como(gerente, (tx) => tx.query(
      `update documento_venta set estado = 'anulado', anulado_motivo = 'Prueba de anulación',
              anulado_motivo_id = (select id from motivo where tipo = 'anulacion' and codigo = 'OTRO') where id = $1`, [F.f5])), 'anúlelas primero');
    expect(await partida(F.f5)).toMatchObject({ saldo: '4160.00' });
    await como(cobranzas, (tx) => anularRetencion(tx, cobranzas, R.f5, 'El cliente envió el comprobante equivocado'));
    expect(await partida(F.f5)).toEqual({ saldo: '4640.00', saldo_usd: '116.00', estado: 'abierta' });
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from asiento where origen_tipo = 'retencion_venta' and origen_id = $1`, [R.f5]);
    expect(Number(rows[0].n)).toBe(2);                            // el asiento y su reverso
    const { rows: rev } = await db.query<{ ves: string }>(
      `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves from asiento_linea l join asiento a on a.id = l.asiento_id
         join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '1.2.04' and a.estado = 'contabilizado'`);
    // 1.2.04 queda con lo vigente: F1 480 + F2 480 + F3 640 = 1.600.
    expect(rev[0].ves).toBe('1600.00');
    await esperarError(como(cobranzas, (tx) => anularRetencion(tx, cobranzas, R.f5, 'Otra vez')), 'ya está anulada');
    // Anulada, se puede registrar de nuevo con el comprobante correcto.
    await retener(F.f5, { fecha: hoy, comprobante: `${hoy.slice(0, 4)}${hoy.slice(5, 7)}00009999` });
    await cuadra();
  });
});
