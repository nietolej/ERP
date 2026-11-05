import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimarIgtf, igtfDe } from '@/lib/compras/igtf';
import { anularPago, cuadreCxP, detallePago, solicitarPago, type DatosPago } from '@/lib/compras/pagos';
import type { Usuario } from '@/lib/compras/ordenes';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * IGTF pagado (spec §11.3; migración 0042). Tasa: USD a Bs 40; IGTF al 3 %. Se paga en divisas, con instrumento que genera IGTF, a un
 * contribuyente especial; sale del banco aparte, además del pago.
 */
describe('IGTF pagado en los pagos a proveedores (R-CN a R-CP)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let tesoreria: Usuario;
  let gerente: Usuario;
  let hoy = '';
  let usd = '';
  let ves = '';
  let zelle = '';
  let transferencia = '';
  let OTRO = '';
  let especial = '';
  let normal = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const proveedor = async (n8: string, especialFlag: boolean) => {
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: `Proveedor ${n8}`, domiciliado: true, contribuyenteEspecial: especialFlag, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    return r.id;
  };
  const datos = (proveedorId: string, cuenta: string, instrumentoId: string, monto: string): DatosPago => ({ proveedorId, fecha: hoy, instrumentoId, cuentaBancariaId: cuenta, monto, aplicaciones: [] });
  const pagar = async (d: DatosPago) => {
    const r = await como(tesoreria, (tx) => solicitarPago(tx, tesoreria, d));
    await como(gerente, (tx) => resolverAprobacion(tx, 'pago_proveedor', r.id, gerente.id, 'aprobada'));
    return r.id;
  };
  const lineas = async (tipo: string, id: string) => (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
    `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
       from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
      where a.origen_tipo = $1 and a.origen_id = $2 and a.tipo = 'automatico' order by l.id`, [tipo, id])).rows
    .map((l) => [l.codigo.startsWith('1.1.') ? 'BANCO' : l.codigo, l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd]);

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    comprador = { id: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']), roles: ['compras'] };
    tesoreria = { id: await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']), roles: ['tesoreria'] };
    gerente = { id: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']), roles: ['gerencia'] };
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    hoy = (await db.query<{ hoy: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as hoy`)).rows[0].hoy;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40)`, [hoy]);
    OTRO = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    usd = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional USD', tipo: 'banco', moneda: 'USD', bancoId: banco, numero: '0102-0000-22' }))).id;
    ves = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    const instrumentos = await listarInstrumentos(db);
    zelle = instrumentos.find((i) => i.codigo === 'ZELLE')!.id;
    transferencia = instrumentos.find((i) => i.codigo === 'TRANSFERENCIA')!.id;
    especial = await proveedor('55550001', true);
    normal = await proveedor('55550002', false);
  });
  afterAll(() => cerrar());

  it('muestra el IGTF estimado antes de aprobar y no lo causa hasta entonces', async () => {
    const e = await estimarIgtf(db, { proveedorId: especial, instrumentoId: zelle, cuentaBancariaId: usd, fecha: hoy, monto: '1000' });
    expect(e).toMatchObject({ aplica: true, porcentaje: '3', monto: '30.00', moneda: 'USD' });
    const r = await como(tesoreria, (tx) => solicitarPago(tx, tesoreria, datos(especial, usd, zelle, '1000')));
    expect(await igtfDe(db, r.id)).toBeNull();
    await como(gerente, (tx) => resolverAprobacion(tx, 'pago_proveedor', r.id, gerente.id, 'aprobada'));
  });

  it('al aprobar, el IGTF es gasto financiero que sale del banco aparte del pago', async () => {
    const id = await pagar(datos(especial, usd, zelle, '500'));
    const ig = (await igtfDe(db, id))!;
    expect([ig.monto, ig.porcentaje, ig.base, ig.moneda, ig.revertido]).toEqual(['15.00', '3.0000', '500.00', 'USD', false]);
    expect(ig.asiento).not.toBeNull();
    const fila = (await db.query<{ id: string; monto_ves: string; monto_usd: string }>('select id, monto_ves::text, monto_usd::text from igtf_pago where pago_id = $1', [id])).rows[0];
    expect([fila.monto_ves, fila.monto_usd]).toEqual(['600.00', '15.00']);
    expect(await lineas('igtf_pago', fila.id)).toEqual([
      ['6.3.01', '600.00', '0.00', '15.00', '0.00'],
      ['BANCO', '0.00', '600.00', '0.00', '15.00'],
    ]);
    // El pago conserva su asiento propio: el IGTF no cambia lo que se debe al proveedor.
    expect(await lineas('pago_proveedor', id)).toEqual([
      ['1.2.02', '20000.00', '0.00', '500.00', '0.00'],
      ['BANCO', '0.00', '20000.00', '0.00', '500.00'],
    ]);
    expect((await cuadreCxP(db)).cuadra).toBe(true);
  });

  it('no lo causa en bolívares, con un instrumento que no lo genera ni a un proveedor que no es agente de percepción', async () => {
    expect((await estimarIgtf(db, { proveedorId: especial, instrumentoId: zelle, cuentaBancariaId: ves, fecha: hoy, monto: '1000' })).motivo).toContain('bolívares');
    expect((await estimarIgtf(db, { proveedorId: especial, instrumentoId: transferencia, cuentaBancariaId: usd, fecha: hoy, monto: '1000' })).motivo).toContain('instrumento');
    expect((await estimarIgtf(db, { proveedorId: normal, instrumentoId: zelle, cuentaBancariaId: usd, fecha: hoy, monto: '1000' })).motivo).toContain('contribuyente especial');
    for (const d of [datos(especial, ves, zelle, '4000'), datos(especial, usd, transferencia, '100'), datos(normal, usd, zelle, '100')]) {
      const id = await pagar(d);
      expect(await igtfDe(db, id)).toBeNull();
    }
  });

  it('el IGTF queda inmutable', async () => {
    const id = await pagar(datos(especial, usd, zelle, '200'));
    await esperarError(db.query('update igtf_pago set monto = 1 where pago_id = $1', [id]), 'no se modifica');
    await esperarError(db.query('delete from igtf_pago where pago_id = $1', [id]), 'no se borra');
  });

  it('anular el pago revierte también el IGTF y el mayor sigue cuadrado', async () => {
    const id = await pagar(datos(especial, usd, zelle, '100'));
    const antes = (await db.query<{ n: string }>(
      `select coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as n from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
        where l.cuenta_id = (select cuenta_contable_id from cuenta_bancaria where id = $1)`, [usd])).rows[0].n;
    await como(gerente, (tx) => anularPago(tx, gerente, id, { motivoId: OTRO, detalle: 'Pago duplicado' }));
    const ig = (await igtfDe(db, id))!;
    expect(ig.revertido).toBe(true);
    const despues = (await db.query<{ n: string }>(
      `select coalesce(sum(l.debe_usd - l.haber_usd), 0)::text as n from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
        where l.cuenta_id = (select cuenta_contable_id from cuenta_bancaria where id = $1)`, [usd])).rows[0].n;
    expect(Number(despues) - Number(antes)).toBe(103);          // vuelven el pago (100) y su IGTF (3)
    expect((await detallePago(db, id))!.estado).toBe('anulado');
    const g = (await db.query<{ ves: string; usd: string }>('select diferencia_ves::text as ves, diferencia_usd::text as usd from vw_control_cuadre')).rows[0];
    expect([Number(g.ves), Number(g.usd)]).toEqual([0, 0]);
  });
});
