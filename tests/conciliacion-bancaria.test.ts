import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { crearCuentaBancaria } from '@/lib/maestros/cuentas-bancarias';
import {
  agregarLinea, candidatosDe, cerrarExtracto, conciliar, conciliarPares, crearExtracto, desconciliar, detalleExtracto, eliminarLinea, enTransito, importarCsv,
  leerCsvBanco, leerNumeroBanco, lineasDeExtracto, listarExtractos, proponer, resumen, type UsuarioConc,
} from '@/lib/tesoreria/conciliacion';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Conciliación bancaria (spec §10.2; migración 0041). Cuenta en bolívares con movimientos de enero y febrero del año en curso.
 */
describe('conciliación bancaria (R-CK a R-CM)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let tesoreria: UsuarioConc;
  let contador: UsuarioConc;
  let anio = 0;
  let cuenta = '';
  let contable = '';
  let extEne = '';
  let n = 0;

  const como = <T,>(u: UsuarioConc, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const fecha = (mes: number, dia: number) => `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  /** Movimiento en el mayor de la cuenta: monto positivo = depósito (debe), negativo = salida (haber). */
  const asiento = async (f: string, monto: string, moneda = 'VES') => {
    const abs = monto.replace('-', '');
    const evento = monto.startsWith('-') ? 'mov_salida_prueba' : 'mov_entrada_prueba';
    await db.transaction((tx) => contabilizar(tx, {
      evento, fecha: f, descripcion: `Movimiento ${++n}`, origen: { tipo: 'prueba', id: randomUUID() }, moneda, importes: { monto: abs }, cuentas: { banco: contable }, usuarioId: tesoreria.id,
    }));
  };
  const lineaMayor = async (f: string, neto: string) => (await db.query<{ id: string }>(
    `select l.id::text from asiento_linea l join asiento a on a.id = l.asiento_id where l.cuenta_id = $1 and a.fecha = $2::date and (l.debe_ves - l.haber_ves) = $3 order by l.id limit 1`,
    [contable, f, neto])).rows[0].id;
  const banco = async (extracto: string, f: string, monto: string, referencia?: string) => como(tesoreria, (tx) => agregarLinea(tx, tesoreria, extracto, { fecha: f, descripcion: 'Movimiento del banco', referencia, monto }));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    tesoreria = { id: await usuarioDePrueba(db, 'tesoreria@prueba.test', ['tesoreria']), roles: ['tesoreria'] };
    contador = { id: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']), roles: ['contabilidad'] };
    anio = (await db.query<{ a: number }>(`select extract(year from now())::int as a`)).rows[0].a;
    await db.query(`select fn_crear_periodos($1)`, [anio]);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) select d::date, 'USD', 40 from generate_series($1::date, $2::date, interval '1 day') d`, [`${anio}-01-01`, `${anio}-03-10`]);
    const b = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    const c = await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: b, numero: '0102-0000-11' }));
    cuenta = c.id;
    contable = (await db.query<{ id: string }>('select cuenta_contable_id as id from cuenta_bancaria where id = $1', [cuenta])).rows[0].id;
    const puente = (await db.query<{ id: string }>(`select id from cuenta_contable where codigo = '3.9.01'`)).rows[0].id;
    await db.query(
      `insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa) values
         ('mov_entrada_prueba', 1, 'D', null, 'banco', 'monto', 'Entrada al banco'), ('mov_entrada_prueba', 2, 'H', $1, null, 'monto', 'Contrapartida'),
         ('mov_salida_prueba', 1, 'D', $1, null, 'monto', 'Contrapartida'), ('mov_salida_prueba', 2, 'H', null, 'banco', 'monto', 'Salida del banco')`, [puente]);
    // Mayor del banco: enero +1000 (día 5), −250 (día 10), +80 (día 28), +40 (día 30); febrero +10 (día 2).
    await asiento(fecha(1, 5), '1000.00');
    await asiento(fecha(1, 10), '-250.00');
    await asiento(fecha(1, 28), '80.00');
    await asiento(fecha(1, 30), '40.00');
    await asiento(fecha(2, 2), '10.00');
  });

  afterAll(async () => { await cerrar(); });

  describe('lectura del CSV del banco', () => {
    it('entiende montos con coma, con punto y entre paréntesis, y rechaza los ambiguos', () => {
      expect(leerNumeroBanco('1.234,56')).toBe('1234.56');
      expect(leerNumeroBanco('1,234.56')).toBe('1234.56');
      expect(leerNumeroBanco('-250,5')).toBe('-250.5');
      expect(leerNumeroBanco('(80.00)')).toBe('-80.00');
      expect(() => leerNumeroBanco('1.234')).toThrow('ambiguo');
      expect(() => leerNumeroBanco('abc')).toThrow('no es un monto válido');
    });

    it('lee una columna de monto con signo o dos columnas de ingreso y egreso, con fecha dd-mm-aaaa', () => {
      const a = leerCsvBanco('Fecha;Descripción;Referencia;Monto\n06-01-2026;Depósito;123;1000,00\n10/01/2026;Transferencia;456;-250,00\n');
      expect(a).toEqual([
        { fecha: '2026-01-06', descripcion: 'Depósito', referencia: '123', monto: '1000.00' },
        { fecha: '2026-01-10', descripcion: 'Transferencia', referencia: '456', monto: '-250.00' },
      ]);
      const b = leerCsvBanco('fecha,descripcion,debito,credito\n2026-01-06,"Pago, proveedor",100.50,\n2026-01-07,Abono,,40.00');
      expect(b.map((x) => x.monto)).toEqual(['-100.50', '40.00']);
    });

    it('indica la fila con el error y exige las columnas', () => {
      expect(() => leerCsvBanco('fecha;descripcion;monto\n06-01-2026;Ok;10,00\n99-99-9999;Mala;5,00')).toThrow('Fila 3');
      expect(() => leerCsvBanco('fecha;monto\n06-01-2026;10,00')).toThrow('necesita las columnas');
      expect(() => leerCsvBanco('fecha;descripcion;monto')).toThrow('no trae movimientos');
    });
  });

  describe('extracto de enero', () => {
    it('solo Tesorería carga; no se aceptan cajas ni meses repetidos', async () => {
      await esperarError(como(contador, (tx) => crearExtracto(tx, contador, { cuentaId: cuenta, anio, mes: 1, saldoInicial: '0', saldoFinal: '825' })), 'Solo Tesorería');
      const caja = await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Caja', tipo: 'caja', moneda: 'VES' }));
      await esperarError(como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: caja.id, anio, mes: 1, saldoInicial: '0', saldoFinal: '0' })), 'no cajas');
      await esperarError(como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: cuenta, anio, mes: 1, saldoInicial: 'x', saldoFinal: '0' })), 'saldos del banco');
      extEne = await como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: cuenta, anio, mes: 1, saldoInicial: '0.00', saldoFinal: '825.00' }));
      await esperarError(como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: cuenta, anio, mes: 1, saldoInicial: '0', saldoFinal: '0' })), 'duplicate');
      await esperarError(como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: cuenta, anio, mes: 2, saldoInicial: '825', saldoFinal: '835' })), 'meses anteriores');
    });

    it('importa el CSV completo o nada, y las fechas deben ser del mes', async () => {
      await esperarError(como(tesoreria, (tx) => importarCsv(tx, tesoreria, extEne, `fecha;descripcion;monto\n${fecha(1, 6)};Bien;10,00\n${fecha(2, 6)};Otro mes;5,00`)), 'Fila 3');
      expect(await lineasDeExtracto(db, extEne)).toHaveLength(0);
      const csv = [
        'fecha;descripcion;referencia;monto',
        `${fecha(1, 6)};Depósito en ventanilla;D-100;1000,00`,
        `${fecha(1, 10)};Transferencia emitida;T-200;-250,00`,
        `${fecha(1, 28)};Depósito;D-300;80,00`,
        `${fecha(1, 31)};Comisión mensual;;-5,00`,
      ].join('\n');
      expect(await como(tesoreria, (tx) => importarCsv(tx, tesoreria, extEne, csv))).toBe(4);
      expect(await lineasDeExtracto(db, extEne)).toHaveLength(4);
    });

    it('propone pares por monto y ventana; lo que no tiene pareja queda sin propuesta', async () => {
      const prop = await proponer(db, extEne);
      const lineas = await lineasDeExtracto(db, extEne);
      const de = (monto: string) => prop.find((p) => p.linea_id === lineas.find((l) => l.monto === monto)!.id)!;
      expect(de('1000.00').candidatos).toHaveLength(1);
      expect(de('1000.00').candidatos[0].dias).toBe(1);
      expect(de('1000.00').unica).toBe(true);
      expect(de('-250.00').candidatos).toHaveLength(1);
      expect(de('80.00').unica).toBe(true);
      expect(de('-5.00').candidatos).toHaveLength(0);            // la comisión todavía no está en libros
    });

    it('el cierre se rechaza con líneas sin conciliar', async () => {
      await esperarError(como(contador, (tx) => cerrarExtracto(tx, contador, extEne)), 'sin conciliar');
      expect((await resumen(db, extEne)).puede_cerrar).toBe(false);
    });

    it('Tesorería confirma los pares propuestos; Contabilidad no concilia', async () => {
      const prop = (await proponer(db, extEne)).filter((p) => p.unica);
      expect(prop).toHaveLength(3);
      await esperarError(como(contador, (tx) => conciliarPares(tx, contador, prop.map((p) => ({ lineaId: p.linea_id, asientoLineaId: p.candidatos[0].asiento_linea_id })))), 'Solo Tesorería');
      await como(tesoreria, (tx) => conciliarPares(tx, tesoreria, prop.map((p) => ({ lineaId: p.linea_id, asientoLineaId: p.candidatos[0].asiento_linea_id }))));
      const r = await resumen(db, extEne);
      expect(r.conciliadas).toBe(3);
      expect(r.pendientes).toBe(1);
      expect(await proponer(db, extEne)).toHaveLength(1);
    });

    it('la base exige el mismo monto y que el asiento sea de la cuenta, y no admite un asiento dos veces', async () => {
      const comision = (await lineasDeExtracto(db, extEne)).find((l) => l.monto === '-5.00')!.id;
      const transito = await lineaMayor(fecha(1, 30), '40.00');
      await esperarError(como(tesoreria, (tx) => conciliar(tx, tesoreria, comision, transito)), 'no es el del asiento');
      const otro = await lineaMayor(fecha(1, 5), '1000.00');
      const extra = await banco(extEne, fecha(1, 6), '1000.00');
      await esperarError(como(tesoreria, (tx) => conciliar(tx, tesoreria, extra, otro)), 'duplicate');
      await como(tesoreria, (tx) => eliminarLinea(tx, tesoreria, extra));
      const puente = (await db.query<{ id: string }>(
        `select l.id::text from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01' and l.haber_ves = 1000 limit 1`)).rows[0].id;
      const prueba = await banco(extEne, fecha(1, 6), '-1000.00');
      await esperarError(como(tesoreria, (tx) => conciliar(tx, tesoreria, prueba, puente)), 'no es de la cuenta contable de este banco');
      await como(tesoreria, (tx) => eliminarLinea(tx, tesoreria, prueba));
    });

    it('los candidatos manuales muestran primero los del mismo monto', async () => {
      const comision = (await lineasDeExtracto(db, extEne)).find((l) => l.monto === '-5.00')!.id;
      const c = await candidatosDe(db, comision);
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((x) => !x.mismo_monto)).toBe(true);
      expect((await enTransito(db, extEne)).map((t) => t.neto)).toContain('40.00');
    });

    it('con la comisión sin asiento, el mes no cierra; registrada y conciliada, cuadra con lo que está en tránsito', async () => {
      const comision = (await lineasDeExtracto(db, extEne)).find((l) => l.monto === '-5.00')!.id;
      await asiento(fecha(1, 31), '-5.00');
      const p = (await proponer(db, extEne))[0];
      expect(p.linea_id).toBe(comision);
      expect(p.unica).toBe(true);
      await como(tesoreria, (tx) => conciliar(tx, tesoreria, comision, p.candidatos[0].asiento_linea_id));
      const r = await resumen(db, extEne);
      expect(r.pendientes).toBe(0);
      expect(r.banco_cuadra).toBe(true);
      expect(r.mayor).toBe('865.00');
      expect(r.transito).toBe('40.00');
      expect(r.diferencia).toBe('0.00');
      expect(r.puede_cerrar).toBe(true);
    });

    it('una línea se puede desconciliar mientras el mes esté abierto', async () => {
      const l = (await lineasDeExtracto(db, extEne)).find((x) => x.monto === '80.00')!;
      await como(tesoreria, (tx) => desconciliar(tx, tesoreria, l.id));
      expect((await resumen(db, extEne)).pendientes).toBe(1);
      await esperarError(como(contador, (tx) => cerrarExtracto(tx, contador, extEne)), 'sin conciliar');
      const p = (await proponer(db, extEne))[0];
      await como(tesoreria, (tx) => conciliar(tx, tesoreria, l.id, p.candidatos[0].asiento_linea_id));
    });

    it('solo Contabilidad o Gerencia cierran, y quien concilió no cierra', async () => {
      await esperarError(como(tesoreria, (tx) => cerrarExtracto(tx, tesoreria, extEne)), 'Solo Contabilidad o Gerencia');
      // Tesorería también es gerente: quien concilió no cierra aunque tenga el rol.
      const doble: UsuarioConc = { id: tesoreria.id, roles: ['gerencia'] };
      await db.query('insert into usuario_rol (usuario_id, rol) values ($1, $2)', [tesoreria.id, 'gerencia']);
      await esperarError(como(doble, (tx) => cerrarExtracto(tx, doble, extEne)), 'Quien concilió');
      await db.query(`delete from usuario_rol where usuario_id = $1 and rol = 'gerencia'`, [tesoreria.id]);
    });

    it('cierra el mes y lo cerrado no se toca', async () => {
      await como(contador, (tx) => cerrarExtracto(tx, contador, extEne));
      const d = (await detalleExtracto(db, extEne))!;
      expect(d.estado).toBe('cerrado');
      const cifras = (await db.query<{ cierre_mayor: string; cierre_transito: string }>('select cierre_mayor::text, cierre_transito::text from extracto_bancario where id = $1', [extEne])).rows[0];
      expect(cifras).toEqual({ cierre_mayor: '865.00', cierre_transito: '40.00' });
      const l = (await lineasDeExtracto(db, extEne))[0];
      await esperarError(como(tesoreria, (tx) => desconciliar(tx, tesoreria, l.id)), 'cerrado');
      await esperarError(como(tesoreria, (tx) => eliminarLinea(tx, tesoreria, l.id)), 'cerrado');
      await esperarError(banco(extEne, fecha(1, 12), '5.00'), 'cerrado');
      await esperarError(db.query(`update extracto_bancario set saldo_final = 1 where id = $1`, [extEne]), 'cerrado');
      await esperarError(db.query(`delete from extracto_bancario where id = $1`, [extEne]), 'no se borra');
    });
  });

  describe('extracto de febrero', () => {
    let extFeb = '';

    it('el saldo inicial es el final del último mes cerrado', async () => {
      await esperarError(como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: cuenta, anio, mes: 2, saldoInicial: '800', saldoFinal: '810' })), 'saldo final del último mes cerrado');
      extFeb = await como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: cuenta, anio, mes: 2, saldoInicial: '825.00', saldoFinal: '835.00' }));
      await banco(extFeb, fecha(2, 3), '10.00');
    });

    it('un saldo final que no cuadra con los movimientos impide el cierre', async () => {
      const p = (await proponer(db, extFeb))[0];
      await como(tesoreria, (tx) => conciliar(tx, tesoreria, p.linea_id, p.candidatos[0].asiento_linea_id));
      await db.query('update extracto_bancario set saldo_final = 999 where id = $1', [extFeb]);
      await esperarError(como(contador, (tx) => cerrarExtracto(tx, contador, extFeb)), 'no da el saldo final');
      await db.query('update extracto_bancario set saldo_final = 835 where id = $1', [extFeb]);
    });

    it('lo que sigue en tránsito de enero se arrastra y el mes cuadra contra el mayor', async () => {
      const r = await resumen(db, extFeb);
      expect(r.mayor).toBe('875.00');
      expect(r.transito).toBe('40.00');
      expect(r.cuadra).toBe(true);
      await como(contador, (tx) => cerrarExtracto(tx, contador, extFeb));
      expect((await listarExtractos(db)).map((e) => e.estado)).toEqual(['cerrado', 'cerrado']);
    });
  });

  it('en una cuenta en dólares el mayor se compara en USD', async () => {
    const b = (await db.query<{ id: string }>(`select id from banco limit 1`)).rows[0].id;
    const usd = await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco USD', tipo: 'banco', moneda: 'USD', bancoId: b, numero: '0102-0000-22' }));
    const cont = (await db.query<{ id: string }>('select cuenta_contable_id as id from cuenta_bancaria where id = $1', [usd.id])).rows[0].id;
    await db.transaction((tx) => contabilizar(tx, {
      evento: 'mov_entrada_prueba', fecha: fecha(3, 3), descripcion: 'Depósito en dólares', origen: { tipo: 'prueba', id: randomUUID() }, moneda: 'USD',
      importes: { monto: '100.00' }, cuentas: { banco: cont }, usuarioId: tesoreria.id,
    }));
    const e = await como(tesoreria, (tx) => crearExtracto(tx, tesoreria, { cuentaId: usd.id, anio, mes: 3, saldoInicial: '0', saldoFinal: '100.00' }));
    await banco(e, fecha(3, 4), '100.00');
    const p = (await proponer(db, e))[0];
    expect(p.unica).toBe(true);
    await como(tesoreria, (tx) => conciliar(tx, tesoreria, p.linea_id, p.candidatos[0].asiento_linea_id));
    const r = await resumen(db, e);
    expect(r.moneda).toBe('USD');
    expect(r.mayor).toBe('100.00');
    expect(r.cuadra).toBe(true);
  });
});
