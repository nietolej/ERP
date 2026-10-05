import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eliminarBorrador, guardarBorrador, huellaAsiento } from '@/lib/contabilidad/manual';
import {
  agregarPaso, cancelarSolicitud, crearDelegacion, decidirAprobacion, delegacionesDe, historialDecisiones, listarDefiniciones,
  pendientesDe, puedeDecidirObjeto, quitarDelegacion, quitarPaso, solicitarAprobacion, cambiarActivoFlujo, type Manejador,
} from '@/lib/flujo/flujo';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { crearCliente } from '@/lib/maestros/clientes';
import { crearLoteMetas } from '@/lib/maestros/metas';
import { crearProveedor, solicitarCambio, type DatosSensibles } from '@/lib/maestros/proveedores';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, cuenta, esperarError, usuarioDePrueba } from './apoyo';

/** Manejador de prueba que anota lo que el motor le pide. */
function espia() {
  const llamadas: { accion: string; objeto: string; usuario: string; datos?: unknown }[] = [];
  const m: Manejador<string> = {
    alAprobar: async (_tx, objeto, usuario, datos) => { llamadas.push({ accion: 'aprobar', objeto, usuario, datos }); return 'hecho'; },
    alRechazar: async (_tx, objeto, usuario) => { llamadas.push({ accion: 'rechazar', objeto, usuario }); },
  };
  return { llamadas, m };
}

describe('flujo de trabajo y aprobaciones (§4.5)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente: string;
  let otroGerente: string;
  let facturacion: string;
  let compras: string;
  let jefe: string;
  let supervisor: string;
  let contador: string;

  const como = <T,>(usuario: string, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  const sol = (tipo: string, objeto: string, solicitante: string, contexto = {}) =>
    db.transaction((tx) => solicitarAprobacion(tx, { tipo, objetoId: objeto, solicitanteId: solicitante, contexto }));
  const decidir = <R,>(m: Manejador<R>, tipo: string, objeto: string, usuario: string, decision: 'aprobada' | 'rechazada' = 'aprobada', extra: { comentario?: string; datos?: Record<string, unknown> } = {}) =>
    db.transaction((tx) => decidirAprobacion(tx, { tipo, objetoId: objeto, usuarioId: usuario, decision, ...extra }, m));
  const estadoDe = async (id: string) => (await db.query<{ estado: string; paso_actual: number }>('select estado, paso_actual from solicitud_aprobacion where id = $1', [id])).rows[0];
  /** Define un flujo de prueba con los pasos indicados. */
  const flujoDePrueba = async (tipo: string, pasos: { rol: string; campo?: string; op?: string; valor?: string; horas?: number; escalar?: string; distinto?: boolean }[]) => {
    const { rows } = await db.query<{ id: string }>(`insert into flujo_definicion (objeto_tipo, nombre) values ($1, 'Flujo de prueba') returning id`, [tipo]);
    for (const [i, p] of pasos.entries()) {
      await db.query(
        `insert into flujo_paso (definicion_id, orden, rol_aprobador, condicion_campo, condicion_operador, condicion_valor, horas_para_escalar, escalar_a_rol, distinto_del_creador)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rows[0].id, i + 1, p.rol, p.campo ?? null, p.op ?? null, p.valor ?? null, p.horas ?? null, p.escalar ?? null, p.distinto ?? true]);
    }
    return rows[0].id;
  };

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    otroGerente = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    facturacion = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    compras = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    jefe = await usuarioDePrueba(db, 'jefe@prueba.test', ['jefe_contabilidad']);
    supervisor = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    contador = await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']);
  });
  afterAll(() => cerrar());

  it('la configuración inicial recoge las aprobaciones que ya existían, con sus mismos roles', async () => {
    const defs = await listarDefiniciones(db);
    const porTipo = Object.fromEntries(defs.map((d) => [d.objeto_tipo, d.pasos.map((p) => p.rol_aprobador)]));
    expect(porTipo).toEqual({
      cliente: ['gerencia'], proveedor: ['gerencia'], proveedor_cambio: ['gerencia'], asiento_manual: ['jefe_contabilidad'], meta_lote: ['gerencia'],
      pedido_credito: ['gerencia'], ajuste_inventario: ['gerencia'],
    });
    expect(defs.every((d) => d.activo && d.pasos.every((p) => p.distinto_del_creador))).toBe(true);
  });

  it('crear un cliente abre su solicitud; Gerencia (otra persona) la aprueba con las condiciones de crédito y el cliente queda activo', async () => {
    const c = await db.transaction((tx) => crearCliente(tx, facturacion, {
      rif: 'J-12345678-4', tercero: { razonSocial: 'Repuestos Lara', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: {},
    }));
    const { rows } = await db.query<{ id: string; estado: string }>(`select id, estado from solicitud_aprobacion where objeto_tipo = 'cliente' and objeto_id = $1`, [c.id]);
    expect(rows[0].estado).toBe('pendiente');
    expect(await puedeDecidirObjeto(db, gerente, 'cliente', c.id)).toBe(true);
    expect(await puedeDecidirObjeto(db, facturacion, 'cliente', c.id)).toBe(false);
    expect((await pendientesDe(db, gerente)).some((p) => p.objeto_id === c.id)).toBe(true);
    expect((await pendientesDe(db, facturacion)).some((p) => p.objeto_id === c.id)).toBe(false);

    await esperarError(como(compras, (tx) => resolverAprobacion(tx, 'cliente', c.id, compras, 'aprobada')), 'No puede decidir');           // sin el rol
    await esperarError(como(facturacion, (tx) => resolverAprobacion(tx, 'cliente', c.id, facturacion, 'aprobada')), 'Quien solicita');   // quien la registró
    // Rechazar un alta no está previsto: el motor lo dice antes de tocar nada.
    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'cliente', c.id, gerente, 'rechazada', { comentario: 'No' })), 'no se rechaza');

    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const datos = { condicionPagoId: contado, limiteCreditoUsd: '1500', nivelPrecio: 'B', descuentoPct: '0' };
    const r = await como(gerente, (tx) => resolverAprobacion(tx, 'cliente', c.id, gerente, 'aprobada', { datos }));
    expect(r.estado).toBe('aprobada');
    expect((await db.query<{ estado: string; aprobado_por: string }>('select estado, aprobado_por from cliente where tercero_id = $1', [c.id])).rows[0])
      .toEqual({ estado: 'activo', aprobado_por: gerente });
    expect((await db.query<{ estado: string }>('select estado from solicitud_aprobacion where id = $1', [rows[0].id])).rows[0].estado).toBe('aprobada');
    expect(await puedeDecidirObjeto(db, gerente, 'cliente', c.id)).toBe(false);
    await esperarError(como(otroGerente, (tx) => resolverAprobacion(tx, 'cliente', c.id, otroGerente, 'aprobada', { datos })), 'No hay una solicitud');
  });

  it('quien solicita no aprueba su propia solicitud, aunque tenga el rol (segregación de funciones)', async () => {
    const compradorGerente = await usuarioDePrueba(db, 'gc@prueba.test', ['gerencia', 'compras']);
    const sens: DatosSensibles = {
      razonSocial: 'Proveedor Uno', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null,
    };
    const p = await db.transaction((tx) => crearProveedor(tx, compradorGerente, { rif: 'G-20000303-0', sensibles: sens, contacto: {} }));
    expect(await puedeDecidirObjeto(db, compradorGerente, 'proveedor', p.id)).toBe(false);
    await esperarError(como(compradorGerente, (tx) => resolverAprobacion(tx, 'proveedor', p.id, compradorGerente, 'aprobada')), 'Quien solicita');
    await esperarError(como(compradorGerente, (tx) => decidirAprobacion(tx, { tipo: 'proveedor', objetoId: p.id, usuarioId: compradorGerente, decision: 'aprobada' }, espia().m)),
      'Quien solicita no aprueba');
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    await como(gerente, (tx) => resolverAprobacion(tx, 'proveedor', p.id, gerente, 'aprobada', { datos: { condicionPagoId: contado } }));
    expect((await db.query<{ estado: string }>('select estado from proveedor where tercero_id = $1', [p.id])).rows[0].estado).toBe('activo');

    // Cambio de datos sensibles: se puede aprobar o rechazar (con motivo) a través del motor.
    const c1 = await db.transaction((tx) => solicitarCambio(tx, p.id, compras, { ...sens, razonSocial: 'Proveedor Uno Renombrado' }));
    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'proveedor_cambio', c1, gerente, 'rechazada', { comentario: ' ' })), 'motivo del rechazo');
    await como(gerente, (tx) => resolverAprobacion(tx, 'proveedor_cambio', c1, gerente, 'rechazada', { comentario: 'No corresponde' }));
    expect((await db.query<{ estado: string }>('select estado from proveedor_cambio where id = $1', [c1])).rows[0].estado).toBe('rechazado');
    const c2 = await db.transaction((tx) => solicitarCambio(tx, p.id, compras, { ...sens, razonSocial: 'Proveedor Uno Renombrado' }));
    await como(gerente, (tx) => resolverAprobacion(tx, 'proveedor_cambio', c2, gerente, 'aprobada'));
    expect((await db.query<{ razon_social: string }>('select razon_social from tercero where id = $1', [p.id])).rows[0].razon_social).toBe('Proveedor Uno Renombrado');
  });

  it('lotes de metas: aprobar o rechazar (con motivo) pasa por el motor y el lote queda resuelto', async () => {
    const vend = (await db.query<{ codigo: string }>(`insert into vendedor (nombre, tipo) values ('Pedro', 'interno') returning codigo`)).rows[0].codigo;
    const l = await db.transaction((tx) => crearLoteMetas(tx, supervisor, 'manual', [{ fila: 1, tipo: 'vendedor', referencia: vend, anio: 2026, mes: null, monto: 100 }]));
    await esperarError(como(compras, (tx) => resolverAprobacion(tx, 'meta_lote', l.id, compras, 'aprobada')), 'No puede decidir');
    await esperarError(como(supervisor, (tx) => resolverAprobacion(tx, 'meta_lote', l.id, supervisor, 'aprobada')), 'Quien solicita');
    await como(gerente, (tx) => resolverAprobacion(tx, 'meta_lote', l.id, gerente, 'aprobada'));
    expect((await db.query<{ estado: string }>('select estado from meta_lote where id = $1', [l.id])).rows[0].estado).toBe('aprobado');
    const l2 = await db.transaction((tx) => crearLoteMetas(tx, supervisor, 'manual', [{ fila: 1, tipo: 'vendedor', referencia: vend, anio: 2027, mes: null, monto: 100 }]));
    await como(gerente, (tx) => resolverAprobacion(tx, 'meta_lote', l2.id, gerente, 'rechazada', { comentario: 'Fuera de rango' }));
    expect((await db.query<{ estado: string; motivo_rechazo: string }>('select estado, motivo_rechazo from meta_lote where id = $1', [l2.id])).rows[0])
      .toEqual({ estado: 'rechazado', motivo_rechazo: 'Fuera de rango' });
  });

  it('asientos manuales: el borrador abre su solicitud, el jefe la aprueba con la huella y contabiliza; eliminar el borrador la cancela', async () => {
    await db.query('select fn_crear_periodos(2026)');
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ('2026-04-01', 'USD', 36.123457)`);
    const gasto = await cuenta(db, '6.2.02');
    const caja = await cuenta(db, '1.1.01.01');
    const datos = { fecha: '2026-04-06', descripcion: 'Provisión', moneda: 'VES', lineas: [{ cuentaId: gasto, debe: '400.00', haber: '' }, { cuentaId: caja, debe: '', haber: '400.00' }] };
    const id = await db.transaction((tx) => guardarBorrador(tx, contador, datos));
    expect(await puedeDecidirObjeto(db, jefe, 'asiento_manual', id)).toBe(true);
    expect(await puedeDecidirObjeto(db, contador, 'asiento_manual', id)).toBe(false);

    const huella = await huellaAsiento(db, id);
    await esperarError(como(jefe, (tx) => resolverAprobacion(tx, 'asiento_manual', id, jefe, 'aprobada', { datos: { huella: 'otra' } })), 'cambió');
    const r = await como(jefe, (tx) => resolverAprobacion(tx, 'asiento_manual', id, jefe, 'aprobada', { datos: { huella } }));
    expect(r.estado).toBe('aprobada');
    expect(String(r.resultado)).toMatch(/^\d+$/);
    expect((await db.query<{ estado: string }>('select estado from asiento where id = $1', [id])).rows[0].estado).toBe('contabilizado');

    const borrador = await db.transaction((tx) => guardarBorrador(tx, contador, datos));
    await db.transaction((tx) => eliminarBorrador(tx, borrador, contador));
    expect((await db.query<{ estado: string }>(`select estado from solicitud_aprobacion where objeto_tipo = 'asiento_manual' and objeto_id = $1`, [borrador])).rows[0].estado).toBe('cancelada');
  });

  it('varios pasos: el paso condicional solo aplica sobre el umbral y nadie decide dos pasos', async () => {
    await flujoDePrueba('orden_prueba', [
      { rol: 'gerencia' },
      { rol: 'jefe_contabilidad', campo: 'monto_usd', op: '>', valor: '5000' },
    ]);
    const { llamadas, m } = espia();

    const chica = randomUUID();
    const s1 = await sol('orden_prueba', chica, compras, { monto_usd: 1000 });
    expect((await db.query<{ n: number }>('select jsonb_array_length(pasos) as n from solicitud_aprobacion where id = $1', [s1])).rows[0].n).toBe(1);
    const r1 = await decidir(m, 'orden_prueba', chica, gerente);
    expect(r1).toMatchObject({ estado: 'aprobada', resultado: 'hecho' });

    const grande = randomUUID();
    const s2 = await sol('orden_prueba', grande, compras, { monto_usd: 9000 });
    expect((await db.query<{ n: number }>('select jsonb_array_length(pasos) as n from solicitud_aprobacion where id = $1', [s2])).rows[0].n).toBe(2);
    const doble = await usuarioDePrueba(db, 'doble@prueba.test', ['gerencia', 'jefe_contabilidad']);
    await esperarError(decidir(m, 'orden_prueba', grande, jefe), 'No puede decidir');           // el paso 2 aún no le toca
    const r2 = await decidir(m, 'orden_prueba', grande, doble);                                    // paso 1
    expect(r2).toMatchObject({ estado: 'pendiente', paso: 2 });
    expect(llamadas.filter((l) => l.objeto === grande)).toHaveLength(0);                          // el módulo no actúa hasta el último paso
    await esperarError(decidir(m, 'orden_prueba', grande, doble), 'No puede decidir');           // no decide dos pasos
    const r3 = await decidir(m, 'orden_prueba', grande, jefe, 'aprobada', { datos: { nota: 'ok' } });
    expect(r3).toMatchObject({ estado: 'aprobada' });
    expect(llamadas.find((l) => l.objeto === grande)).toMatchObject({ accion: 'aprobar', usuario: jefe, datos: { nota: 'ok' } });
    expect(await estadoDe(s2)).toMatchObject({ estado: 'aprobada', paso_actual: 2 });
  });

  it('si el dato de la condición no viene, el paso aplica (ante la duda se exige la aprobación)', async () => {
    const obj = randomUUID();
    const s = await sol('orden_prueba', obj, compras, {});
    expect((await db.query<{ n: number }>('select jsonb_array_length(pasos) as n from solicitud_aprobacion where id = $1', [s])).rows[0].n).toBe(2);
  });

  it('un rechazo cierra la solicitud, exige comentario y avisa al módulo', async () => {
    const { llamadas, m } = espia();
    const obj = randomUUID();
    const s = await sol('orden_prueba', obj, compras, { monto_usd: 10 });
    await esperarError(decidir(m, 'orden_prueba', obj, gerente, 'rechazada', { comentario: 'x' }), 'motivo del rechazo');
    await decidir(m, 'orden_prueba', obj, gerente, 'rechazada', { comentario: 'Presupuesto agotado' });
    expect(await estadoDe(s)).toMatchObject({ estado: 'rechazada' });
    expect(llamadas).toEqual([{ accion: 'rechazar', objeto: obj, usuario: gerente }]);
    await esperarError(decidir(m, 'orden_prueba', obj, otroGerente), 'No hay una solicitud');
  });

  it('si el módulo falla al aprobar, la decisión se revierte con su transacción', async () => {
    const obj = randomUUID();
    const s = await sol('orden_prueba', obj, compras, { monto_usd: 10 });
    const roto: Manejador<void> = { alAprobar: async () => { throw new Error('el módulo falló'); } };
    await esperarError(decidir(roto, 'orden_prueba', obj, gerente), 'el módulo falló');
    expect(await estadoDe(s)).toMatchObject({ estado: 'pendiente', paso_actual: 1 });
    expect((await db.query<{ n: number }>('select count(*)::int as n from aprobacion_decision where solicitud_id = $1', [s])).rows[0].n).toBe(0);
  });

  it('escalamiento: pasado el plazo, el rol de escalamiento también puede decidir', async () => {
    await flujoDePrueba('escalable', [{ rol: 'gerencia', horas: 4, escalar: 'supervisor_ventas' }]);
    const { m } = espia();
    const obj = randomUUID();
    const s = await sol('escalable', obj, compras);
    expect(await puedeDecidirObjeto(db, supervisor, 'escalable', obj)).toBe(false);
    await esperarError(decidir(m, 'escalable', obj, supervisor), 'No puede decidir');
    expect((await pendientesDe(db, supervisor)).some((p) => p.objeto_id === obj)).toBe(false);

    // Se adelanta el reloj del paso 5 horas (solo el motor lo mueve: aquí se simula con su señal interna).
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.flujo_interno', 'on', true)");
      await tx.query(`update solicitud_aprobacion set paso_desde = now() - interval '5 hours' where id = $1`, [s]);
    });
    expect(await puedeDecidirObjeto(db, supervisor, 'escalable', obj)).toBe(true);
    expect((await pendientesDe(db, supervisor)).find((p) => p.objeto_id === obj)?.escalada).toBe(true);
    expect(await decidir(m, 'escalable', obj, supervisor)).toMatchObject({ estado: 'aprobada' });
  });

  it('delegación: un sustituto vigente decide en nombre de quien tiene el rol, y queda registrado', async () => {
    await flujoDePrueba('delegable', [{ rol: 'gerencia' }]);
    const { llamadas, m } = espia();
    const obj = randomUUID();
    await sol('delegable', obj, compras);
    const sustituto = await usuarioDePrueba(db, 'sustituto@prueba.test', ['compras', 'facturacion']);
    expect(await puedeDecidirObjeto(db, sustituto, 'delegable', obj)).toBe(false);

    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
    const ayer = new Date(Date.now() - 86_400_000 * 3).toISOString().slice(0, 10);
    const antes = new Date(Date.now() - 86_400_000 * 2).toISOString().slice(0, 10);
    const manana = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);

    await esperarError(db.transaction((tx) => crearDelegacion(tx, gerente, gerente, hoy, hoy)), 'sí mismo');
    await esperarError(db.transaction((tx) => crearDelegacion(tx, gerente, sustituto, manana, hoy)), 'anterior');
    await db.transaction((tx) => crearDelegacion(tx, gerente, sustituto, ayer, antes));            // ya venció
    expect(await puedeDecidirObjeto(db, sustituto, 'delegable', obj)).toBe(false);

    await db.transaction((tx) => crearDelegacion(tx, gerente, sustituto, hoy, manana));
    expect(await puedeDecidirObjeto(db, sustituto, 'delegable', obj)).toBe(true);
    expect((await pendientesDe(db, sustituto)).some((p) => p.objeto_id === obj)).toBe(true);
    await decidir(m, 'delegable', obj, sustituto);
    // El módulo dueño recibe como responsable a quien delegó; la decisión conserva a quien decidió.
    expect(llamadas[0]).toMatchObject({ accion: 'aprobar', usuario: gerente });
    const [d] = await historialDecisiones(db, sustituto, 5);
    expect(d).toMatchObject({ decidio: 'Usuario de prueba', en_nombre_de: 'Usuario de prueba', decision: 'aprobada' });
    const { rows } = await db.query<{ usuario_id: string; en_nombre_de: string }>('select usuario_id, en_nombre_de from aprobacion_decision order by id desc limit 1');
    expect(rows[0]).toEqual({ usuario_id: sustituto, en_nombre_de: gerente });

    // Quien solicitó no puede aprobar por delegación de alguien más ni siendo sustituto de sí mismo.
    const obj2 = randomUUID();
    await sol('delegable', obj2, gerente);                       // solicita el mismo gerente que delegó
    expect(await puedeDecidirObjeto(db, sustituto, 'delegable', obj2)).toBe(false);

    const [g] = await delegacionesDe(db, gerente);
    await db.transaction((tx) => quitarDelegacion(tx, gerente, g.id));
    await esperarError(db.transaction((tx) => quitarDelegacion(tx, otroGerente, g.id)), 'no existe');
  });

  it('la solicitud solo avanza por decisiones: no se aprueba, borra ni edita por fuera del motor (R-AD)', async () => {
    const obj = randomUUID();
    const s = await sol('orden_prueba', obj, compras, { monto_usd: 1 });
    await esperarError(db.query(`update solicitud_aprobacion set estado = 'aprobada', resuelta_at = now() where id = $1`, [s]), 'registrando una decisión');
    await esperarError(db.query(`update solicitud_aprobacion set paso_actual = 2 where id = $1`, [s]), 'registrando una decisión');
    await esperarError(db.query(`update solicitud_aprobacion set solicitante_id = $2 where id = $1`, [s, gerente]), 'no se edita');
    await esperarError(db.query('delete from solicitud_aprobacion where id = $1', [s]), 'no se borra');
    await esperarError(
      db.query(`insert into aprobacion_decision (solicitud_id, paso, usuario_id, decision) values ($1, 1, $2, 'aprobada')`, [s, facturacion]), 'No puede decidir');
    await esperarError(
      db.query(`insert into aprobacion_decision (solicitud_id, paso, usuario_id, decision) values ($1, 2, $2, 'aprobada')`, [s, gerente]), 'paso actual');
    await decidir(espia().m, 'orden_prueba', obj, gerente);
    await esperarError(db.query(`update aprobacion_decision set decision = 'rechazada' where solicitud_id = $1`, [s]), 'no se modifica');
    await esperarError(db.query('delete from aprobacion_decision where solicitud_id = $1', [s]), 'no se modifica');
    await esperarError(db.query(`update solicitud_aprobacion set estado = 'cancelada' where id = $1`, [s]), 'ya resuelta');
    await esperarError(
      db.query(`insert into aprobacion_decision (solicitud_id, paso, usuario_id, decision) values ($1, 1, $2, 'aprobada')`, [s, otroGerente]), 'ya fue resuelta');
  });

  it('solicitar es idempotente y cancelar deja la solicitud cerrada', async () => {
    const obj = randomUUID();
    const a = await sol('orden_prueba', obj, compras, { monto_usd: 1 });
    expect(await sol('orden_prueba', obj, compras, { monto_usd: 1 })).toBe(a);
    await db.transaction((tx) => cancelarSolicitud(tx, 'orden_prueba', obj));
    expect(await estadoDe(a)).toMatchObject({ estado: 'cancelada' });
    expect(await sol('orden_prueba', obj, compras, { monto_usd: 1 })).not.toBe(a);     // se puede volver a solicitar
    await esperarError(sol('no_existe', obj, compras), 'No hay un flujo');
  });

  it('cambiar la definición no altera las solicitudes en curso, pero sí las nuevas (R-AC)', async () => {
    const obj = randomUUID();
    const s = await sol('orden_prueba', obj, compras, { monto_usd: 9000 });
    const def = (await listarDefiniciones(db)).find((d) => d.objeto_tipo === 'orden_prueba')!;
    await db.transaction((tx) => agregarPaso(tx, def.id, { rol: 'tesoreria', distintoDelCreador: true }));
    expect((await db.query<{ n: number }>('select jsonb_array_length(pasos) as n from solicitud_aprobacion where id = $1', [s])).rows[0].n).toBe(2);
    const nueva = randomUUID();
    const s2 = await sol('orden_prueba', nueva, compras, { monto_usd: 9000 });
    expect((await db.query<{ n: number }>('select jsonb_array_length(pasos) as n from solicitud_aprobacion where id = $1', [s2])).rows[0].n).toBe(3);
  });

  it('un flujo conserva un paso sin condición y no se borra; inactivo no admite solicitudes (R-AE)', async () => {
    const def = (await listarDefiniciones(db)).find((d) => d.objeto_tipo === 'cliente')!;
    await esperarError(db.transaction((tx) => quitarPaso(tx, def.pasos[0].id)), 'al menos un paso sin condición');
    await esperarError(db.query(`update flujo_paso set condicion_campo = 'monto_usd', condicion_operador = '>', condicion_valor = 1 where id = $1`, [def.pasos[0].id]), 'al menos un paso sin condición');
    await esperarError(db.query('delete from flujo_definicion where id = $1', [def.id]), 'se inactiva');
    // Con otro paso incondicional sí se puede quitar el primero.
    await db.transaction((tx) => agregarPaso(tx, def.id, { rol: 'jefe_contabilidad', distintoDelCreador: true }));
    await db.transaction((tx) => quitarPaso(tx, def.pasos[0].id));
    // Se restaura la configuración inicial del cliente para no afectar otras pruebas.
    await db.transaction((tx) => agregarPaso(tx, def.id, { rol: 'gerencia', distintoDelCreador: true }));
    const actual = (await listarDefiniciones(db)).find((d) => d.objeto_tipo === 'cliente')!;
    await db.transaction((tx) => quitarPaso(tx, actual.pasos.find((p) => p.rol_aprobador === 'jefe_contabilidad')!.id));

    const obj = randomUUID();
    await db.transaction((tx) => cambiarActivoFlujo(tx, actual.id, false));
    await esperarError(sol('cliente', obj, compras), 'inactivo');
    await db.transaction((tx) => cambiarActivoFlujo(tx, actual.id, true));
  });

  it('valida los pasos que se agregan: rol, condición, umbral y escalamiento', async () => {
    const def = (await listarDefiniciones(db)).find((d) => d.objeto_tipo === 'escalable')!;
    const paso = (extra: object) => db.transaction((tx) => agregarPaso(tx, def.id, { rol: 'gerencia', distintoDelCreador: true, ...extra }));
    await esperarError(paso({ rol: '' }), 'Seleccione el rol');
    await esperarError(paso({ condicionCampo: 'Monto USD', condicionOperador: '>', condicionValor: '5' }), 'minúsculas');
    await esperarError(paso({ condicionCampo: 'monto_usd', condicionOperador: '', condicionValor: '5' }), 'operador');
    await esperarError(paso({ condicionCampo: 'monto_usd', condicionOperador: '>', condicionValor: '-5' }), 'umbral');
    await esperarError(paso({ horasParaEscalar: '0', escalarARol: 'supervisor_ventas' }), 'horas');
    await esperarError(paso({ horasParaEscalar: '5' }), 'rol al que se escala');
    await esperarError(paso({ horasParaEscalar: '5', escalarARol: 'gerencia' }), 'distinto');
    await paso({ condicionCampo: 'monto_usd', condicionOperador: '>=', condicionValor: '1000.50' });
  });

  it('todo el recorrido queda en la auditoría', async () => {
    const { rows } = await db.query<{ entidad: string; n: number }>(
      `select entidad, count(*)::int as n from audit_log where entidad in ('solicitud_aprobacion', 'aprobacion_decision', 'flujo_paso', 'delegacion_aprobacion') group by entidad`);
    const n = Object.fromEntries(rows.map((r) => [r.entidad, r.n]));
    expect(n.solicitud_aprobacion).toBeGreaterThan(10);
    expect(n.aprobacion_decision).toBeGreaterThanOrEqual(8);
    expect(n.flujo_paso).toBeGreaterThan(5);
    expect(n.delegacion_aprobacion).toBeGreaterThan(1);
  });
});
