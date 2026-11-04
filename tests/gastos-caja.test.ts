import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenEnDisco, type AlmacenArchivos } from '@/lib/adjuntos/almacen';
import { cuadreCxP, partidasPorPagar } from '@/lib/compras/pagos';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import {
  anularVale, crearFondo, cuadreCaja, detalleFondo, listarFondos, registrarVale, solicitarConstitucion, solicitarReposicion, valesDeFondo, type DatosVale,
} from '@/lib/gastos/caja-chica';
import {
  actualizarCategoria, buscarGastosProveedor, crearCategoria, crearGastoProveedor, detalleGastoProveedor, listarCategorias, type DatosGastoProveedor, type UsuarioGasto,
} from '@/lib/gastos/gastos';
import { crearCuentaBancaria } from '@/lib/maestros/cuentas-bancarias';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Gastos de proveedor y caja chica (spec §10.1; migración 0040). Tasa: USD a Bs 40. IVA general de 16 %.
 */
describe('gastos de proveedor y caja chica (R-CG a R-CJ)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let dir = '';
  let almacen: AlmacenArchivos;
  let comprador: UsuarioGasto;
  let contador: UsuarioGasto;
  let tesoreria: UsuarioGasto;
  let gerente: UsuarioGasto;
  let otroGerente: UsuarioGasto;
  let custodio: UsuarioGasto;
  let ajeno: UsuarioGasto;
  let general = '';
  let exento = '';
  let hoy = '';
  let bancoVes = '';
  let bancoUsd = '';
  let cajaVes = '';
  let cajaUsd = '';
  let contCajaVes = '';
  let prov = '';
  let alquiler = '';
  let bancarias = '';
  let n = 0;
  let pdf = 0;

  const como = <T,>(u: UsuarioGasto, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  /** Un PDF distinto en cada llamada (la huella no se repite). */
  const soporte = () => ({ almacen, nombre: `soporte-${++pdf}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% soporte ${pdf}\n`) });
  const agente = (iva: boolean) => db.query('update empresa set agente_retencion_iva = $1, agente_retencion_islr = false', [iva]);

  const gasto = (extra: Partial<DatosGastoProveedor> = {}): DatosGastoProveedor => ({
    proveedorId: prov, categoriaId: alquiler, descripcion: 'Alquiler del galpón', numeroFactura: `GF-${++n}`, numeroControl: `00-${n}`, fechaFactura: hoy,
    moneda: 'VES', base: '1000.00', alicuotaIvaId: general, ...extra,
  });
  const registrarGasto = (d = gasto(), u = comprador) => como(u, (tx) => crearGastoProveedor(tx, u, d, soporte()));
  const aprobarGasto = (id: string, u = gerente) => como(u, (tx) => resolverAprobacion(tx, 'gasto_proveedor', id, u.id, 'aprobada'));

  /** Líneas del asiento de un origen: [cuenta, lado, VES]. */
  const lineas = async (origenTipo: string, origenId: string) => (await db.query<{ cuenta: string; debe: string; haber: string; usd_debe: string; usd_haber: string }>(
    `select c.codigo as cuenta, l.debe_ves::text as debe, l.haber_ves::text as haber, l.debe_usd::text as usd_debe, l.haber_usd::text as usd_haber
       from asiento_linea l join asiento a on a.id = l.asiento_id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [origenTipo, origenId])).rows;
  const monto = (x: string) => Number(x);
  const debe = (ls: Awaited<ReturnType<typeof lineas>>, cuenta: string) => ls.filter((l) => l.cuenta === cuenta).reduce((s, l) => s + monto(l.debe), 0);
  const haber = (ls: Awaited<ReturnType<typeof lineas>>, cuenta: string) => ls.filter((l) => l.cuenta === cuenta).reduce((s, l) => s + monto(l.haber), 0);

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    dir = await mkdtemp(path.join(tmpdir(), 'gastos-'));
    almacen = almacenEnDisco(dir);
    const ids = {
      com: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']),
      con: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']),
      tes: await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']),
      ger: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']),
      ger2: await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']),
      cus: await usuarioDePrueba(db, 'custodio@prueba.test', ['tesoreria']),
      aje: await usuarioDePrueba(db, 'ajeno@prueba.test', ['tesoreria']),
    };
    comprador = { id: ids.com, roles: ['compras'] };
    contador = { id: ids.con, roles: ['contabilidad'] };
    tesoreria = { id: ids.tes, roles: ['tesoreria'] };
    gerente = { id: ids.ger, roles: ['gerencia'] };
    otroGerente = { id: ids.ger2, roles: ['gerencia'] };
    custodio = { id: ids.cus, roles: ['tesoreria'] };
    ajeno = { id: ids.aje, roles: ['tesoreria'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    hoy = (await db.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`)).rows[0].hoy;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40.000000)`, [hoy]);
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_retencion_iva, agente_retencion_islr)
                    values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', false, false)`);
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    alquiler = (await db.query<{ id: string }>(`select id from categoria_gasto where codigo = 'ALQUILER'`)).rows[0].id;
    bancarias = (await db.query<{ id: string }>(`select id from categoria_gasto where codigo = 'COMISIONES_BANCARIAS'`)).rows[0].id;

    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    bancoVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    bancoUsd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-0000-22' }))).id;
    cajaVes = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Caja chica Bs', tipo: 'caja', moneda: 'VES' }))).id;
    cajaUsd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Caja chica USD', tipo: 'caja', moneda: 'USD' }))).id;

    contCajaVes = (await db.query<{ codigo: string }>('select c.codigo from cuenta_bancaria cb join cuenta_contable c on c.id = cb.cuenta_contable_id where cb.id = $1', [cajaVes])).rows[0].codigo;
    const n8 = '44440001';
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: 'Inmobiliaria Centro', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'servicios', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    prov = r.id;
  });

  afterAll(async () => {
    await cerrar();
    await rm(dir, { recursive: true, force: true });
  });

  describe('categorías de gasto', () => {
    it('vienen cinco sembradas con su cuenta contable', async () => {
      const cats = await listarCategorias(db);
      expect(cats.map((c) => c.codigo).sort()).toEqual(['ALQUILER', 'COMISIONES_BANCARIAS', 'FLETES_VENTA', 'PUBLICIDAD', 'SERVICIOS']);
      expect(cats.find((c) => c.codigo === 'ALQUILER')!.cuenta).toContain('6.2.02');
      expect(cats.find((c) => c.codigo === 'COMISIONES_BANCARIAS')!.iva_deducible).toBe(false);
    });

    it('Contabilidad crea y edita; Compras no; la cuenta debe ser de gasto', async () => {
      const gasto6 = (await db.query<{ id: string }>(`select id from cuenta_contable where codigo = '6.2.03'`)).rows[0].id;
      const activo = (await db.query<{ id: string }>(`select id from cuenta_contable where codigo = '1.3.01'`)).rows[0].id;
      const id = await como(contador, (tx) => crearCategoria(tx, contador, { codigo: 'MANTENIMIENTO', nombre: 'Mantenimiento', cuentaId: gasto6, ivaDeducible: true }));
      expect(id).toBeTruthy();
      await esperarError(como(comprador, (tx) => crearCategoria(tx, comprador, { codigo: 'OTRA', nombre: 'Otra categoría', cuentaId: gasto6, ivaDeducible: true })), 'No tiene permiso');
      await esperarError(como(contador, (tx) => crearCategoria(tx, contador, { codigo: 'MALA', nombre: 'Cuenta de activo', cuentaId: activo, ivaDeducible: true })), 'cuenta de gasto');
      await esperarError(como(contador, (tx) => crearCategoria(tx, contador, { codigo: 'MANTENIMIENTO', nombre: 'Repetida', cuentaId: gasto6, ivaDeducible: true })), 'Ya existe');
      await como(contador, (tx) => actualizarCategoria(tx, contador, id, { nombre: 'Mantenimiento y reparaciones', cuentaId: gasto6, ivaDeducible: true }));
      expect((await listarCategorias(db)).find((c) => c.codigo === 'MANTENIMIENTO')!.nombre).toBe('Mantenimiento y reparaciones');
    });
  });

  describe('factura de gasto de un proveedor', () => {
    it('nace pendiente: no mueve nada hasta que Gerencia la apruebe', async () => {
      const { id } = await registrarGasto();
      const d = (await detalleGastoProveedor(db, id))!;
      expect(d.estado).toBe('pendiente');
      expect(d.iva).toBe('160.00');
      expect(d.total).toBe('1160.00');
      expect(d.total_usd).toBe('29.00');
      expect(d.asiento).toBeNull();
      expect((await db.query('select 1 from partida_cxp where gasto_proveedor_id = $1', [id])).rows).toHaveLength(0);
      expect((await lineas('gasto_proveedor', id))).toHaveLength(0);
    });

    it('Gerencia, distinta de quien la registró, la aprueba: asiento, cuenta por pagar y cuadre', async () => {
      const { id } = await registrarGasto();
      await esperarError(aprobarGasto(id, comprador), 'no aprueba su propia solicitud');
      await expect(aprobarGasto(id, contador)).rejects.toThrow();
      await aprobarGasto(id);
      const d = (await detalleGastoProveedor(db, id))!;
      expect(d.estado).toBe('contabilizado');
      const ls = await lineas('gasto_proveedor', id);
      expect(debe(ls, '6.2.02')).toBe(1000);
      expect(debe(ls, '1.2.03')).toBe(160);
      expect(haber(ls, '2.1.01')).toBe(1160);
      const p = (await db.query<{ monto_original: string; saldo: string }>('select monto_original::text, saldo::text from partida_cxp where gasto_proveedor_id = $1', [id])).rows[0];
      expect(p.monto_original).toBe('1160.00');
      expect(p.saldo).toBe('1160.00');
      expect((await cuadreCxP(db)).cuadra).toBe(true);
    });

    it('un gasto aprobado por quien lo registró se rechaza en la base', async () => {
      const g = { id: gerente.id, roles: ['gerencia'] };
      const { id } = await registrarGasto(gasto(), g);
      await esperarError(aprobarGasto(id, g), 'no aprueba su propia solicitud');
      await aprobarGasto(id, otroGerente);
      expect((await detalleGastoProveedor(db, id))!.estado).toBe('contabilizado');
    });

    it('la partida del gasto aparece entre lo que se puede pagar', async () => {
      const { id } = await registrarGasto(gasto({ numeroFactura: 'PAGAR-1' }));
      await aprobarGasto(id);
      const abiertas = await partidasPorPagar(db, prov);
      expect(abiertas.some((p) => p.factura === 'PAGAR-1')).toBe(true);
    });

    it('si la categoría no admite crédito fiscal, el IVA se suma al gasto', async () => {
      const { id } = await registrarGasto(gasto({ categoriaId: bancarias, base: '200.00', descripcion: 'Comisión por transferencias' }));
      await aprobarGasto(id);
      const ls = await lineas('gasto_proveedor', id);
      expect(debe(ls, '6.3.01')).toBe(232);
      expect(ls.some((l) => l.cuenta === '1.2.03')).toBe(false);
      expect(haber(ls, '2.1.01')).toBe(232);
    });

    it('una empresa agente de retención practica la de IVA y la cuenta por pagar nace por el neto', async () => {
      await agente(true);
      try {
        const { id } = await registrarGasto(gasto({ base: '1000.00' }));
        await aprobarGasto(id);
        const ls = await lineas('gasto_proveedor', id);
        expect(haber(ls, '2.1.04')).toBe(120);            // 75 % de 160
        expect(haber(ls, '2.1.01')).toBe(1040);
        const p = (await db.query<{ monto_original: string }>('select monto_original::text from partida_cxp where gasto_proveedor_id = $1', [id])).rows[0];
        expect(p.monto_original).toBe('1040.00');
        const r = (await db.query<{ impuesto: string; monto: string }>('select impuesto, monto::text from retencion_compra where gasto_proveedor_id = $1', [id])).rows;
        expect(r).toEqual([{ impuesto: 'iva', monto: '120.00' }]);
        expect((await cuadreCxP(db)).cuadra).toBe(true);
      } finally {
        await agente(false);
      }
    });

    it('en divisas conserva la moneda y el valor en bolívares y USD', async () => {
      const { id } = await registrarGasto(gasto({ moneda: 'USD', base: '100.00', alicuotaIvaId: exento }));
      await aprobarGasto(id);
      const ls = await lineas('gasto_proveedor', id);
      expect(debe(ls, '6.2.02')).toBe(4000);
      expect(Number(ls.find((l) => l.cuenta === '6.2.02')!.usd_debe)).toBe(100);
      expect((await cuadreCxP(db)).cuadra).toBe(true);
    });

    it('rechazada no mueve nada y su número queda libre', async () => {
      const d = gasto({ numeroFactura: 'RECHAZO-1' });
      const { id } = await registrarGasto(d);
      await como(gerente, (tx) => resolverAprobacion(tx, 'gasto_proveedor', id, gerente.id, 'rechazada', { comentario: 'Falta el contrato de alquiler' }));
      expect((await detalleGastoProveedor(db, id))!.estado).toBe('rechazado');
      expect((await lineas('gasto_proveedor', id))).toHaveLength(0);
      const otra = await registrarGasto({ ...d });
      expect(otra.id).not.toBe(id);
    });

    it('exige soporte, rechaza facturas repetidas y respeta los permisos', async () => {
      await esperarError(como(comprador, (tx) => crearGastoProveedor(tx, comprador, gasto(), { almacen, nombre: 'vacio.pdf', bytes: new Uint8Array() })), 'Adjunte el soporte');
      await esperarError(como(comprador, (tx) => crearGastoProveedor(tx, comprador, gasto(), { almacen, nombre: 'malo.pdf', bytes: new TextEncoder().encode('no es un pdf') })), 'Solo se admiten archivos');
      const d = gasto({ numeroFactura: 'REPETIDA-1' });
      await registrarGasto(d);
      await esperarError(registrarGasto({ ...d }), 'ya tiene registrada la factura');
      const ventas: UsuarioGasto = { id: comprador.id, roles: ['ventas'] };
      await esperarError(como(ventas, (tx) => crearGastoProveedor(tx, ventas, gasto(), soporte())), 'No tiene permiso');
      await esperarError(registrarGasto(gasto({ base: '0' })), 'mayor que cero');
    });

    it('la base de datos no confirma una factura de gasto sin soporte ni deja editar una registrada', async () => {
      await esperarError(db.transaction(async (tx) => {
        await tx.query("select set_config('app.usuario_id', $1, true)", [comprador.id]);
        await tx.query(
          `insert into gasto_proveedor (proveedor_id, categoria_id, descripcion, numero_factura, numero_control, fecha_factura, fecha_vencimiento, moneda, base,
                                        alicuota_iva_id, tasa, alicuota_pct, iva, total, total_usd, iva_deducible, created_by)
           values ($1, $2, 'Sin soporte', 'SS-1', '00-1', $3::date, $3::date, 'VES', 100, $4, 1, 0, 0, 0, 0, true, $5)`, [prov, alquiler, hoy, general, comprador.id]);
      }), 'Adjunte el soporte');
      const { id } = await registrarGasto();
      await esperarError(db.query(`update gasto_proveedor set base = 1 where id = $1`, [id]), 'no se edita');
      await esperarError(db.query(`delete from gasto_proveedor where id = $1`, [id]), 'no se borra');
    });

    it('la bandeja lista y filtra', async () => {
      const todos = await buscarGastosProveedor(db, contador);
      expect(todos.length).toBeGreaterThan(5);
      expect((await buscarGastosProveedor(db, contador, { estado: 'pendiente' })).every((g) => g.estado === 'pendiente')).toBe(true);
      expect(await buscarGastosProveedor(db, { id: comprador.id, roles: ['ventas'] })).toEqual([]);
    });
  });

  describe('caja chica', () => {
    let fondo = '';
    let reposicion = '';

    const vale = (extra: Partial<DatosVale> = {}): DatosVale => ({
      fondoId: fondo, fecha: hoy, categoriaId: alquiler, beneficiario: 'Ferretería La Esquina', descripcion: 'Compra de candados', comprobante: `R-${++n}`,
      control: `00-${n}`, base: '100.00', alicuotaIvaId: general, ...extra,
    });
    const nuevoVale = (d = vale(), u = custodio) => como(u, (tx) => registrarVale(tx, u, d, soporte()));
    const saldo = async (id = fondo) => (await detalleFondo(db, id))!;
    const constituir = async (id: string, origen: string, u = tesoreria) => {
      const s = await como(u, (tx) => solicitarConstitucion(tx, u, id, origen));
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', s.id, gerente.id, 'aprobada'));
      return s.id;
    };

    it('solo Gerencia crea fondos; el custodio necesita un rol de caja; la caja no se repite', async () => {
      await esperarError(como(tesoreria, (tx) => crearFondo(tx, tesoreria, { nombre: 'Caja chica oficina', custodioId: custodio.id, cuentaBancariaId: cajaVes, montoFijo: '1000', topeVale: '200' })), 'Solo Gerencia');
      const sinRol = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
      await esperarError(como(gerente, (tx) => crearFondo(tx, gerente, { nombre: 'Caja chica oficina', custodioId: sinRol, cuentaBancariaId: cajaVes, montoFijo: '1000', topeVale: '200' })), 'necesita el rol');
      await esperarError(como(gerente, (tx) => crearFondo(tx, gerente, { nombre: 'Caja chica oficina', custodioId: custodio.id, cuentaBancariaId: cajaVes, montoFijo: '1000', topeVale: '2000' })), 'tope por vale');
      await esperarError(como(gerente, (tx) => crearFondo(tx, gerente, { nombre: 'Banco como caja', custodioId: custodio.id, cuentaBancariaId: bancoVes, montoFijo: '1000', topeVale: '200' })), 'de tipo caja');
      const f = await como(gerente, (tx) => crearFondo(tx, gerente, { nombre: 'Caja chica oficina', custodioId: custodio.id, cuentaBancariaId: cajaVes, montoFijo: '1000', topeVale: '200' }));
      fondo = f.id;
      expect(f.codigo).toBe('CC001');
      await esperarError(como(gerente, (tx) => crearFondo(tx, gerente, { nombre: 'Otro fondo', custodioId: custodio.id, cuentaBancariaId: cajaVes, montoFijo: '500', topeVale: '100' })), 'duplicate');
      const d = await saldo();
      expect(d.moneda).toBe('VES');
      expect(d.saldo).toBe('0.00');
      expect(d.constituido).toBe(false);
    });

    it('sin constituir no hay efectivo: un vale excede el saldo y no se pide reposición', async () => {
      await esperarError(nuevoVale(), 'excede el saldo del fondo');
      await esperarError(como(tesoreria, (tx) => solicitarReposicion(tx, tesoreria, fondo, bancoVes)), 'todavía no se ha constituido');
    });

    it('la constitución la aprueba Gerencia, distinta de quien la pidió, y mueve banco → caja', async () => {
      await esperarError(como(ajeno, (tx) => solicitarConstitucion(tx, ajeno, fondo, cajaVes)), 'no de una caja');
      await esperarError(como(comprador, (tx) => solicitarConstitucion(tx, comprador, fondo, bancoVes)), 'Solo Tesorería, Gerencia o el custodio');
      await esperarError(como(tesoreria, (tx) => solicitarConstitucion(tx, tesoreria, fondo, bancoUsd)), 'misma moneda');
      const s = await como(tesoreria, (tx) => solicitarConstitucion(tx, tesoreria, fondo, bancoVes, 'Transferencia 0001'));
      expect((await saldo()).saldo).toBe('0.00');               // pendiente: no mueve nada
      await esperarError(como(tesoreria, (tx) => solicitarConstitucion(tx, tesoreria, fondo, bancoVes)), 'duplicate');
      await esperarError(como(tesoreria, (tx) => resolverAprobacion(tx, 'reposicion_caja', s.id, tesoreria.id, 'aprobada')), 'no aprueba su propia solicitud');
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', s.id, gerente.id, 'aprobada'));
      const ls = await lineas('reposicion_caja', s.id);
      expect(ls).toHaveLength(2);
      expect(debe(ls, contCajaVes)).toBe(1000);
      expect(ls.filter((l) => l.cuenta.startsWith('1.1.02')).reduce((t, l) => t + monto(l.haber), 0)).toBe(1000);
      const d = await saldo();
      expect(d.saldo).toBe('1000.00');
      expect(d.constituido).toBe(true);
      await esperarError(como(tesoreria, (tx) => solicitarConstitucion(tx, tesoreria, fondo, bancoVes)), 'duplicate');
    });

    it('un vale con control gasta el fondo, lleva el IVA a crédito fiscal y se contabiliza al instante', async () => {
      const v = await nuevoVale();
      const ls = await lineas('vale_caja', v.id);
      expect(debe(ls, '6.2.02')).toBe(100);
      expect(debe(ls, '1.2.03')).toBe(16);
      expect(ls.filter((l) => l.cuenta.startsWith('1.1.01')).reduce((t, l) => t + monto(l.haber), 0)).toBe(116);
      expect((await saldo()).saldo).toBe('884.00');
    });

    it('sin número de control (o en una categoría sin crédito fiscal) el IVA se suma al gasto', async () => {
      const v = await nuevoVale(vale({ control: '' }));
      const ls = await lineas('vale_caja', v.id);
      expect(debe(ls, '6.2.02')).toBe(116);
      expect(ls.some((l) => l.cuenta === '1.2.03')).toBe(false);
      const w = await nuevoVale(vale({ categoriaId: bancarias, base: '50.00' }));
      const lw = await lineas('vale_caja', w.id);
      expect(debe(lw, '6.3.01')).toBe(58);
      expect((await saldo()).saldo).toBe('710.00');
    });

    it('exige soporte, respeta el tope por vale, el saldo y quién lo registra', async () => {
      await esperarError(como(custodio, (tx) => registrarVale(tx, custodio, vale(), { almacen, nombre: 'v.pdf', bytes: new Uint8Array() })), 'Adjunte el soporte');
      await esperarError(nuevoVale(vale({ base: '200.00' })), 'excede el tope por vale');       // 200 + IVA 32 = 232 > 200
      await esperarError(nuevoVale(vale(), ajeno), 'Solo el custodio del fondo');
      const g = await nuevoVale(vale({ base: '10.00' }), gerente);                          // Gerencia también puede
      expect(g.numero).toBeTruthy();
      await esperarError(nuevoVale(vale({ fecha: '2999-01-01' })), 'no puede ser futura');
      await esperarError(db.transaction(async (tx) => {
        await tx.query("select set_config('app.usuario_id', $1, true)", [custodio.id]);
        await tx.query(
          `insert into vale_caja (fondo_id, fecha, categoria_id, beneficiario, descripcion, base, alicuota_iva_id, created_by, moneda, tasa, alicuota_pct, iva, total, total_usd, iva_credito)
           values ($1, $2::date, $3, 'Sin soporte', 'Vale sin soporte', 10, $4, $5, 'VES', 1, 0, 0, 0, 0, false)`, [fondo, hoy, alquiler, exento, custodio.id]);
      }), 'Adjunte el soporte');
    });

    it('un vale no se edita ni se borra y su estado solo cambia por reposición o anulación', async () => {
      const v = await nuevoVale(vale({ base: '5.00' }));
      await esperarError(db.query(`update vale_caja set base = 1 where id = $1`, [v.id]), 'no se edita');
      await esperarError(db.query(`update vale_caja set estado = 'repuesto' where id = $1`, [v.id]), 'solo cambia con una reposición');
      await esperarError(db.query(`delete from vale_caja where id = $1`, [v.id]), 'no se borra');
    });

    it('anular un vale reversa el asiento y devuelve el efectivo al fondo', async () => {
      const antes = Number((await saldo()).saldo);
      const v = await nuevoVale(vale({ base: '20.00' }));
      expect(Number((await saldo()).saldo)).toBeCloseTo(antes - 23.2, 2);
      await esperarError(como(ajeno, (tx) => anularVale(tx, ajeno, v.id, 'Error de captura')), 'Solo el custodio');
      await esperarError(como(custodio, (tx) => anularVale(tx, custodio, v.id, 'x')), 'motivo');
      await como(custodio, (tx) => anularVale(tx, custodio, v.id, 'Error de captura'));
      expect(Number((await saldo()).saldo)).toBeCloseTo(antes, 2);
      await esperarError(como(custodio, (tx) => anularVale(tx, custodio, v.id, 'Otra vez')), 'todavía no esté en una reposición');
      const vales = await valesDeFondo(db, fondo);
      expect(vales.find((x) => x.id === v.id)!.estado).toBe('anulado');
      expect((await cuadreCaja(db)).every((c) => c.cuadra)).toBe(true);
    });

    it('la reposición reúne los vales sin reponer y devuelve el fondo a su monto fijo', async () => {
      const antes = await saldo();
      const gastado = 1000 - Number(antes.saldo);
      expect(Number(antes.por_reponer)).toBeCloseTo(gastado, 2);
      await esperarError(como(comprador, (tx) => solicitarReposicion(tx, comprador, fondo, bancoVes)), 'Solo Tesorería, Gerencia o el custodio');
      const r = await como(custodio, (tx) => solicitarReposicion(tx, custodio, fondo, bancoVes, 'Cheque 123'));
      reposicion = r.id;
      expect(Number(r.monto)).toBeCloseTo(gastado, 2);
      const enCurso = await saldo();
      expect(enCurso.por_reponer).toBe('0.00');
      expect(Number(enCurso.en_reposicion)).toBeCloseTo(gastado, 2);
      await esperarError(como(custodio, (tx) => solicitarReposicion(tx, custodio, fondo, bancoVes)), 'No hay vales por reponer');
      const enReposicion = (await valesDeFondo(db, fondo)).find((v) => v.reposicion !== null)!;
      await esperarError(como(custodio, (tx) => anularVale(tx, custodio, enReposicion.id, 'Ya no va')), 'todavía no esté en una reposición');
      await expect(como(custodio, (tx) => resolverAprobacion(tx, 'reposicion_caja', r.id, custodio.id, 'aprobada'))).rejects.toThrow();
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', r.id, gerente.id, 'aprobada'));
      const despues = await saldo();
      expect(despues.saldo).toBe('1000.00');
      expect(despues.en_reposicion).toBe('0.00');
      expect((await valesDeFondo(db, fondo)).filter((v) => v.estado === 'registrado')).toHaveLength(0);
      const ls = await lineas('reposicion_caja', reposicion);
      expect(debe(ls, contCajaVes)).toBeCloseTo(gastado, 2);
      expect((await cuadreCaja(db)).every((c) => c.cuadra)).toBe(true);
    });

    it('sin vales por reponer no hay reposición; una rechazada libera los vales', async () => {
      await esperarError(como(custodio, (tx) => solicitarReposicion(tx, custodio, fondo, bancoVes)), 'No hay vales por reponer');
      await nuevoVale(vale({ base: '30.00' }));
      const r = await como(custodio, (tx) => solicitarReposicion(tx, custodio, fondo, bancoVes));
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', r.id, gerente.id, 'rechazada', { comentario: 'Falta un comprobante' }));
      const d = await saldo();
      expect(Number(d.por_reponer)).toBeCloseTo(34.8, 2);
      expect(d.en_reposicion).toBe('0.00');
      const otra = await como(custodio, (tx) => solicitarReposicion(tx, custodio, fondo, bancoVes));
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', otra.id, gerente.id, 'aprobada'));
      expect((await saldo()).saldo).toBe('1000.00');
    });

    it('la reposición de la base debe sumar exactamente sus vales', async () => {
      await nuevoVale(vale({ base: '40.00' }));
      const r = await como(custodio, (tx) => solicitarReposicion(tx, custodio, fondo, bancoVes));
      await esperarError(db.query(`update reposicion_caja set monto = monto + 1 where id = $1`, [r.id]), 'no se edita');
      await esperarError(db.query(`update vale_caja set reposicion_id = null where reposicion_id = $1`, [r.id]), 'solo cambia con una reposición');
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', r.id, gerente.id, 'aprobada'));
    });

    it('un fondo en dólares se constituye, gasta y repone en USD', async () => {
      const f = await como(gerente, (tx) => crearFondo(tx, gerente, { nombre: 'Caja chica USD', custodioId: custodio.id, cuentaBancariaId: cajaUsd, montoFijo: '100', topeVale: '30' }));
      await constituir(f.id, bancoUsd);
      const d = await saldo(f.id);
      expect(d.moneda).toBe('USD');
      expect(d.saldo).toBe('100.00');
      const v = await como(custodio, (tx) => registrarVale(tx, custodio, { ...vale({ fondoId: f.id, base: '10.00', alicuotaIvaId: exento }) }, soporte()));
      const ls = await lineas('vale_caja', v.id);
      expect(debe(ls, '6.2.02')).toBe(400);                       // US$ 10 a Bs 40
      expect(Number(ls.find((l) => l.cuenta === '6.2.02')!.usd_debe)).toBe(10);
      expect((await saldo(f.id)).saldo).toBe('90.00');
      const r = await como(custodio, (tx) => solicitarReposicion(tx, custodio, f.id, bancoUsd));
      await como(gerente, (tx) => resolverAprobacion(tx, 'reposicion_caja', r.id, gerente.id, 'aprobada'));
      expect((await saldo(f.id)).saldo).toBe('100.00');
      const cuadre = await cuadreCaja(db);
      expect(cuadre).toHaveLength(2);
      expect(cuadre.every((c) => c.cuadra)).toBe(true);
    });

    it('el custodio ve su fondo; quien no tiene relación con caja no ve ninguno', async () => {
      expect((await listarFondos(db, custodio)).length).toBe(2);
      expect((await listarFondos(db, gerente)).length).toBe(2);
      expect(await listarFondos(db, { id: comprador.id, roles: ['compras'] })).toEqual([]);
    });

    it('todo el libro mayor sigue cuadrado', async () => {
      const { rows } = await db.query<{ diferencia_ves: string; diferencia_usd: string }>('select diferencia_ves::text, diferencia_usd::text from vw_control_cuadre');
      expect(Number(rows[0].diferencia_ves)).toBe(0);
      expect(Number(rows[0].diferencia_usd)).toBe(0);
    });
  });
});
