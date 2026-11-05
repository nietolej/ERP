import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import type { Db } from '@/lib/db/tipos';
import { emitirPeriodo } from '@/lib/fiscal/comprobantes';
import {
  csvRetencionesIva, declarar, declaraPorQuincena, detalleDeclaracion, listarDeclaraciones, periodoDe, previsualizar, reabrir, xmlRetencionesIslr, type UsuarioDecl,
} from '@/lib/fiscal/declaraciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { crearGastoProveedor } from '@/lib/gastos/gastos';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Declaraciones fiscales y cierre fiscal (spec §11.4; migración 0047). Dos meses ya terminados: P1 (hace dos meses) y P2 (el mes pasado).
 * Empresa agente de retención de IVA y de ISLR. IVA general de 16 %.
 */
describe('declaraciones fiscales y cierre fiscal (R-DD a R-DF)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: UsuarioDecl;
  let contador: UsuarioDecl;
  let gerente: UsuarioDecl;
  let general = '';
  let alquiler = '';
  let proveedorIva = '';
  let proveedorIslr = '';
  let p1 = { anio: 0, mes: 0, ultimo: '' };
  let p2 = { anio: 0, mes: 0, ultimo: '' };
  let n = 0;
  let archivos: ReturnType<typeof almacenEnDisco>;

  const como = <T,>(u: { id: string }, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const soporte = () => ({ almacen: archivos, nombre: `s${++n}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% ${n}\n`) });
  const crearGasto = (proveedorId: string, base: string, fecha: string) => como(comprador, (tx) => crearGastoProveedor(tx, comprador, {
    proveedorId, categoriaId: alquiler, descripcion: 'Gasto de prueba', numeroFactura: `DC-${++n}`, numeroControl: `00-${n}`, fechaFactura: fecha, moneda: 'VES', base, alicuotaIvaId: general,
  }, soporte()));
  const aprobar = (id: string) => como(gerente, (tx) => resolverAprobacion(tx, 'gasto_proveedor', id, gerente.id, 'aprobada'));
  const proveedor = async (n8: string, concepto: string | null) => {
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    const conceptoId = concepto ? (await db.query<{ id: string }>('select id from concepto_islr where codigo = $1', [concepto])).rows[0].id : null;
    const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif: `J-${n8}-${digitoVerificador('J', n8)}`,
      sensibles: { razonSocial: `Proveedor ${n8}`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'servicios', pais: 'VE', conceptoIslrId: conceptoId },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, cr30));
    return r.id;
  };
  const declara = (tipo: 'iva' | 'retenciones_iva' | 'retenciones_islr', p: { anio: number; mes: number }, u: UsuarioDecl = contador, quincena: number | null = null) =>
    como(u, (tx) => declarar(tx, u, { tipo, anio: p.anio, mes: p.mes, quincena }));
  const especial = (si: boolean) => db.query('update empresa set contribuyente_especial = $1', [si]);

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    archivos = almacenEnDisco(await mkdtemp(path.join(tmpdir(), 'declaraciones-')));
    comprador = { id: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']), roles: ['compras'] };
    contador = { id: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']), roles: ['contabilidad'] };
    gerente = { id: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']), roles: ['gerencia'] };
    const f = (await db.query<{ a1: number; m1: number; u1: string; a2: number; m2: number; u2: string; hoy: string }>(
      `with h as (select date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as m)
       select extract(year from m - interval '2 month')::int as a1, extract(month from m - interval '2 month')::int as m1, ((m - interval '1 month')::date - 1)::text as u1,
              extract(year from m - interval '1 month')::int as a2, extract(month from m - interval '1 month')::int as m2, (m - 1)::text as u2,
              (now() at time zone 'America/Caracas')::date::text as hoy from h`)).rows[0];
    p1 = { anio: f.a1, mes: f.m1, ultimo: f.u1 };
    p2 = { anio: f.a2, mes: f.m2, ultimo: f.u2 };
    for (const a of new Set([p1.anio, p2.anio, Number(f.hoy.slice(0, 4))])) await db.query('select fn_crear_periodos($1)', [a]);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series($1::date - 70, $1::date, interval '1 day') d`, [f.hoy]);
    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal, agente_retencion_iva, agente_retencion_islr) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara', true, true)`);
    await db.query(`insert into concepto_islr (codigo, descripcion) values ('SERV', 'Servicios')`);
    await db.query(
      `insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, base_minima_ut, sustraendo_ut, vigente_desde)
       select id, 'J', true, 5, 0, 0, '2026-01-01' from concepto_islr where codigo = 'SERV'`);
    general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    alquiler = (await db.query<{ id: string }>(`select id from categoria_gasto where codigo = 'ALQUILER'`)).rows[0].id;
    proveedorIva = await proveedor('88880001', null);
    proveedorIslr = await proveedor('88880002', 'SERV');
    // P1: un gasto con IVA de 160. P2: un gasto con IVA de 80 y retención de ISLR del 5 % sobre 500.
    await aprobar((await crearGasto(proveedorIva, '1000.00', p1.ultimo)).id);
    await aprobar((await crearGasto(proveedorIslr, '500.00', p2.ultimo)).id);
  });
  afterAll(() => cerrar());

  describe('periodos y archivos', () => {
    it('calcula las fechas del mes y de cada quincena', () => {
      expect(periodoDe(2026, 2)).toMatchObject({ desde: '2026-02-01', hasta: '2026-02-28', quincena: null });
      expect(periodoDe(2024, 2).hasta).toBe('2024-02-29');
      expect(periodoDe(2026, 10, 1)).toMatchObject({ desde: '2026-10-01', hasta: '2026-10-15' });
      expect(periodoDe(2026, 10, 2)).toMatchObject({ desde: '2026-10-16', hasta: '2026-10-31' });
    });

    it('el XML de ISLR escapa el texto, quita los guiones del RIF y usa dd/mm/aaaa', () => {
      const x = xmlRetencionesIslr('J-12345678-4', 2026, 10, [{ rif: 'J-00000010-7', factura: 'A&B-1', control: '00-9', fecha: '2026-10-05', concepto: 'SERV', base_ves: '500', porcentaje: '5.0000' }]);
      expect(x).toContain('RifAgente="J123456784" Periodo="202610"');
      expect(x).toContain('<RifRetenido>J000000107</RifRetenido>');
      expect(x).toContain('<NumeroFactura>A&amp;B-1</NumeroFactura>');
      expect(x).toContain('<FechaOperacion>05/10/2026</FechaOperacion>');
      expect(x).toContain('<MontoOperacion>500.00</MontoOperacion>');
      expect(x).toContain('<PorcentajeRetencion>5</PorcentajeRetencion>');
      expect(xmlRetencionesIslr('J-12345678-4', 2026, 10, [])).toContain('</RelacionRetencionesISLR>');
    });

    it('el CSV de retenciones de IVA lleva encabezado y comillas donde hace falta', () => {
      const c = csvRetencionesIva([{ comprobante: '20261000000001', fecha: '2026-10-05', factura: 'F-1', control: '00-1', rif: 'J-1', razon: 'Taller "El Sol"; C.A.', iva_ves: '160', porcentaje: '75.0000', retenido_ves: '120' }]);
      const [enc, fila] = c.replace('﻿', '').split('\r\n');
      expect(enc.split(';')).toHaveLength(9);
      expect(fila).toBe('20261000000001;05/10/2026;F-1;00-1;J-1;"Taller ""El Sol""; C.A.";160.00;75;120.00');
    });
  });

  describe('declaración de IVA con arrastre del excedente', () => {
    it('un periodo sin terminar no se declara y se muestra por qué', async () => {
      const hoy = (await db.query<{ a: number; m: number }>(`select extract(year from (now() at time zone 'America/Caracas'))::int as a, extract(month from (now() at time zone 'America/Caracas'))::int as m`)).rows[0];
      const prev = await previsualizar(db, 'iva', hoy.a, hoy.m);
      expect(prev.impedimentos.join(' ')).toContain('todavía no ha terminado');
      await esperarError(declara('iva', { anio: hoy.a, mes: hoy.m }), 'todavía no ha terminado');
    });

    it('el IVA de P1: sin ventas, el crédito fiscal queda como excedente para el mes siguiente', async () => {
      const prev = await previsualizar(db, 'iva', p1.anio, p1.mes);
      expect(prev.cifras).toMatchObject({ debito: '0.00', credito: '160.00', excedenteAnterior: '0.00', resultado: '-160.00', cuotaPagar: '0.00', excedenteSiguiente: '160.00' });
      expect(prev.impedimentos).toEqual([]);
    });

    it('solo Contabilidad o Gerencia declaran; la declaración guarda la foto y no se repite', async () => {
      await esperarError(declara('iva', p1, comprador), 'Solo Contabilidad o Gerencia');
      const id = await declara('iva', p1);
      const d = (await detalleDeclaracion(db, id))!;
      expect([d.tipo, d.desde, d.excedente_siguiente]).toEqual(['iva', `${p1.anio}-${String(p1.mes).padStart(2, '0')}-01`, '160.00']);
      expect(d.cifras).toMatchObject({ credito: '160.00', excedenteSiguiente: '160.00' });
      await esperarError(declara('iva', p1), 'ya está declarado');
      expect((await listarDeclaraciones(db)).map((x) => x.tipo)).toEqual(['iva']);
    });

    it('P2 arrastra el excedente de P1 y no se declara P1 después de P2', async () => {
      const prev = await previsualizar(db, 'iva', p2.anio, p2.mes);
      expect(prev.cifras).toMatchObject({ credito: '80.00', excedenteAnterior: '160.00', resultado: '-240.00', excedenteSiguiente: '240.00' });
    });
  });

  describe('cierre fiscal', () => {
    it('con el IVA de P1 declarado, la base rechaza aprobar un gasto fechado en P1', async () => {
      const g = await crearGasto(proveedorIva, '100.00', p1.ultimo);                 // se puede registrar pendiente…
      await esperarError(aprobar(g.id), 'está declarado');                           // …pero no contabilizar
      const e = (await db.query<{ estado: string }>('select estado from gasto_proveedor where id = $1', [g.id])).rows[0];
      expect(e.estado).toBe('pendiente');
    });

    it('un documento de un periodo abierto se sigue aceptando', async () => {
      const g = await crearGasto(proveedorIva, '100.00', p2.ultimo);
      await aprobar(g.id);                                                           // P2 aún no está declarado
    });

    it('Gerencia reabre con motivo; mientras tanto, Contabilidad no', async () => {
      const id = (await listarDeclaraciones(db)).find((d) => d.tipo === 'iva' && d.mes === p1.mes)!.id;
      await esperarError(como(contador, (tx) => reabrir(tx, contador, id, 'Falta una factura')), 'Solo Gerencia');
      await esperarError(como(gerente, (tx) => reabrir(tx, gerente, id, 'x')), 'motivo');
      await como(gerente, (tx) => reabrir(tx, gerente, id, 'Falta una factura de compra del mes'));
      await esperarError(como(gerente, (tx) => reabrir(tx, gerente, id, 'Otra vez')), 'ya fue reabierta');
      const g = await crearGasto(proveedorIva, '100.00', p1.ultimo);
      await aprobar(g.id);                                                           // ahora sí
      const prev = await previsualizar(db, 'iva', p1.anio, p1.mes);
      expect(prev.cifras).toMatchObject({ credito: '176.00', excedenteSiguiente: '176.00' });
      await declara('iva', p1);                                                      // se declara de nuevo con la cifra corregida
      const todas = await listarDeclaraciones(db);
      expect(todas.filter((d) => d.tipo === 'iva' && d.mes === p1.mes).map((d) => d.reabierta).sort()).toEqual([false, true]);
    });

    it('no se reabre un IVA si el mes siguiente ya se declaró con su excedente', async () => {
      await declara('iva', p2);
      const p1id = (await listarDeclaraciones(db)).find((d) => d.tipo === 'iva' && d.mes === p1.mes && !d.reabierta)!.id;
      await esperarError(como(gerente, (tx) => reabrir(tx, gerente, p1id, 'Corrección')), 'Reabra primero los meses de IVA posteriores');
      const prev = await previsualizar(db, 'iva', p1.anio, p1.mes);
      expect(prev.impedimentos.join(' ')).toContain('ya está declarado');
    });
  });

  describe('retenciones de IVA y de ISLR', () => {
    it('no se declaran con retenciones sin comprobante: primero se emiten', async () => {
      const prev = await previsualizar(db, 'retenciones_iva', p1.anio, p1.mes);
      expect(prev.impedimentos.join(' ')).toContain('sin comprobante');
      await esperarError(declara('retenciones_iva', p1), 'sin comprobante');
    });

    it('con los comprobantes emitidos, el CSV de IVA de P1 trae las retenciones del mes', async () => {
      await como(contador, (tx) => emitirPeriodo(tx, contador, p1.anio, p1.mes));
      const prev = await previsualizar(db, 'retenciones_iva', p1.anio, p1.mes);
      expect(prev.impedimentos).toEqual([]);
      expect(prev.cifras).toMatchObject({ comprobantes: 2, baseVes: '176.00', retenidoVes: '132.00', pendientes: 0 });   // IVA de 160 y de 16; 75 %
      expect(prev.archivoNombre).toBe(`retenciones-iva-${p1.anio}${String(p1.mes).padStart(2, '0')}.csv`);
      const id = await declara('retenciones_iva', p1);
      const d = (await detalleDeclaracion(db, id))!;
      expect(d.archivo!.split('\r\n').filter(Boolean)).toHaveLength(3);                // encabezado y dos retenciones
      expect(d.archivo).toContain(';160.00;75;120.00');
    });

    it('un contribuyente especial declara las retenciones de IVA por quincena', async () => {
      await especial(true);
      try {
        expect(await declaraPorQuincena(db)).toBe(true);
        await como(contador, (tx) => emitirPeriodo(tx, contador, p2.anio, p2.mes));
        const q1 = await previsualizar(db, 'retenciones_iva', p2.anio, p2.mes, 1);
        expect(q1.periodo).toMatchObject({ quincena: 1, hasta: `${p2.anio}-${String(p2.mes).padStart(2, '0')}-15` });
        expect(q1.cifras).toMatchObject({ comprobantes: 0 });
        const q2 = await previsualizar(db, 'retenciones_iva', p2.anio, p2.mes, 2);
        expect(q2.cifras).toMatchObject({ comprobantes: 2 });                            // los dos gastos de P2 son del último día
        await declara('retenciones_iva', p2, contador, 2);
        await esperarError(declara('retenciones_iva', p2, contador, 2), 'ya está declarado');
      } finally {
        await especial(false);
      }
    });

    it('con las retenciones de IVA declaradas, la base rechaza practicar otra con fecha dentro del periodo', async () => {
      const g = await crearGasto(proveedorIva, '100.00', p2.ultimo);
      await esperarError(aprobar(g.id), 'declarado');                                    // el IVA de P2 también está declarado
    });

    it('el XML de ISLR de P2 sale de la retención guardada y se guarda tal como se declaró', async () => {
      const prev = await previsualizar(db, 'retenciones_islr', p2.anio, p2.mes);
      expect(prev.impedimentos).toEqual([]);
      expect(prev.cifras).toMatchObject({ comprobantes: 1, baseVes: '500.00', retenidoVes: '25.00' });
      const id = await declara('retenciones_islr', p2);
      const d = (await detalleDeclaracion(db, id))!;
      expect(d.archivo_nombre).toBe(`retenciones-islr-${p2.anio}${String(p2.mes).padStart(2, '0')}.xml`);
      expect(d.archivo).toContain('RifAgente="J123456784"');
      expect(d.archivo).toContain('<CodigoConcepto>SERV</CodigoConcepto>');
      expect(d.archivo).toContain('<MontoOperacion>500.00</MontoOperacion>');
      expect(d.archivo).toContain('<PorcentajeRetencion>5</PorcentajeRetencion>');
    });
  });

  describe('integridad', () => {
    it('una declaración no se modifica ni se borra, y se audita', async () => {
      const id = (await listarDeclaraciones(db))[0].id;
      await esperarError(db.query(`update declaracion_fiscal set cifras = '{}'::jsonb where id = $1`, [id]), 'no se modifica');
      await esperarError(db.query('delete from declaracion_fiscal where id = $1', [id]), 'no se borra');
      const a = (await db.query<{ n: number }>(`select count(*)::int as n from audit_log where entidad = 'declaracion_fiscal'`)).rows[0].n;
      expect(a).toBeGreaterThan(0);
    });

    it('la anulación de una factura de venta de un mes con el IVA declarado se rechaza', async () => {
      const idGer = gerente.id;
      const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
      const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
      const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
      const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
      const c = await db.transaction((tx) => crearCliente(tx, idFac, {
        rif: 'J-00000010-7', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
      const almacen = (await db.query<{ id: string }>(`insert into almacen (codigo, nombre, sucursal_id) values ('01', 'Principal', $1) returning id`, [sucursal])).rows[0].id;
      // Una factura emitida hoy, insertada sin disparadores (solo para probar el bloqueo), y una declaración que cubre hoy (el disparador normal no lo permite).
      await db.query(`set session_replication_role = replica`);
      const f = (await db.query<{ id: string }>(
        `insert into documento_venta (tipo, serie, numero, numero_control, estado, sucursal_id, almacen_id, cliente_id, fecha_emision, moneda, tasa, created_by)
         values ('factura', 'A', 1, '00-1', 'emitido', $1, $2, $3, now(), 'VES', 40, $4) returning id`, [sucursal, almacen, c.id, idVen])).rows[0].id;
      await db.query(
        `insert into declaracion_fiscal (tipo, anio, mes, desde, hasta, cifras, declarada_por) values ('iva', 2099, 1, current_date - 1, current_date + 1, '{}'::jsonb, $1)`, [contador.id]);
      await db.query(`set session_replication_role = origin`);
      await esperarError(db.query(`update documento_venta set estado = 'anulado', anulado_motivo = 'Prueba', anulado_motivo_id = (select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'), anulado_at = now() where id = $1`, [f]), 'está declarado');
      await db.query(`set session_replication_role = replica`);
      await db.query(`delete from declaracion_fiscal where anio = 2099`);
      await db.query(`set session_replication_role = origin`);
    });
  });
});
