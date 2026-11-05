import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fijarFechaArranque, registrarBanco } from '@/lib/apertura/apertura';
import { checklist, confirmar, retirarConfirmacion, type CodigoConfirmacion, type UsuarioChecklist } from '@/lib/apertura/checklist';
import { crearConteo, enviarConteo, fijarCostos, guardarLineaConteo } from '@/lib/apertura/inventario';
import { aprobarAsiento, guardarBorrador, huellaAsiento } from '@/lib/contabilidad/manual';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCuentaBancaria } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Checklist de arranque (spec §14.6; migración 0050): lo que el sistema comprueba solo y lo que una persona confirma.
 */
describe('checklist de arranque (R-DN, R-DO)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let admin: UsuarioChecklist;
  let almacenista: UsuarioChecklist;
  let tesoreria: UsuarioChecklist;
  let contador: UsuarioChecklist;
  let jefe: UsuarioChecklist;
  let gerente: UsuarioChecklist;
  let otroGerente: UsuarioChecklist;
  let hoy = '';

  const como = <T,>(u: UsuarioChecklist, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const punto = async (codigo: string) => (await checklist(db)).puntos.find((p) => p.codigo === codigo)!;
  const confirma = (codigo: CodigoConfirmacion, u: UsuarioChecklist, nota?: string) => como(u, (tx) => confirmar(tx, u, codigo, nota));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const id = async (email: string, rol: string) => ({ id: await usuarioDePrueba(db, email, [rol]), roles: [rol] });
    admin = await id('admin@prueba.test', 'administrador');
    almacenista = await id('almacen@prueba.test', 'almacen');
    tesoreria = await id('tesoreria@prueba.test', 'tesoreria');
    contador = await id('contador@prueba.test', 'contabilidad');
    jefe = await id('jefe@prueba.test', 'jefe_contabilidad');
    gerente = await id('gerente@prueba.test', 'gerencia');
    otroGerente = await id('gerente2@prueba.test', 'gerencia');
    hoy = (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40)`, [hoy]);
  });
  afterAll(() => cerrar());

  it('con la base vacía casi nada está listo y se explica qué falta', async () => {
    const c = await checklist(db);
    expect(c.todoListo).toBe(false);
    expect(c.puntos.map((p) => p.codigo)).toEqual(['configuracion', 'inventario', 'bancos', 'cartera', 'apertura', 'factura', 'usuarios', 'respaldo']);
    expect(c.puntos.filter((p) => p.listo)).toEqual([]);
    const cfg = await punto('configuracion');
    expect(cfg.automatico!.detalle).toContain('Falta:');
    expect(cfg.automatico!.detalle).toContain('fecha de arranque');
    expect((await punto('factura')).automatico!.detalle).toContain('Todavía no se ha emitido ninguna factura');
  });

  describe('confirmaciones de las personas', () => {
    it('cada una la hace solo su rol, una sola vez, y deja responsable, fecha y nota', async () => {
      await esperarError(confirma('bancos', almacenista), 'no puede hacer esa confirmación');
      await esperarError(confirma('capacitacion', contador), 'no puede hacer esa confirmación');
      await esperarError(confirma('respaldo', tesoreria), 'no puede hacer esa confirmación');
      await confirma('respaldo', admin, 'Restauración probada en el servidor de pruebas');
      const r = await punto('respaldo');
      expect(r.listo).toBe(true);
      expect(r.confirmacion!.hecha).toMatchObject({ nota: 'Restauración probada en el servidor de pruebas' });
      await esperarError(confirma('respaldo', admin), 'ya está hecha');
    });

    it('la base también rechaza una confirmación de un rol que no corresponde', async () => {
      await esperarError(como(almacenista, (tx) => tx.query(`insert into arranque_confirmacion (codigo, confirmado_por) values ('bancos', $1)`, [almacenista.id])), 'Su rol no puede');
    });

    it('una confirmación no se edita ni se borra; solo Gerencia la retira, con motivo, y se puede confirmar de nuevo', async () => {
      const hecha = (await punto('respaldo')).confirmacion!.hecha!;
      await esperarError(db.query(`update arranque_confirmacion set nota = 'otra' where id = $1`, [hecha.id]), 'no se edita');
      await esperarError(db.query('delete from arranque_confirmacion where id = $1', [hecha.id]), 'no se borra');
      await esperarError(como(admin, (tx) => retirarConfirmacion(tx, admin, hecha.id, 'Prueba')), 'Solo Gerencia');
      await esperarError(como(gerente, (tx) => retirarConfirmacion(tx, gerente, hecha.id, 'x')), 'motivo');
      await como(gerente, (tx) => retirarConfirmacion(tx, gerente, hecha.id, 'La restauración falló en la segunda prueba'));
      expect((await punto('respaldo')).listo).toBe(false);
      await confirma('respaldo', admin, 'Restauración probada de nuevo');
      expect((await punto('respaldo')).listo).toBe(true);
    });
  });

  describe('lo que el sistema comprueba solo', () => {
    it('los usuarios con contraseña inicial impiden el punto de usuarios', async () => {
      const u = await punto('usuarios');
      expect(u.automatico!.ok).toBe(false);
      expect(u.automatico!.detalle).toContain('todavía tienen la contraseña inicial');
      await db.query('update usuario set debe_cambiar_password = false');
      const despues = await punto('usuarios');
      expect(despues.automatico!.ok).toBe(true);
      expect(despues.listo).toBe(false);                                   // falta la confirmación de capacitación
      await confirma('capacitacion', gerente, 'Capacitación del 3 y 4 de noviembre');
      expect((await punto('usuarios')).listo).toBe(true);
    });

    it('una factura con el simulador de pruebas no cuenta como la primera factura fiscal', async () => {
      const f = await punto('factura');
      expect(f.listo).toBe(false);
    });

    it('configuración: lista cuando está todo y el contador lo revisó', async () => {
      await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
      await db.query(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto')`);
      await db.query('update parametro_fiscal set validado_por_contador = true');
      await como(gerente, (tx) => fijarFechaArranque(tx, gerente, hoy));
      const cfg = await punto('configuracion');
      expect(cfg.automatico!.ok).toBe(true);
      expect(cfg.listo).toBe(false);                                       // falta la revisión del contador
      await confirma('configuracion', contador, 'Revisada el 4-11-2026');
      expect((await punto('configuracion')).listo).toBe(true);
    });

    it('bancos, cartera, inventario y apertura se completan con sus documentos aprobados', async () => {
      const sucursal = (await db.query<{ id: string }>('select id from sucursal limit 1')).rows[0].id;
      const a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
      await db.transaction((tx) => asignarUsuarios(tx, a01, [almacenista.id]));
      expect((await punto('inventario')).automatico!.detalle).toContain('Todavía no hay conteos aprobados');
      const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
      const cuenta = (await como(tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-11' }))).id;
      const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
      const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
      const bse = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-1', { descripcion: 'Artículo 1' }));
      const prod = await db.transaction((tx) => crearProducto(tx, almacenista.id, 'PF-001', {
        descripcion: 'Pastilla', productoBaseId: bse.id, marcaId: marca, unidad: 'UND', alicuotaIvaId: general, inventariable: true,
      }));

      // Banco: registra Tesorería, aprueba Gerencia.
      const b = await como(tesoreria, (tx) => registrarBanco(tx, tesoreria, { cuentaBancariaId: cuenta, saldo: '1000.00' }));
      await como(gerente, (tx) => resolverAprobacion(tx, 'apertura_banco', b.id, gerente.id, 'aprobada'));
      expect((await punto('bancos')).automatico!.ok).toBe(true);
      expect((await punto('bancos')).listo).toBe(false);
      await confirma('bancos', tesoreria, 'Cuadrado con el estado de cuenta del 31-10');

      // Inventario: cuenta Almacén, costo Contabilidad, aprueba otra persona de Gerencia.
      const c = await como(almacenista, (tx) => crearConteo(tx, almacenista, { almacenId: a01 }));
      await como(almacenista, (tx) => guardarLineaConteo(tx, almacenista, c.id, { productoId: prod, cantidad: '10' }));
      const l = (await db.query<{ id: string }>('select id from apertura_inventario_linea where apertura_id = $1', [c.id])).rows[0].id;
      await como(contador, (tx) => fijarCostos(tx, contador, c.id, { [l]: '5' }));
      await como(almacenista, (tx) => enviarConteo(tx, almacenista, c.id));
      await como(otroGerente, (tx) => resolverAprobacion(tx, 'apertura_inventario', c.id, otroGerente.id, 'aprobada'));
      expect((await punto('inventario')).listo).toBe(true);

      // Asiento de apertura del contador por lo que falta en Saldos de apertura (bancos 1.000 + inventario 2.000 al haber).
      const cuentaId = async (codigo: string) => (await db.query<{ id: string }>('select id from cuenta_contable where codigo = $1', [codigo])).rows[0].id;
      const [cPuente, cPatrimonio] = [await cuentaId('3.9.01'), (await db.query<{ id: string }>(`select id from cuenta_contable where tipo = 'patrimonio' and imputable and codigo <> '3.9.01' order by codigo limit 1`)).rows[0].id];
      const total = (await db.query<{ s: string }>(
        `select coalesce(sum(l.haber_ves - l.debe_ves), 0)::text as s from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01'`)).rows[0].s;
      expect((await punto('apertura')).listo).toBe(false);
      const as = await como(contador, (tx) => guardarBorrador(tx, contador.id, {
        fecha: hoy, descripcion: 'Asiento de apertura', moneda: 'VES', tipo: 'apertura',
        lineas: [{ cuentaId: cPuente, debe: total, haber: '' }, { cuentaId: cPatrimonio, debe: '', haber: total }],
      }));
      await como(jefe, async (tx) => aprobarAsiento(tx, as, jefe.id, await huellaAsiento(tx, as)));
      expect((await punto('apertura')).listo).toBe(true);

      // Cartera: con documentos pendientes no hay cuentas por cobrar ni por pagar registradas todavía.
      expect((await punto('cartera')).automatico!.ok).toBe(false);
    });
  });

  describe('firmas', () => {
    it('no se firma con puntos pendientes', async () => {
      expect((await checklist(db)).todoListo).toBe(false);
      await esperarError(confirma('firma_gerencia', gerente), 'todos los puntos del checklist');
      await esperarError(confirma('firma_contador', contador), 'todos los puntos del checklist');
    });

    it('con todo en orden firman Gerencia y el contador, cada uno en lo suyo; retirar un punto invalida las firmas', async () => {
      // La cartera y la primera factura real necesitan flujos largos que ya prueban otros archivos: aquí se insertan filas mínimas sin disparadores ni llaves.
      const uuid = () => crypto.randomUUID();
      const sucursal = (await db.query<{ id: string }>('select id from sucursal limit 1')).rows[0].id;
      await db.query('set session_replication_role = replica');
      await db.query(
        `insert into apertura_cxp (numero, proveedor_id, numero_documento, fecha_original, vencimiento, fecha, moneda, saldo, tasa_usd, tasa, saldo_ves, saldo_usd, estado, created_by, aprobado_por, aprobado_at)
         values (1, $1, 'F-1', current_date - 30, current_date - 10, current_date, 'USD', 1, 1, 1, 1, 1, 'aprobado', $2, $2, now())`, [uuid(), gerente.id]);
      await db.query(
        `insert into documento_venta (tipo, serie, numero, numero_control, estado, sucursal_id, almacen_id, cliente_id, fecha_emision, moneda, tasa, imprenta, created_by)
         values ('factura', 'A', 1, '00-1', 'emitido', $1, $2, $3, now(), 'VES', 40, 'Imprenta Digital Autorizada', $4)`, [sucursal, uuid(), uuid(), gerente.id]);
      await db.query('set session_replication_role = origin');
      await confirma('cartera', contador, 'Cuadrada con los totales de la contabilidad anterior');
      const c = await checklist(db);
      expect(c.puntos.filter((p) => !p.listo).map((p) => p.codigo)).toEqual([]);
      expect(c.todoListo).toBe(true);
      expect(c.firmado).toBe(false);

      await esperarError(confirma('firma_contador', gerente), 'no puede hacer esa confirmación');
      await esperarError(confirma('firma_gerencia', contador), 'no puede hacer esa confirmación');
      await confirma('firma_gerencia', gerente, 'Arranque aprobado');
      expect((await checklist(db)).firmado).toBe(false);
      await confirma('firma_contador', jefe, 'Revisado y de acuerdo');
      const firmado = await checklist(db);
      expect(firmado.firmado).toBe(true);
      expect(firmado.firmas.gerencia!.por).toBe('Usuario de prueba');

      // Retirar un punto invalida las firmas ya dadas.
      const respaldo = (await punto('respaldo')).confirmacion!.hecha!;
      await como(gerente, (tx) => retirarConfirmacion(tx, gerente, respaldo.id, 'Hay que repetir la prueba de restauración'));
      const despues = await checklist(db);
      expect([despues.todoListo, despues.firmado, despues.firmas.gerencia, despues.firmas.contador]).toEqual([false, false, null, null]);
    });
  });
});
