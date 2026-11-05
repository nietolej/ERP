import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buscarAperturas, cerrarApertura, controlApertura, estadoArranque, fijarFechaArranque, registrarBanco, registrarCxc, registrarCxp, type UsuarioApertura,
} from '@/lib/apertura/apertura';
import { cuadreCxP, partidasPorPagar } from '@/lib/compras/pagos';
import { aprobarAsiento, guardarBorrador, huellaAsiento } from '@/lib/contabilidad/manual';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria } from '@/lib/maestros/cuentas-bancarias';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { cuadreCxC, partidasAbiertas } from '@/lib/ventas/cobros';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Arranque en producción: saldos iniciales como operaciones (spec §14; migración 0048). Arranque hoy; tasa del dólar Bs 40 hoy.
 */
describe('apertura: saldos iniciales como operaciones (R-DG a R-DJ)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let tesoreria: UsuarioApertura;
  let cobranzas: UsuarioApertura;
  let compras: UsuarioApertura;
  let gerente: UsuarioApertura;
  let otroGerente: UsuarioApertura;
  let contador: UsuarioApertura;
  let hoy = '';
  let hace30 = '';
  let hace60 = '';
  let cuentaVes = '';
  let cuentaUsd = '';
  let cliente = '';
  let proveedor = '';
  let sucursal = '';
  const ids = { ger: '', ger2: '' };

  const como = <T,>(u: UsuarioApertura, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const aprobar = (tipo: 'apertura_banco' | 'apertura_cxc' | 'apertura_cxp', id: string, u = gerente) => como(u, (tx) => resolverAprobacion(tx, tipo, id, u.id, 'aprobada'));
  const puente = async () => (await db.query<{ ves: string; usd: string }>(
    `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves, coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as usd
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01'`)).rows[0];
  const lineas = async (tipo: string, id: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [tipo, id])).rows
    .map((l) => [l.codigo.startsWith('1.1.') ? 'BANCO' : l.codigo, l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd]);

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    ids.ger = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    ids.ger2 = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    tesoreria = { id: await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']), roles: ['tesoreria'] };
    cobranzas = { id: await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']), roles: ['cobranzas'] };
    compras = { id: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']), roles: ['compras'] };
    contador = { id: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']), roles: ['contabilidad'] };
    gerente = { id: ids.ger, roles: ['gerencia'] };
    otroGerente = { id: ids.ger2, roles: ['gerencia'] };
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const f = (await db.query<{ hoy: string; h30: string; h60: string }>(
      `select ((now() at time zone 'America/Caracas')::date)::text as hoy, (((now() at time zone 'America/Caracas')::date) - 30)::text as h30, (((now() at time zone 'America/Caracas')::date) - 60)::text as h60`)).rows[0];
    hoy = f.hoy; hace30 = f.h30; hace60 = f.h60;
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40)`, [hoy]);
    sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    await db.query(`insert into almacen (codigo, nombre, sucursal_id) values ('01', 'Principal', $1)`, [sucursal]);
    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-11' }))).id;
    cuentaUsd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-22' }))).id;
    const vend = await db.transaction((tx) => crearVendedor(tx, ids.ger, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const c = await db.transaction((tx) => crearCliente(tx, idFac, {
      rif: 'J-00000010-7', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
    }));
    await db.transaction((tx) => aprobarCliente(tx, c.id, ids.ger, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
    cliente = c.id;
    const n8 = '99990001';
    const p = await como(compras, (tx) => crearProveedor(tx, compras.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: 'Proveedora de Repuestos, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, p.id, ids.ger, cr30));
    proveedor = p.id;
  });
  afterAll(() => cerrar());

  describe('fecha de arranque', () => {
    it('sin fecha no se registra ningún documento de apertura', async () => {
      await esperarError(como(tesoreria, (tx) => registrarBanco(tx, tesoreria, { cuentaBancariaId: cuentaVes, saldo: '1000' })), 'fecha de arranque');
    });

    it('solo Gerencia la fija, con periodo abierto y tasa, y una sola vez', async () => {
      await esperarError(como(contador, (tx) => fijarFechaArranque(tx, contador, hoy)), 'Solo Gerencia');
      await esperarError(como(gerente, (tx) => fijarFechaArranque(tx, gerente, '1999-01-01')), 'periodo contable');
      await como(gerente, (tx) => fijarFechaArranque(tx, gerente, hoy));
      const e = await estadoArranque(db);
      expect([e.fecha, e.cerrada]).toEqual([hoy, false]);
      await esperarError(como(gerente, (tx) => fijarFechaArranque(tx, gerente, hoy)), 'ya está fijada');
      await esperarError(db.query(`update arranque set fecha_arranque = current_date - 1`), 'una sola vez');
    });
  });

  describe('bancos y cajas', () => {
    it('nace pendiente y no mueve nada; lo registra Tesorería', async () => {
      await esperarError(como(cobranzas, (tx) => registrarBanco(tx, cobranzas, { cuentaBancariaId: cuentaVes, saldo: '1000' })), 'Solo Tesorería');
      const r = await como(tesoreria, (tx) => registrarBanco(tx, tesoreria, { cuentaBancariaId: cuentaVes, saldo: '8000.00', referencia: 'Estado de cuenta' }));
      expect((await lineas('apertura_banco', r.id))).toHaveLength(0);
      expect((await buscarAperturas(db, 'pendiente'))[0]).toMatchObject({ tipo: 'banco', estado: 'pendiente', asiento: null });
      await esperarError(como(tesoreria, (tx) => registrarBanco(tx, tesoreria, { cuentaBancariaId: cuentaVes, saldo: '5' })), 'duplicate');
      await esperarError(aprobar('apertura_banco', r.id, { id: tesoreria.id, roles: ['gerencia'] }), 'no aprueba su propia solicitud');
      await aprobar('apertura_banco', r.id);
      expect(await lineas('apertura_banco', r.id)).toEqual([
        ['BANCO', '8000.00', '0.00', '200.00', '0.00'],
        ['3.9.01', '0.00', '8000.00', '0.00', '200.00'],
      ]);
    });

    it('una cuenta en dólares entra por su valor en bolívares a la tasa del arranque', async () => {
      const r = await como(tesoreria, (tx) => registrarBanco(tx, tesoreria, { cuentaBancariaId: cuentaUsd, saldo: '500.00' }));
      await aprobar('apertura_banco', r.id, otroGerente);
      expect(await lineas('apertura_banco', r.id)).toEqual([
        ['BANCO', '20000.00', '0.00', '500.00', '0.00'],
        ['3.9.01', '0.00', '20000.00', '0.00', '500.00'],
      ]);
    });
  });

  describe('facturas de venta pendientes (cuentas por cobrar)', () => {
    let aprobada = '';

    it('Cobranzas registra factura por factura con su número, fecha, vencimiento y tasa originales', async () => {
      await esperarError(como(tesoreria, (tx) => registrarCxc(tx, tesoreria, { clienteId: cliente, sucursalId: sucursal, numeroOriginal: '1001', fechaOriginal: hace60, vencimiento: hace30, saldo: '4640', tasa: '36' })), 'Solo Cobranzas');
      await esperarError(como(cobranzas, (tx) => registrarCxc(tx, cobranzas, { clienteId: cliente, sucursalId: sucursal, numeroOriginal: 'A-1001', fechaOriginal: hace60, vencimiento: hace30, saldo: '4640', tasa: '36' })), 'numérico');
      await esperarError(como(cobranzas, (tx) => registrarCxc(tx, cobranzas, { clienteId: cliente, sucursalId: sucursal, numeroOriginal: '1001', fechaOriginal: hoy, vencimiento: hoy, saldo: '4640', tasa: '36' })), 'anterior a la fecha de arranque');
      const r = await como(cobranzas, (tx) => registrarCxc(tx, cobranzas, {
        clienteId: cliente, sucursalId: sucursal, numeroOriginal: '1001', numeroControl: '00-1001', fechaOriginal: hace60, vencimiento: hace30, saldo: '4640.00', tasa: '36',
      }));
      aprobada = r.id;
      await esperarError(como(cobranzas, (tx) => registrarCxc(tx, cobranzas, { clienteId: cliente, sucursalId: sucursal, numeroOriginal: '1001', fechaOriginal: hace60, vencimiento: hace30, saldo: '10', tasa: '36' })), 'duplicate');
      expect(await partidasAbiertas(db, cliente)).toEqual([]);                    // pendiente: todavía no existe la cuenta por cobrar
    });

    it('al aprobar nace la factura de apertura, su partida con antigüedad desde la fecha original y su asiento al valor histórico', async () => {
      await aprobar('apertura_cxc', aprobada);
      const abiertas = await partidasAbiertas(db, cliente);
      expect(abiertas).toHaveLength(1);
      expect(abiertas[0]).toMatchObject({ factura: 'AP-1001', saldo: '4640.00', saldo_usd: '128.89', tramo: 'v_1_30' });
      expect(abiertas[0].dias_vencida).toBe(30);
      expect(await lineas('apertura_cxc', aprobada)).toEqual([
        ['1.2.01', '4640.00', '0.00', '128.89', '0.00'],
        ['3.9.01', '0.00', '4640.00', '0.00', '128.89'],
      ]);
      expect((await cuadreCxC(db)).cuadra).toBe(true);
    });

    it('la factura de apertura queda fuera de los indicadores de venta, de los libros y no se anula', async () => {
      const v = (await db.query<{ n: number }>('select count(*)::int as n from vw_venta_documento')).rows[0].n;
      expect(v).toBe(0);
      const libro = (await db.query<{ n: number }>('select count(*)::int as n from vw_libro_ventas')).rows[0].n;
      expect(libro).toBe(0);
      const doc = (await db.query<{ id: string; apertura: boolean; numero_control: string }>(`select id, apertura, numero_control from documento_venta where apertura`)).rows[0];
      expect([doc.apertura, doc.numero_control]).toEqual([true, '00-1001']);
      await esperarError(db.query(`update documento_venta set estado = 'anulado', anulado_motivo = 'Prueba' where id = $1`, [doc.id]), 'no se anula');
      await esperarError(db.query(`update documento_venta set exento = 5 where id = $1`, [doc.id]), 'no se edita');
    });
  });

  describe('facturas de compra pendientes (cuentas por pagar)', () => {
    it('Compras registra, Gerencia aprueba y la partida se puede pagar', async () => {
      await esperarError(como(cobranzas, (tx) => registrarCxp(tx, cobranzas, { proveedorId: proveedor, numeroDocumento: 'F-77', fechaOriginal: hace30, vencimiento: hoy, moneda: 'USD', saldo: '300', tasaUsd: '38' })), 'Solo Compras o Tesorería');
      await esperarError(como(compras, (tx) => registrarCxp(tx, compras, { proveedorId: proveedor, numeroDocumento: 'F-77', fechaOriginal: hace30, vencimiento: hoy, moneda: 'EUR', saldo: '300', tasaUsd: '38' })), 'bolívares o dólares');
      const r = await como(compras, (tx) => registrarCxp(tx, compras, { proveedorId: proveedor, numeroDocumento: 'F-77', numeroControl: '00-77', fechaOriginal: hace30, vencimiento: hoy, moneda: 'USD', saldo: '300.00', tasaUsd: '38' }));
      expect(await partidasPorPagar(db, proveedor)).toEqual([]);
      await aprobar('apertura_cxp', r.id);
      expect(await lineas('apertura_cxp', r.id)).toEqual([
        ['3.9.01', '11400.00', '0.00', '300.00', '0.00'],
        ['2.1.01', '0.00', '11400.00', '0.00', '300.00'],
      ]);
      const abiertas = await partidasPorPagar(db, proveedor);
      expect(abiertas).toHaveLength(1);
      expect(abiertas[0]).toMatchObject({ factura: 'F-77', moneda: 'USD', saldo: '300.00', saldo_usd: '300.00' });
      expect((await cuadreCxP(db)).cuadra).toBe(true);
    });

    it('una factura en bolívares usa la tasa del dólar de su fecha para su valor en USD', async () => {
      const r = await como(compras, (tx) => registrarCxp(tx, compras, { proveedorId: proveedor, numeroDocumento: 'F-78', fechaOriginal: hace60, vencimiento: hace30, moneda: 'VES', saldo: '3600.00', tasaUsd: '36' }));
      await aprobar('apertura_cxp', r.id, otroGerente);
      expect(await lineas('apertura_cxp', r.id)).toEqual([
        ['3.9.01', '3600.00', '0.00', '100.00', '0.00'],
        ['2.1.01', '0.00', '3600.00', '0.00', '100.00'],
      ]);
      expect((await cuadreCxP(db)).cuadra).toBe(true);
    });
  });

  describe('control y cierre de la apertura', () => {
    it('con Saldos de apertura sin cuadrar no se cierra, y se indica por qué', async () => {
      // Bancos 8.000 + 20.000 y por cobrar 4.640 entran al haber; por pagar 11.400 + 3.600 al debe: faltan 17.640 de patrimonio, que registra el contador.
      const p = await puente();
      expect(p.ves).toBe('-17640.00');
      expect(p.usd).toBe('-428.89');
      const c = await controlApertura(db);
      expect(c.puedeCerrar).toBe(false);
      expect(c.impedimentos.join(' ')).toContain('no está en cero');
      expect(c.totales.find((t) => t.tipo === 'banco')).toMatchObject({ documentos: 2, ves: '28000.00', usd: '700.00' });
      expect(c.totales.find((t) => t.tipo === 'cxc')).toMatchObject({ documentos: 1, ves: '4640.00' });
      await esperarError(como(gerente, (tx) => cerrarApertura(tx, gerente)), 'no está en cero');
    });

    it('solo Gerencia cierra, con todo aprobado, Saldos de apertura en cero y el mayor cuadrado', async () => {
      const jefe: UsuarioApertura = { id: await usuarioDePrueba(db, 'jefe@prueba.test', ['jefe_contabilidad']), roles: ['jefe_contabilidad'] };
      const cuenta = async (codigo: string) => (await db.query<{ id: string }>('select id from cuenta_contable where codigo = $1', [codigo])).rows[0].id;
      const patrimonio = (await db.query<{ codigo: string }>(`select codigo from cuenta_contable where tipo = 'patrimonio' and imputable and codigo <> '3.9.01' order by codigo limit 1`)).rows[0].codigo;
      const [cPuente, cPatrimonio] = [await cuenta('3.9.01'), await cuenta(patrimonio)];
      const id = await como(contador, (tx) => guardarBorrador(tx, contador.id, {
        fecha: hoy, descripcion: 'Asiento de apertura: patrimonio inicial', moneda: 'VES', tipo: 'apertura',
        lineas: [{ cuentaId: cPuente, debe: '17640.00', haber: '' }, { cuentaId: cPatrimonio, debe: '', haber: '17640.00' }],
      }));
      await como(jefe, async (tx) => aprobarAsiento(tx, id, jefe.id, await huellaAsiento(tx, id)));
      expect((await puente()).ves).toBe('0.00');
      const c = await controlApertura(db);
      expect(c.impedimentos).toEqual([]);
      expect(c.puedeCerrar).toBe(true);
      await esperarError(como(contador, (tx) => cerrarApertura(tx, contador)), 'Solo Gerencia');
      await como(gerente, (tx) => cerrarApertura(tx, gerente));
      const e = await estadoArranque(db);
      expect(e.cerrada).toBe(true);
    });

    it('cerrada la apertura, la base rechaza nuevos documentos y movimientos de Saldos de apertura', async () => {
      await esperarError(como(tesoreria, (tx) => registrarBanco(tx, tesoreria, { cuentaBancariaId: cuentaVes, saldo: '10' })), 'apertura está cerrada');
      await esperarError(como(cobranzas, (tx) => registrarCxc(tx, cobranzas, { clienteId: cliente, sucursalId: sucursal, numeroOriginal: '2002', fechaOriginal: hace60, vencimiento: hace30, saldo: '10', tasa: '36' })), 'apertura está cerrada');
      const cuenta = async (codigo: string) => (await db.query<{ id: string }>('select id from cuenta_contable where codigo = $1', [codigo])).rows[0].id;
      const [cPuente, cCaja] = [await cuenta('3.9.01'), await cuenta('1.1.01.01')];
      await esperarError(como(contador, (tx) => guardarBorrador(tx, contador.id, {
        fecha: hoy, descripcion: 'Otro asiento de apertura', moneda: 'VES', tipo: 'apertura',
        lineas: [{ cuentaId: cPuente, debe: '5.00', haber: '' }, { cuentaId: cCaja, debe: '', haber: '5.00' }],
      })), 'apertura está cerrada');
      await esperarError(como(gerente, (tx) => cerrarApertura(tx, gerente)), 'ya está cerrada');
      await esperarError(db.query('update arranque set cerrada_at = null, cerrada_por = null'), 'ya está cerrada');
    });
  });
});
