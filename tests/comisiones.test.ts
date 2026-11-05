import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asignarPlan, calcularComision, crearPlan, devengarAplicaciones, enviarPlan, generarLiquidaciones, movimientosDe, ordenarReglas, pagarLiquidacion, reglaDe, resumenPorVendedor,
  saldoAuxiliarComisiones, type LineaFactura, type ReglaPlan, type UsuarioCom,
} from '@/lib/comisiones/comisiones';
import { cuadreAuxiliares } from '@/lib/contabilidad/cierre';
import { rentabilidadPor, rentabilidadTotal } from '@/lib/contabilidad/rentabilidad';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { anularCobro, registrarCobro } from '@/lib/ventas/cobros';
import { facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const d = (v: string | number) => new Decimal(v);
const linea = (base: number, grupoId: string | null, marcaId: string | null = null): LineaFactura => ({ baseUsd: d(base), grupoId, marcaId, grupo: grupoId ?? 'Sin grupo', marca: marcaId ?? 'Sin marca' });
const regla = (grupoId: string | null, marcaId: string | null, pct: number): ReglaPlan => ({ grupoId, marcaId, porcentaje: d(pct) });

describe('comisiones: cálculo puro', () => {
  it('la regla de una línea es la primera que coincide; sin coincidencia no comisiona', () => {
    const reglas = [regla('A', 'M', 5), regla('A', null, 3), regla(null, null, 1)];
    expect(reglaDe({ grupoId: 'A', marcaId: 'M' }, reglas)?.porcentaje.toFixed(2)).toBe('5.00');
    expect(reglaDe({ grupoId: 'A', marcaId: 'X' }, reglas)?.porcentaje.toFixed(2)).toBe('3.00');
    expect(reglaDe({ grupoId: 'B', marcaId: 'X' }, reglas)?.porcentaje.toFixed(2)).toBe('1.00');
    expect(reglaDe({ grupoId: 'B', marcaId: null }, [regla('A', null, 3)])).toBeNull();
  });

  it('las reglas se ordenan de la más específica a la más general', () => {
    const o = ordenarReglas([{ porcentaje: '1' }, { grupoId: 'g', porcentaje: '2' }, { marcaId: 'm', porcentaje: '3' }, { grupoId: 'g', marcaId: 'm', porcentaje: '4' }]);
    expect(o.map((r) => r.porcentaje)).toEqual(['4', '2', '3', '1']);
  });

  it('lo cobrado se reparte entre las líneas según su base y cada una toma su porcentaje', () => {
    // Base cobrada 150 de una factura de 300 (200 en A al 2 %, 100 en B al 5 %): 150 × 2/3 × 2 % + 150 × 1/3 × 5 % = 2,00 + 2,50.
    const c = calcularComision(d(150), [linea(200, 'A'), linea(100, 'B')], [regla('B', null, 5), regla(null, null, 2)]);
    expect(c.monto.toFixed(2)).toBe('4.50');
    expect(c.porcentaje).toBe('3.0000');
    expect(c.detalle.map((x) => [x.baseUsd, x.porcentaje, x.montoUsd])).toEqual([['100.00', '2.00', '2.00'], ['50.00', '5.00', '2.50']]);
  });

  it('sin base, sin líneas o sin reglas la comisión es cero', () => {
    expect(calcularComision(d(0), [linea(100, 'A')], [regla(null, null, 2)]).monto.toFixed(2)).toBe('0.00');
    expect(calcularComision(d(10), [], [regla(null, null, 2)]).monto.toFixed(2)).toBe('0.00');
    expect(calcularComision(d(10), [linea(100, 'A')], []).monto.toFixed(2)).toBe('0.00');
  });
});

describe('comisiones con base cobrada (R-DU a R-DX)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let supervisor: Usuario;
  let gerente: Usuario;
  let gerente2: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let tesoreria: Usuario;
  let contador: Usuario;
  let mostrador: string;
  let vPedro = '';
  let vAna = '';
  let vExterno = '';
  let aceite = '';
  let pastilla = '';
  let grupoFrenos = '';
  let cuentaUsd = '';
  let cuentaVes = '';
  let transferencia = '';
  let motivoDevolucion = '';
  let OTRO = '';
  let hoy = '';
  let planId = '';
  const clientes: Record<string, string> = {};

  const como = <T,>(u: UsuarioCom, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  async function facturar(cliente: string, lineas: [string, string][]): Promise<{ factura: string; partida: string; lineaId: string }> {
    const pedido = await como(supervisor, (tx) => crearPedido(tx, supervisor, { clienteId: cliente, almacenId: mostrador }));
    for (const [p, c] of lineas) await como(supervisor, (tx) => agregarLinea(tx, supervisor, pedido, { productoId: p, cantidad: c }));
    await como(supervisor, (tx) => emitirPedido(tx, supervisor, pedido));
    const nota = await como(supervisor, (tx) => generarNotaEntrega(tx, supervisor, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const p = (await db.query<{ id: string }>('select id from partida_cxc where documento_id = $1', [f.facturaId])).rows[0].id;
    const l = (await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1 order by linea limit 1', [f.facturaId])).rows[0].id;
    return { factura: f.facturaId, partida: p, lineaId: l };
  }
  const cobrar = (cliente: string, partida: string, montoVes: string) => como(cobranzas, (tx) => registrarCobro(tx, cobranzas, {
    clienteId: cliente, fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, monto: montoVes, aplicaciones: [{ partidaId: partida, monto: montoVes }],
  }));
  const movs = async (vendedor: string) => (await db.query<{ tipo: string; origen_tipo: string; monto_usd: string; monto_ves: string; porcentaje: string; base_usd: string; calculo: { lineas: unknown[] }; asiento_id: string }>(
    `select tipo, origen_tipo, monto_usd::text, monto_ves::text, porcentaje::text, base_usd::text, calculo, asiento_id from comision_movimiento where vendedor_id = $1 order by id`, [vendedor])).rows;
  const lineasAsiento = async (asientoId: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id where l.asiento_id = $1 order by l.id`, [asientoId])).rows;
  const mayor2107 = async () => (await db.query<{ ves: string; usd: string }>(
    `select coalesce(sum(l.haber_ves - l.debe_ves), 0)::text as ves, coalesce(sum(l.haber_usd - l.debe_usd), 0)::text as usd from asiento_linea l
       join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '2.1.07'`)).rows[0];
  const decidir = (tipo: string, id: string, u: UsuarioCom, decision: 'aprobada' | 'rechazada', motivo = 'No corresponde') =>
    como(u, (tx) => resolverAprobacion(tx, tipo, id, u.id, decision, decision === 'rechazada' ? { comentario: motivo } : {}));
  const liquidacionDe = async (vendedor: string, estado?: string) => (await db.query<{ id: string; estado: string; neto_usd: string; neto_ves: string }>(
    `select id, estado, neto_usd::text, neto_ves::text from liquidacion_comision where vendedor_id = $1 ${estado ? `and estado = '${estado}'` : ''} order by numero desc limit 1`, [vendedor])).rows[0];

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const id = async (email: string, roles: string[]) => ({ id: await usuarioDePrueba(db, email, roles), roles });
    gerente = await id('gerente@prueba.test', ['gerencia']);
    gerente2 = await id('gerente2@prueba.test', ['gerencia', 'ventas']);
    ventas = await id('ventas@prueba.test', ['ventas']);
    supervisor = await id('supervisor@prueba.test', ['supervisor_ventas']);
    facturacion = await id('facturacion@prueba.test', ['facturacion']);
    almacenista = await id('almacen@prueba.test', ['almacen']);
    cobranzas = await id('cobranzas@prueba.test', ['cobranzas']);
    tesoreria = await id('tesoreria@prueba.test', ['tesoreria']);
    contador = await id('contador@prueba.test', ['contabilidad']);

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 40.000000)`, [hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [almacenista.id]));

    // Pedro (interno) y Ana (interno, usuario con rol de Gerencia: no puede aprobar su propia liquidación) y un externo.
    vPedro = (await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: ventas.id }))).id;
    vAna = (await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Ana Rojas', tipo: 'interno', usuarioId: gerente2.id }))).id;
    vExterno = (await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Luis Comisionista', tipo: 'externo', rif: 'J-00000010-7' }))).id;
    const vCasa = (await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Mostrador', tipo: 'casa' }))).id;
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string, vendedorId: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, facturacion.id, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, gerente.id, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    clientes.pedro = await cliente('J-00000020-4', 'Repuestos Lara, C.A.', vPedro);
    clientes.ana = await cliente('J-00000030-1', 'Frenos del Centro, C.A.', vAna);
    clientes.externo = await cliente('J-00000040-9', 'Autopartes Sur, C.A.', vExterno);
    clientes.sinPlan = await cliente('J-00000050-6', 'Lubricantes del Este, C.A.', vCasa);

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const grupoLub = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'LUB', 'Lubricantes'));
    grupoFrenos = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'FRE', 'Frenos'));
    const nuevo = async (codigo: string, alicuota: string, precio: string, grupoId: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      const p = await db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, grupoId, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
      await db.transaction((tx) => fijarPrecio(tx, p, 'B', precio, hoy));
      await como(almacenista, (tx) => tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id) values ('entrada_compra', $1, $2, 500, 4, 'prueba', gen_random_uuid())`, [p, mostrador]));
      return p;
    };
    aceite = await nuevo('AC-001', exento, '20.00', grupoLub);
    pastilla = await nuevo('PF-001', general, '10.00', grupoFrenos);

    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    cuentaUsd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-0000-22' }))).id;
    transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;
    motivoDevolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;
  });
  afterAll(() => cerrar());

  describe('planes y asignación', () => {
    it('un plan se crea con reglas válidas, se envía, y lo aprueba Gerencia distinta de quien lo creó', async () => {
      await esperarError(como(ventas, (tx) => crearPlan(tx, ventas, { nombre: 'Plan', reglas: [{ porcentaje: '2' }] })), 'Solo Gerencia o el Supervisor de ventas');
      await esperarError(como(supervisor, (tx) => crearPlan(tx, supervisor, { nombre: 'Plan', reglas: [] })), 'al menos una regla');
      await esperarError(como(supervisor, (tx) => crearPlan(tx, supervisor, { nombre: 'Plan', reglas: [{ porcentaje: '150' }] })), 'entre 0 y 100');
      await esperarError(como(supervisor, (tx) => crearPlan(tx, supervisor, { nombre: 'Plan', reglas: [{ porcentaje: '2' }, { porcentaje: '3' }] })), 'mismo grupo y la misma marca');
      planId = await como(supervisor, (tx) => crearPlan(tx, supervisor, { nombre: 'Plan comercial', reglas: [{ porcentaje: '2' }, { grupoId: grupoFrenos, porcentaje: '5' }] }));
      const reglas = (await db.query<{ prioridad: number; grupo: string | null; porcentaje: string }>(
        'select prioridad, grupo_producto_id as grupo, porcentaje::text from plan_comision_regla where plan_id = $1 order by prioridad', [planId])).rows;
      expect(reglas.map((r) => [r.prioridad, r.grupo === grupoFrenos, r.porcentaje])).toEqual([[1, true, '5.00'], [2, false, '2.00']]);   // la específica primero
      await esperarError(como(gerente, (tx) => enviarPlan(tx, gerente, planId)), 'Solo quien creó el plan');
      await esperarError(como(supervisor, (tx) => asignarPlan(tx, supervisor, { vendedorId: vPedro, planId, desde: hoy })), 'plan aprobado');
      await como(supervisor, (tx) => enviarPlan(tx, supervisor, planId));
      await esperarError(db.query(`update plan_comision set estado = 'aprobado', aprobado_por = creado_por where id = $1`, [planId]), 'distinta de quien creó');
      await esperarError(decidir('plan_comision', planId, supervisor, 'aprobada'), 'o');
      await decidir('plan_comision', planId, gerente, 'aprobada');
      expect((await db.query<{ estado: string }>('select estado from plan_comision where id = $1', [planId])).rows[0].estado).toBe('aprobado');
    });

    it('un plan aprobado no se edita ni se borra, y sus reglas tampoco', async () => {
      await esperarError(db.query(`update plan_comision_regla set porcentaje = 9 where plan_id = $1`, [planId]), 'no se modifican');
      await esperarError(db.query(`insert into plan_comision_regla (plan_id, prioridad, porcentaje) values ($1, 9, 1)`, [planId]), 'no se modifican');
      await esperarError(db.query(`update plan_comision set nombre = 'Otro nombre' where id = $1`, [planId]), 'no cambia su nombre');
      await esperarError(db.query('delete from plan_comision where id = $1', [planId]), 'no se borra');
    });

    it('se asigna por fechas, sin traslapes, solo a vendedores internos o externos', async () => {
      for (const v of [vPedro, vAna, vExterno]) await como(supervisor, (tx) => asignarPlan(tx, supervisor, { vendedorId: v, planId, desde: hoy }));
      await esperarError(como(supervisor, (tx) => asignarPlan(tx, supervisor, { vendedorId: vPedro, planId, desde: hoy })), 'ya tiene un plan vigente');
      const casa = (await db.query<{ id: string }>(`select id from vendedor where tipo = 'casa'`)).rows[0].id;
      await esperarError(como(supervisor, (tx) => asignarPlan(tx, supervisor, { vendedorId: casa, planId, desde: hoy })), 'internos o externos');
      await esperarError(como(ventas, (tx) => asignarPlan(tx, ventas, { vendedorId: vPedro, planId, desde: hoy })), 'Solo Gerencia o el Supervisor de ventas');
      await esperarError(db.query(`delete from vendedor_plan`), 'se cierra con fecha final');
    });
  });

  describe('devengo, reversión y movimientos', () => {
    let fp: { factura: string; partida: string; lineaId: string };

    it('un cobro parcial devenga la comisión de lo cobrado sin IVA, repartida entre las líneas, con su asiento', async () => {
      fp = await facturar(clientes.pedro, [[aceite, '10'], [pastilla, '10']]);       // base US$ 300 (200 + 100), IVA 16: total US$ 316 = Bs 12.640
      await db.query(`update tasa_cambio set tasa = 44 where fecha = $1 and moneda = 'USD'`, [hoy]);
      await cobrar(clientes.pedro, fp.partida, '6320.00');                            // la mitad: US$ 158 → base 150
      const m = await movs(vPedro);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ tipo: 'devengo', origen_tipo: 'aplicacion_cobro', monto_usd: '4.50', base_usd: '150.00', porcentaje: '3.0000', monto_ves: '198.00' });
      expect(m[0].calculo.lineas).toHaveLength(2);
      expect(await lineasAsiento(m[0].asiento_id)).toEqual([
        { codigo: '6.1.01', debe_ves: '198.00', haber_ves: '0.00', debe_usd: '4.50', haber_usd: '0.00' },
        { codigo: '2.1.07', debe_ves: '0.00', haber_ves: '198.00', debe_usd: '0.00', haber_usd: '4.50' },
      ]);
    });

    it('cobrar el resto devenga lo que falta, y devengar de nuevo la misma aplicación no duplica', async () => {
      await cobrar(clientes.pedro, fp.partida, '6320.00');
      expect((await movs(vPedro)).map((x) => x.monto_usd)).toEqual(['4.50', '4.50']);
      const aplicaciones = (await db.query<{ id: string }>('select id from aplicacion_cobro')).rows.map((r) => r.id);
      expect(await como(contador, (tx) => devengarAplicaciones(tx, contador, aplicaciones))).toBe(0);
    });

    it('sin plan en la fecha de la factura no hay comisión: el vendedor de la casa y la factura de apertura no comisionan', async () => {
      const f = await facturar(clientes.sinPlan, [[aceite, '5']]);
      await cobrar(clientes.sinPlan, f.partida, '4400.00');
      expect((await db.query('select 1 from comision_movimiento m join vendedor v on v.id = m.vendedor_id where v.tipo = \'casa\'')).rows).toHaveLength(0);
    });

    it('una nota de crédito de devolución sobre una factura que ya comisionó revierte la parte proporcional, al mismo valor en bolívares', async () => {
      const fq = await facturar(clientes.pedro, [[aceite, '10']]);                    // base US$ 200 = Bs 8.800 (a 44)
      await cobrar(clientes.pedro, fq.partida, '4400.00');                            // US$ 100 cobrados → 2 % = US$ 2,00 (Bs 88)
      const nc = await como(ventas, (tx) => crearNotaCredito(tx, ventas, { facturaId: fq.factura, clase: 'devolucion', motivoId: motivoDevolucion, lineas: [{ lineaId: fq.lineaId, cantidad: '5' }] }));
      await como(ventas, (tx) => enviarAprobacion(tx, ventas, nc));
      await decidir('nota_credito', nc, supervisor, 'aprobada');
      await como(facturacion, (tx) => emitirNota(tx, facturacion, nc, { servicio: new ImprentaSimulada() }));
      const m = (await movs(vPedro)).slice(2);
      expect(m.map((x) => [x.tipo, x.origen_tipo, x.monto_usd, x.monto_ves])).toEqual([['devengo', 'aplicacion_cobro', '2.00', '88.00'], ['reversion', 'nota_credito', '-1.00', '-44.00']]);   // mitad de lo devengado
      expect(await lineasAsiento(m[1].asiento_id)).toEqual([
        { codigo: '2.1.07', debe_ves: '44.00', haber_ves: '0.00', debe_usd: '1.00', haber_usd: '0.00' },
        { codigo: '6.1.01', debe_ves: '0.00', haber_ves: '44.00', debe_usd: '0.00', haber_usd: '1.00' },
      ]);
    });

    it('anular un cobro revierte lo que devengó, exactamente', async () => {
      const fr = await facturar(clientes.pedro, [[aceite, '5']]);
      const c = await cobrar(clientes.pedro, fr.partida, '4400.00');
      expect((await movs(vPedro)).slice(4).map((x) => x.monto_usd)).toEqual(['2.00']);
      await como(gerente, (tx) => anularCobro(tx, gerente, c.id, { motivoId: OTRO, detalle: 'Prueba' }));
      const m = (await movs(vPedro)).slice(4);
      expect(m.map((x) => [x.tipo, x.monto_usd, x.monto_ves])).toEqual([['devengo', '2.00', '88.00'], ['reversion', '-2.00', '-88.00']]);
    });

    it('un movimiento no se modifica, no se borra y no cambia de liquidación', async () => {
      await esperarError(db.query(`update comision_movimiento set monto_usd = 99 where id = (select min(id) from comision_movimiento)`), 'no se modifica');
      await esperarError(db.query('delete from comision_movimiento'), 'no se borra');
      await esperarError(db.query(`update comision_movimiento set liquidacion_id = gen_random_uuid() where id = (select min(id) from comision_movimiento)`), 'solo entra en una liquidación pendiente');
    });

    it('un vendedor ve solo lo suyo y Gerencia ve todo', async () => {
      await cobrar(clientes.ana, (await facturar(clientes.ana, [[aceite, '5']])).partida, '4400.00');      // Ana: US$ 2,00
      const propios = await movimientosDe(db, ventas, {});
      expect(new Set(propios.map((x) => x.vendedor))).toEqual(new Set(['Pedro Pérez']));
      const todos = await movimientosDe(db, gerente, {});
      expect(new Set(todos.map((x) => x.vendedor))).toEqual(new Set(['Pedro Pérez', 'Ana Rojas']));
      expect((await resumenPorVendedor(db, ventas)).map((r) => r.vendedor)).toEqual(['Pedro Pérez']);
      expect(await movimientosDe(db, { id: cobranzas.id, roles: ['cobranzas'] }, {})).toEqual([]);
    });

    it('el auxiliar de comisiones por pagar cuadra con el mayor y con el cierre, en bolívares y en dólares', async () => {
      const aux = await saldoAuxiliarComisiones(db);
      const mayor = await mayor2107();
      expect([aux.ves.toFixed(2), aux.usd.toFixed(2)]).toEqual([new Decimal(mayor.ves).toFixed(2), new Decimal(mayor.usd).toFixed(2)]);
      expect(aux.usd.toFixed(2)).toBe('12.00');                                       // Pedro 10,00 (4,50 + 4,50 + 2,00 − 1,00 + 2,00 − 2,00) + Ana 2,00
      const cuadres = (await cuadreAuxiliares(db)).filter((x) => x.nombre.startsWith('Comisiones'));
      expect(cuadres.map((x) => [x.moneda, x.ok])).toEqual([['VES', true], ['USD', true]]);
    });
  });

  describe('liquidación, aprobación y pago', () => {
    let periodo = '';
    let liqPedro = '';
    let liqAna = '';

    beforeAll(async () => {
      // El externo: un devengo más, para probar el bloqueo del pago sin retención.
      await cobrar(clientes.externo, (await facturar(clientes.externo, [[aceite, '5']])).partida, '4400.00');
      // Los movimientos de la prueba son de hoy; para liquidar un mes ya terminado se mueven 40 días atrás (solo en la prueba, sin disparadores).
      await db.query('set session_replication_role = replica');
      await db.query(`update comision_movimiento set fecha = fecha - 40`);
      await db.query('set session_replication_role = origin');
      periodo = (await db.query<{ p: string }>(`select to_char($1::date - 40, 'YYYY-MM') as p`, [hoy])).rows[0].p;
    });

    it('no se liquida un mes que no terminó, ni sin ser Contabilidad o Gerencia', async () => {
      await esperarError(como(contador, (tx) => generarLiquidaciones(tx, contador, hoy.slice(0, 7))), 'ya terminado');
      await esperarError(como(ventas, (tx) => generarLiquidaciones(tx, ventas, periodo)), 'Solo Contabilidad o Gerencia');
      await esperarError(como(contador, (tx) => generarLiquidaciones(tx, contador, 'mayo')), 'Indique el mes');
    });

    it('arma una liquidación por vendedor con su neto, y no repite el mes', async () => {
      const r = await como(contador, (tx) => generarLiquidaciones(tx, contador, periodo));
      expect(r.creadas.map((x) => [x.vendedor, x.netoUsd])).toEqual([['Ana Rojas', '2.00'], ['Luis Comisionista', '2.00'], ['Pedro Pérez', '10.00']]);
      const lp = await liquidacionDe(vPedro);
      liqPedro = lp.id;
      liqAna = (await liquidacionDe(vAna)).id;
      expect(lp).toMatchObject({ estado: 'pendiente', neto_usd: '10.00', neto_ves: '440.00' });
      const t = (await db.query<{ dev: string; rev: string }>('select total_devengado_usd::text as dev, total_reversiones_usd::text as rev from liquidacion_comision where id = $1', [liqPedro])).rows[0];
      expect([t.dev, t.rev]).toEqual(['13.00', '-3.00']);
      expect((await como(contador, (tx) => generarLiquidaciones(tx, contador, periodo))).creadas).toEqual([]);
    });

    it('Gerencia aprueba, distinta de quien la armó y que no sea el vendedor beneficiario', async () => {
      await esperarError(decidir('liquidacion_comision', liqAna, gerente2, 'aprobada'), 'su propia liquidación');
      await esperarError(db.query(`update liquidacion_comision set estado = 'aprobada', aprobado_por = $2 where id = $1`, [liqAna, gerente2.id]), 'no puede aprobar su propia');
      await decidir('liquidacion_comision', liqPedro, gerente, 'aprobada');
      expect((await liquidacionDe(vPedro)).estado).toBe('aprobada');
    });

    it('rechazada, la liquidación libera sus movimientos y se vuelve a armar', async () => {
      await decidir('liquidacion_comision', liqAna, gerente, 'rechazada', 'Falta revisar la factura');
      expect((await db.query('select 1 from comision_movimiento where liquidacion_id = $1', [liqAna])).rows).toHaveLength(0);
      const r = await como(contador, (tx) => generarLiquidaciones(tx, contador, periodo));
      expect(r.creadas.map((x) => x.vendedor)).toEqual(['Ana Rojas']);
      expect((await db.query('select 1 from liquidacion_comision where vendedor_id = $1', [vAna])).rows).toHaveLength(2);
    });

    it('Tesorería paga una aprobada: sale del banco, salda comisiones por pagar y la diferencia es diferencial cambiario', async () => {
      await esperarError(como(tesoreria, (tx) => pagarLiquidacion(tx, tesoreria, (liqAna), { cuentaBancariaId: cuentaUsd, fecha: hoy })), 'aprobada por Gerencia');
      await esperarError(como(cobranzas, (tx) => pagarLiquidacion(tx, cobranzas, liqPedro, { cuentaBancariaId: cuentaUsd, fecha: hoy })), 'Solo Tesorería o Gerencia');
      await esperarError(como(tesoreria, (tx) => pagarLiquidacion(tx, tesoreria, liqPedro, { cuentaBancariaId: cuentaUsd, fecha: '2999-01-01' })), 'no puede ser futura');
      await db.query(`update tasa_cambio set tasa = 50 where fecha = $1 and moneda = 'USD'`, [hoy]);
      const r = await como(tesoreria, (tx) => pagarLiquidacion(tx, tesoreria, liqPedro, { cuentaBancariaId: cuentaUsd, fecha: hoy, referencia: 'TR-1' }));
      expect(r.asiento).toBeTruthy();
      const asiento = (await db.query<{ asiento_pago_id: string; estado: string; tasa_pago: string }>('select asiento_pago_id, estado, tasa_pago::text from liquidacion_comision where id = $1', [liqPedro])).rows[0];
      expect([asiento.estado, asiento.tasa_pago]).toEqual(['pagada', '50.000000']);
      // Se debía Bs 440 (valor en libros, a 44) y salen Bs 500 (10 × 50): pérdida cambiaria de Bs 60.
      expect(await lineasAsiento(asiento.asiento_pago_id)).toEqual([
        { codigo: '2.1.07', debe_ves: '440.00', haber_ves: '0.00', debe_usd: '10.00', haber_usd: '0.00' },
        { codigo: '6.3.02', debe_ves: '60.00', haber_ves: '0.00', debe_usd: '0.00', haber_usd: '0.00' },
        { codigo: '1.1.03.01', debe_ves: '0.00', haber_ves: '500.00', debe_usd: '0.00', haber_usd: '10.00' },
      ]);
      await esperarError(como(tesoreria, (tx) => pagarLiquidacion(tx, tesoreria, liqPedro, { cuentaBancariaId: cuentaUsd, fecha: hoy })), 'ya está pagada');
    });

    it('un vendedor externo no se paga sin retención de ISLR', async () => {
      const e = await liquidacionDe(vExterno);
      await decidir('liquidacion_comision', e.id, gerente, 'aprobada');
      await esperarError(como(tesoreria, (tx) => pagarLiquidacion(tx, tesoreria, e.id, { cuentaBancariaId: cuentaUsd, fecha: hoy })), 'retención de ISLR');
      expect((await liquidacionDe(vExterno)).estado).toBe('aprobada');
    });

    it('lo pagado sale del auxiliar y todo sigue cuadrado con el mayor', async () => {
      const aux = await saldoAuxiliarComisiones(db);
      const mayor = await mayor2107();
      expect([aux.ves.toFixed(2), aux.usd.toFixed(2)]).toEqual([new Decimal(mayor.ves).toFixed(2), new Decimal(mayor.usd).toFixed(2)]);
      expect(aux.usd.toFixed(2)).toBe('4.00');                                        // Ana 2,00 + externo 2,00
      expect((await cuadreAuxiliares(db)).filter((x) => x.nombre.startsWith('Comisiones')).every((x) => x.ok)).toBe(true);        // el inventario de esta prueba entra sin asiento: no se compara aquí
    });

    it('una liquidación pagada no se modifica ni se borra', async () => {
      await esperarError(db.query(`update liquidacion_comision set neto_usd = 1 where id = $1`, [liqPedro]), 'no se modifican');
      await esperarError(db.query(`update liquidacion_comision set estado = 'aprobada' where id = $1`, [liqPedro]), 'no permitido');
      await esperarError(db.query('delete from liquidacion_comision'), 'no se borra');
    });
  });

  describe('rentabilidad', () => {
    it('la rentabilidad resta las comisiones devengadas, repartidas entre las líneas de su factura', async () => {
      const hastaHoy = hoy;
      const t = await rentabilidadTotal(db, '2000-01-01', hastaHoy);
      const total = (await db.query<{ s: string }>('select sum(monto_usd)::text as s from comision_movimiento')).rows[0].s;       // 10,00 + 2,00 + 2,00 = 14,00
      expect(Math.abs(Number(t.comisionUsd.toFixed(2)) - Number(total))).toBeLessThanOrEqual(0.05);
      expect(t.margenUsd.toFixed(2)).toBe(t.ventaNetaUsd.minus(t.costoUsd).minus(t.comisionUsd).toFixed(2));
      const porVendedor = await rentabilidadPor(db, 'vendedor', '2000-01-01', hastaHoy);
      expect(porVendedor.find((x) => x.nombre === 'Pedro Pérez')!.comisionUsd.toFixed(1)).toBe('10.0');
      const suma = porVendedor.reduce((s, x) => s.plus(x.comisionUsd), d(0));
      expect(suma.toFixed(2)).toBe(t.comisionUsd.toFixed(2));
    });
  });
});
