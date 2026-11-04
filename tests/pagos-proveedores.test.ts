import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearFactura, guardarLinea, registrarFactura } from '@/lib/compras/facturas';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea as lineaOrden, type Usuario } from '@/lib/compras/ordenes';
import {
  aplicarAnticipoPago, anularPago, buscarPagos, cuadreCxP, detallePago, partidasPorPagar, solicitarPago, type DatosPago,
} from '@/lib/compras/pagos';
import { recibirMercancia } from '@/lib/compras/recepciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Pagos a proveedores (spec §7.3, §12.3; migración 0038). Tasas: USD a Bs 40 hoy, 30 hace 10 días y 50 hace 20 días. Las facturas sin IVA
 * (producto exento) valen exactamente cantidad × precio, en USD.
 */
describe('pagos a proveedores: solicitud, aprobación, aplicación, diferencial, anticipos y anulación (R-BZ a R-CC)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let tesoreria: Usuario;
  let gerente: Usuario;
  let otroGerente: Usuario;
  let almacenista: Usuario;
  let a01 = '';
  let exento = '';
  let marca = '';
  let hoy = '';
  let hace10 = '';
  let hace20 = '';
  let cuentaVes = '';
  let cuentaUsd = '';
  let transferencia = '';
  let OTRO = '';
  let n = 0;
  const prov: Record<string, string> = {};

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const proveedor = async (clave: string) => {
    const n8 = String(22220000 + Object.keys(prov).length + 1);
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: `Proveedor ${clave}`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    prov[clave] = r.id;
  };
  const producto = async () => {
    const codigo = `PG-${++n}`;
    const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
    return db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
      descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: exento, inventariable: true,
    }));
  };
  /** Factura contabilizada de `cantidad` × `precio` USD (exenta), con fecha `fecha`; devuelve el id de su partida de cuentas por pagar. */
  const facturar = async (clave: string, cantidad: string, precio: string, fecha = hoy) => {
    const p = await producto();
    const orden = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: prov[clave], almacenId: a01, moneda: 'USD' }));
    await como(comprador, (tx) => lineaOrden(tx, orden, { productoId: p, cantidad, precio }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, orden));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', orden, gerente.id, 'aprobada'));
    const [l] = (await detalleOrden(db, orden))!.lineas;
    await como(almacenista, (tx) => recibirMercancia(tx, almacenista, orden, [{ lineaId: l.id, cantidad }]));
    const id = await como(comprador, (tx) => crearFactura(tx, comprador, { ordenId: orden, numeroFactura: `PF-${++n}`, numeroControl: `00-${n}`, fechaFactura: fecha }));
    await como(comprador, (tx) => guardarLinea(tx, id, { ordenLineaId: l.id, cantidad, precio }));
    await como(comprador, (tx) => registrarFactura(tx, comprador, id));
    return (await db.query<{ id: string }>('select id from partida_cxp where factura_id = $1', [id])).rows[0].id;
  };
  const datos = (clave: string, cuenta: string, monto: string, aplicaciones: DatosPago['aplicaciones'], extra: Partial<DatosPago> = {}): DatosPago => ({
    proveedorId: prov[clave], fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuenta, monto, aplicaciones, ...extra,
  });
  const solicitar = (d: DatosPago, u = tesoreria) => como(u, (tx) => solicitarPago(tx, u, d));
  const aprobar = (id: string, u = gerente) => como(u, (tx) => resolverAprobacion(tx, 'pago_proveedor', id, u.id, 'aprobada'));
  const rechazar = (id: string, comentario: string) => como(gerente, (tx) => resolverAprobacion(tx, 'pago_proveedor', id, gerente.id, 'rechazada', { comentario }));
  /** Solicita y aprueba. */
  const pagar = async (d: DatosPago) => { const r = await solicitar(d); await aprobar(r.id); return r.id; };
  const partida = async (id: string) =>
    (await db.query<{ saldo: string; saldo_ves: string; saldo_usd: string; estado: string }>(
      'select saldo::text, saldo_ves::text, saldo_usd::text, estado from partida_cxp where id = $1', [id])).rows[0];
  const asiento = async (tipo: string, origenId: string) =>
    (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
      `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [tipo, origenId])).rows
      .map((l) => [l.codigo.startsWith('1.1.') ? 'BANCO' : l.codigo, l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd]);
  const cuadra = async () => {
    const c = await cuadreCxP(db);
    expect(c.cuadra).toBe(true);
    const g = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
    expect([Number(g.ves), Number(g.usd)]).toEqual([0, 0]);
    return c;
  };

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idCom = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    const idTes = await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']);
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idGer2 = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    comprador = { id: idCom, roles: ['compras'] };
    tesoreria = { id: idTes, roles: ['tesoreria'] };
    gerente = { id: idGer, roles: ['gerencia'] };
    otroGerente = { id: idGer2, roles: ['gerencia'] };
    almacenista = { id: idAlm, roles: ['almacen'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    const f = (await db.query<{ hoy: string; h10: string; h20: string }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as hoy, (((now() at time zone 'America/Caracas')::date) - 10)::text as h10,
              (((now() at time zone 'America/Caracas')::date) - 20)::text as h20`)).rows[0];
    hoy = f.hoy; hace10 = f.h10; hace20 = f.h20;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 50), ($2::date, 'USD', 30), ($3::date, 'USD', 40)`, [hace20, hace10, hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, a01, [idAlm]));
    exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    cuentaUsd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-0000-22' }))).id;
    transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await proveedor(c);
  });
  afterAll(() => cerrar());

  it('solicitar no mueve nada: ni saldo, ni banco, ni asiento; queda pendiente de Gerencia', async () => {
    const p = await facturar('a', '100', '4.0000');                       // US$ 400
    const r = await solicitar(datos('a', cuentaUsd, '400', [{ partidaId: p, monto: '400' }]));
    expect(await partida(p)).toEqual({ saldo: '400.00', saldo_ves: '16000.00', saldo_usd: '400.00', estado: 'abierta' });
    const d = (await detallePago(db, r.id))!;
    expect([d.estado, d.asiento, d.aplicaciones.length, d.lineas.length]).toEqual(['solicitado', null, 0, 1]);
    expect(d.numero).toMatch(/^\d+$/);
    const pend = (await db.query<{ n: number }>(`select count(*)::int as n from solicitud_aprobacion where objeto_tipo = 'pago_proveedor' and objeto_id = $1 and estado = 'pendiente'`, [r.id])).rows[0];
    expect(pend.n).toBe(1);
    await aprobar(r.id);                                                  // lo deja pagado
  });

  it('aprobar aplica, sale del banco y asienta: debe cuentas por pagar, haber banco', async () => {
    const p = await facturar('b', '100', '4.0000');
    const r = await solicitar(datos('b', cuentaUsd, '400', [{ partidaId: p, monto: '400' }], { referencia: 'TRF-001' }));
    await aprobar(r.id);
    const d = (await detallePago(db, r.id))!;
    expect([d.estado, d.por_aplicar]).toEqual(['pagado', '0.00']);
    expect(d.aprobado_por).not.toBeNull();
    expect(await partida(p)).toEqual({ saldo: '0.00', saldo_ves: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    expect(await asiento('pago_proveedor', r.id)).toEqual([
      ['2.1.01', '16000.00', '0.00', '400.00', '0.00'],
      ['BANCO', '0.00', '16000.00', '0.00', '400.00'],
    ]);
    await cuadra();
  });

  it('quien solicitó el pago no lo aprueba; otra persona de Gerencia sí', async () => {
    const p = await facturar('c', '10', '4.0000');                         // US$ 40
    const r = await solicitar(datos('c', cuentaUsd, '40', [{ partidaId: p, monto: '40' }]), gerente);
    await expect(aprobar(r.id, gerente)).rejects.toThrow();
    expect((await detallePago(db, r.id))!.estado).toBe('solicitado');
    expect(await partida(p)).toMatchObject({ saldo: '40.00', estado: 'abierta' });
    await aprobar(r.id, otroGerente);
    expect((await detallePago(db, r.id))!.estado).toBe('pagado');
  });

  it('rechazar no mueve nada y deja el motivo', async () => {
    const p = await facturar('c', '10', '4.0000');
    const r = await solicitar(datos('c', cuentaUsd, '40', [{ partidaId: p, monto: '40' }]));
    await rechazar(r.id, 'Falta el soporte');
    const d = (await detallePago(db, r.id))!;
    expect([d.estado, d.rechazo_motivo, d.asiento]).toEqual(['rechazado', 'Falta el soporte', null]);
    expect(await partida(p)).toMatchObject({ saldo: '40.00', estado: 'abierta' });
  });

  it('diferencial cambiario, pérdida: se paga en bolívares a una tasa mayor que la de la factura', async () => {
    const p = await facturar('d', '25', '4.0000', hace10);                // US$ 100 a Bs 30 = Bs 3.000
    expect(await partida(p)).toMatchObject({ saldo_ves: '3000.00', saldo_usd: '100.00' });
    const id = await pagar(datos('d', cuentaVes, '4000', [{ partidaId: p, monto: '4000', liquida: true }]));   // Bs 4.000 = US$ 100 a Bs 40
    expect(await partida(p)).toEqual({ saldo: '0.00', saldo_ves: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    expect(await asiento('pago_proveedor', id)).toEqual([
      ['2.1.01', '3000.00', '0.00', '100.00', '0.00'],
      ['6.3.02', '1000.00', '0.00', '0.00', '0.00'],
      ['BANCO', '0.00', '4000.00', '0.00', '100.00'],
    ]);
    const a = (await detallePago(db, id))!.aplicaciones[0];
    expect([a.monto_partida, a.moneda_partida, a.dif_ves, a.dif_usd]).toEqual(['100.00', 'USD', '-1000.00', '0.00']);
    await cuadra();
  });

  it('diferencial cambiario, ganancia: se paga con una tasa menor que la de la factura', async () => {
    const p = await facturar('d', '25', '4.0000', hace20);                // US$ 100 a Bs 50 = Bs 5.000
    const id = await pagar(datos('d', cuentaVes, '4000', [{ partidaId: p, monto: '4000', liquida: true }]));
    expect(await asiento('pago_proveedor', id)).toEqual([
      ['2.1.01', '5000.00', '0.00', '100.00', '0.00'],
      ['BANCO', '0.00', '4000.00', '0.00', '100.00'],
      ['4.2.01', '0.00', '1000.00', '0.00', '0.00'],
    ]);
    await cuadra();
  });

  it('liquidar en otra moneda exige que el monto equivalga al saldo (con un centavo de tolerancia)', async () => {
    const p = await facturar('d', '25', '4.0000');                        // US$ 100
    const r = await solicitar(datos('d', cuentaVes, '3900', [{ partidaId: p, monto: '3900', liquida: true }]));   // Bs 3.900 = US$ 97,50
    await esperarError(aprobar(r.id), 'no liquida la factura');
    expect((await detallePago(db, r.id))!.estado).toBe('solicitado');     // la aprobación falló completa
    expect(await partida(p)).toMatchObject({ saldo: '100.00', estado: 'abierta' });
    await rechazar(r.id, 'Monto equivocado');
  });

  it('pagos parciales: cada uno descuenta en proporción su valor histórico y el último cierra la factura', async () => {
    const p = await facturar('e', '50', '4.0000');                        // US$ 200
    const r1 = await pagar(datos('e', cuentaUsd, '80', [{ partidaId: p, monto: '80' }]));
    expect(await partida(p)).toEqual({ saldo: '120.00', saldo_ves: '4800.00', saldo_usd: '120.00', estado: 'abierta' });
    expect(await asiento('pago_proveedor', r1)).toEqual([
      ['2.1.01', '3200.00', '0.00', '80.00', '0.00'], ['BANCO', '0.00', '3200.00', '0.00', '80.00'],
    ]);
    await cuadra();
    await pagar(datos('e', cuentaUsd, '120', [{ partidaId: p, monto: '120', liquida: true }]));
    expect(await partida(p)).toEqual({ saldo: '0.00', saldo_ves: '0.00', saldo_usd: '0.00', estado: 'cancelada' });
    expect((await partidasPorPagar(db, prov.e)).length).toBe(0);
    await cuadra();
  });

  it('anticipo: lo que sobra queda como anticipo al proveedor (1.2.02) y se aplica después a otra factura', async () => {
    const p1 = await facturar('f', '25', '4.0000');                       // US$ 100
    const id = await pagar(datos('f', cuentaUsd, '150', [{ partidaId: p1, monto: '100' }]));
    const d = (await detallePago(db, id))!;
    expect([d.por_aplicar, d.por_aplicar_ves, d.por_aplicar_usd]).toEqual(['50.00', '2000.00', '50.00']);
    expect(await asiento('pago_proveedor', id)).toEqual([
      ['2.1.01', '4000.00', '0.00', '100.00', '0.00'],
      ['1.2.02', '2000.00', '0.00', '50.00', '0.00'],
      ['BANCO', '0.00', '6000.00', '0.00', '150.00'],
    ]);
    let c = await cuadra();
    expect([c.anticipos_mayor_ves, c.anticipos_mayor_usd]).toEqual(['2000.00', '50.00']);

    const p2 = await facturar('f', '20', '4.0000');                       // US$ 80
    const r = await como(tesoreria, (tx) => aplicarAnticipoPago(tx, tesoreria, id, { aplicaciones: [{ partidaId: p2, monto: '50' }] }));
    expect(r.anticipo).toBe('0.00');
    expect(await partida(p2)).toEqual({ saldo: '30.00', saldo_ves: '1200.00', saldo_usd: '30.00', estado: 'abierta' });
    const ap = (await db.query<{ id: string }>(`select id from aplicacion_pago where pago_id = $1 and origen = 'anticipo'`, [id])).rows[0];
    expect(await asiento('aplicacion_pago', ap.id)).toEqual([
      ['2.1.01', '2000.00', '0.00', '50.00', '0.00'],
      ['1.2.02', '0.00', '2000.00', '0.00', '50.00'],
    ]);
    c = await cuadra();
    expect([c.anticipos_mayor_ves, c.anticipos_mayor_usd]).toEqual(['0.00', '0.00']);
    await esperarError(como(tesoreria, (tx) => aplicarAnticipoPago(tx, tesoreria, id, { aplicaciones: [{ partidaId: p2, monto: '1' }] })), 'no tiene anticipo por aplicar');
    // Un pago con un anticipo ya aplicado a facturas no se anula.
    await esperarError(como(gerente, (tx) => anularPago(tx, gerente, id, { motivoId: OTRO, detalle: 'Prueba' })), 'anticipo ya aplicado');
  });

  it('anular un pago aprobado: reverso del asiento y las facturas recuperan su saldo', async () => {
    const p = await facturar('g', '25', '4.0000');                        // US$ 100
    const id = await pagar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '100' }]));
    await como(gerente, (tx) => anularPago(tx, gerente, id, { motivoId: OTRO, detalle: 'Pago duplicado' }));
    const d = (await detallePago(db, id))!;
    expect([d.estado, d.por_aplicar, d.aplicaciones.every((a) => a.revertida)]).toEqual(['anulado', '0.00', true]);
    expect(await partida(p)).toEqual({ saldo: '100.00', saldo_ves: '4000.00', saldo_usd: '100.00', estado: 'abierta' });
    const rev = (await db.query<{ n: number }>(
      `select count(*)::int as n from asiento where tipo = 'reverso' and reversa_de = (select id from asiento where origen_tipo = 'pago_proveedor' and origen_id = $1 and tipo = 'automatico')`, [id])).rows[0];
    expect(rev.n).toBe(1);
    await cuadra();
    await esperarError(como(gerente, (tx) => anularPago(tx, gerente, id, { motivoId: OTRO, detalle: 'Otra vez' })), 'ya está anulado');
  });

  it('validaciones: factura de otro proveedor, de más, repetida, fecha futura y referencia repetida en la misma cuenta', async () => {
    const p = await facturar('g', '25', '4.0000');
    await esperarError(solicitar(datos('a', cuentaUsd, '100', [{ partidaId: p, monto: '100' }])), 'mismo proveedor');
    await esperarError(solicitar(datos('g', cuentaUsd, '50', [{ partidaId: p, monto: '100' }])), 'supera el monto del pago');
    await esperarError(solicitar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '60' }, { partidaId: p, monto: '40' }])), 'no puede aparecer dos veces');
    await esperarError(solicitar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '100' }], { fecha: '2999-01-01' })), 'no puede ser futura');
    await solicitar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '100' }], { referencia: 'DUP-1' }));
    await esperarError(solicitar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '100' }], { referencia: 'dup-1' })), 'pago_referencia_unica');
  });

  it('una factura ya pagada no se vuelve a pagar: la base rechaza la segunda aprobación', async () => {
    const p = await facturar('g', '25', '4.0000');                        // US$ 100
    const a = await solicitar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '100' }]));
    const b = await solicitar(datos('g', cuentaUsd, '100', [{ partidaId: p, monto: '100' }]));
    await aprobar(a.id);
    await expect(aprobar(b.id)).rejects.toThrow();
    expect((await detallePago(db, b.id))!.estado).toBe('solicitado');
    await rechazar(b.id, 'Ya estaba pagada');
    await cuadra();
  });

  it('el pago no se edita ni se borra, y sus aplicaciones y las partidas tampoco', async () => {
    const id = (await db.query<{ id: string }>(`select id from pago where estado = 'pagado' limit 1`)).rows[0].id;
    await esperarError(db.query('update pago set monto = 1 where id = $1', [id]), 'no se edita');
    await esperarError(db.query('delete from pago where id = $1', [id]), 'no se borra');
    await esperarError(db.query('update aplicacion_pago set monto_pago = 1 where pago_id = $1', [id]), 'no se modifica');
    await esperarError(db.query('delete from aplicacion_pago where pago_id = $1', [id]), 'no se borra');
    await esperarError(db.query('update partida_cxp set saldo = 0'), 'solo cambia con un pago');
  });

  it('listados: por estado y por texto; solo lo ven los roles autorizados', async () => {
    const pagados = await buscarPagos(db, tesoreria, { estado: 'pagado' });
    expect(pagados.length).toBeGreaterThan(5);
    expect(pagados.every((x) => x.estado === 'pagado')).toBe(true);
    expect((await buscarPagos(db, tesoreria, { texto: 'Proveedor d' })).every((x) => x.proveedor.includes('Proveedor d'))).toBe(true);
    expect(await buscarPagos(db, { id: comprador.id, roles: ['ventas'] })).toEqual([]);
  });

  it('cuadre final: cuentas por pagar y anticipos contra el mayor, en bolívares y en USD', async () => {
    await cuadra();
  });
});
