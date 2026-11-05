import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlApertura, fijarFechaArranque } from '@/lib/apertura/apertura';
import {
  buscarConteos, crearConteo, detalleConteo, eliminarConteo, enviarConteo, fijarCostos, guardarLineaConteo, quitarLineaConteo, type UsuarioConteo,
} from '@/lib/apertura/inventario';
import type { Db } from '@/lib/db/tipos';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Conteo físico inicial de inventario (spec §14.3; migración 0049). Arranque hoy; USD a Bs 40.
 */
describe('apertura: conteo físico inicial de inventario (R-DK a R-DM)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacenista: UsuarioConteo;
  let otroAlmacenista: UsuarioConteo;
  let contador: UsuarioConteo;
  let gerente: UsuarioConteo;
  let otroGerente: UsuarioConteo;
  let a01 = '';
  let a02 = '';
  let hoy = '';
  let pastilla = '';
  let aceite = '';
  let servicio = '';

  const como = <T,>(u: UsuarioConteo, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const aprobar = (id: string, u = otroGerente) => como(u, (tx) => resolverAprobacion(tx, 'apertura_inventario', id, u.id, 'aprobada'));
  const linea = (id: string, producto: string, cantidad: string, u = almacenista) => como(u, (tx) => guardarLineaConteo(tx, u, id, { productoId: producto, cantidad }));
  const costos = async (id: string, valores: Record<string, string>, u = contador) => {
    const d = (await detalleConteo(db, id))!;
    const porCodigo = Object.fromEntries(d.detalle.map((l) => [l.codigo, l.id]));
    return como(u, (tx) => fijarCostos(tx, u, id, Object.fromEntries(Object.entries(valores).map(([c, v]) => [porCodigo[c], v]))));
  };
  const estado = async (id: string) => (await detalleConteo(db, id))!.estado;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const ids = {
      alm: await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']),
      alm2: await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']),
      con: await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']),
      ger: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']),
      ger2: await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']),
    };
    almacenista = { id: ids.alm, roles: ['almacen'] };
    otroAlmacenista = { id: ids.alm2, roles: ['almacen'] };
    contador = { id: ids.con, roles: ['contabilidad'] };
    gerente = { id: ids.ger, roles: ['gerencia'] };
    otroGerente = { id: ids.ger2, roles: ['gerencia'] };
    hoy = (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1::date, 'USD', 40)`, [hoy]);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    a02 = await db.transaction((tx) => crearAlmacen(tx, '02', { nombre: 'Otro', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction(async (tx) => { await asignarUsuarios(tx, a01, [ids.alm]); await asignarUsuarios(tx, a02, [ids.alm2]); });
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const crear = async (codigo: string, inventariable = true) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, ids.alm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable,
      }));
    };
    pastilla = await crear('PF-001');
    aceite = await crear('AC-001');
    servicio = await crear('SV-001', false);
  });
  afterAll(() => cerrar());

  it('sin fecha de arranque no hay conteo inicial', async () => {
    await esperarError(como(almacenista, (tx) => crearConteo(tx, almacenista, { almacenId: a01 })), 'fecha de arranque');
    await como(gerente, (tx) => fijarFechaArranque(tx, gerente, hoy));
  });

  let c1 = '';

  it('Almacén registra el conteo de sus almacenes: productos inventariables y una sola cantidad por producto', async () => {
    await esperarError(como(contador, (tx) => crearConteo(tx, contador, { almacenId: a01 })), 'Solo Almacén o Gerencia');
    await esperarError(como(almacenista, (tx) => crearConteo(tx, almacenista, { almacenId: a02 })), 'no está entre los suyos');
    const r = await como(almacenista, (tx) => crearConteo(tx, almacenista, { almacenId: a01, observaciones: 'Toma física del día anterior' }));
    c1 = r.id;
    await esperarError(como(almacenista, (tx) => crearConteo(tx, almacenista, { almacenId: a01 })), 'duplicate');
    await esperarError(linea(c1, servicio, '3'), 'inventariables');
    await esperarError(linea(c1, pastilla, '0'), 'mayor que cero');
    await linea(c1, pastilla, '40');
    await linea(c1, pastilla, '50');                                       // cambia la cantidad del mismo producto
    await linea(c1, aceite, '20.5');
    const d = (await detalleConteo(db, c1))!;
    expect(d.detalle.map((l) => [l.codigo, Number(l.cantidad), l.costo])).toEqual([['PF-001', 50, null], ['AC-001', 20.5, null]]);
    await esperarError(linea(c1, aceite, '1', otroAlmacenista), 'no está entre los suyos');
  });

  it('el costo lo fija Contabilidad: Almacén no puede, ni siquiera directo en la base', async () => {
    await esperarError(costos(c1, { 'PF-001': '2' }, almacenista as UsuarioConteo), 'Solo Contabilidad o Gerencia');
    const l = (await detalleConteo(db, c1))!.detalle[0].id;
    await esperarError(como(almacenista, (tx) => tx.query('update apertura_inventario_linea set costo_unitario_usd = 1 where id = $1', [l])), 'Solo Contabilidad o Gerencia fijan');
    await esperarError(costos(c1, { 'PF-001': 'abc' }), 'no es válido');
  });

  it('no se envía sin el costo de todas las líneas, y la base lo exige', async () => {
    await costos(c1, { 'PF-001': '2.0000' });
    await esperarError(como(almacenista, (tx) => enviarConteo(tx, almacenista, c1)), 'debe fijar el costo');
    expect(await estado(c1)).toBe('borrador');
  });

  it('con los costos completos se envía, queda pendiente y no mueve nada', async () => {
    await costos(c1, { 'AC-001': '3.0000' });
    expect((await detalleConteo(db, c1))!.costos_por).toBe('Usuario de prueba');
    await como(almacenista, (tx) => enviarConteo(tx, almacenista, c1));
    expect(await estado(c1)).toBe('pendiente');
    expect((await db.query('select 1 from movimiento_inventario where origen_tipo = \'apertura_inventario\'')).rows).toHaveLength(0);
    await esperarError(linea(c1, pastilla, '1'), 'Solo se edita un conteo en borrador');
    await esperarError(costos(c1, { 'PF-001': '5' }), 'Solo se edita un conteo en borrador');
    const c = await controlApertura(db);
    expect(c.impedimentos.join(' ')).toContain('sin aprobar');
  });

  it('quien registró el conteo no lo aprueba; otra persona de Gerencia sí', async () => {
    await esperarError(aprobar(c1, { id: almacenista.id, roles: ['gerencia'] }), 'no aprueba su propia solicitud');
    await aprobar(c1);
    expect(await estado(c1)).toBe('aprobado');
  });

  it('al aprobar entran las existencias al costo fijado, con la fecha de arranque, y se asienta contra Saldos de apertura', async () => {
    const movs = (await db.query<{ tipo: string; codigo: string; cantidad: string; costo_total_usd: string; fecha: string }>(
      `select m.tipo, p.codigo, m.cantidad::text, m.costo_total_usd::text, (m.fecha at time zone 'America/Caracas')::date::text as fecha
         from movimiento_inventario m join producto p on p.id = m.producto_id where m.origen_tipo = 'apertura_inventario' and m.origen_id = $1 order by p.codigo`, [c1])).rows;
    expect(movs).toEqual([
      { tipo: 'apertura', codigo: 'AC-001', cantidad: '20.5000', costo_total_usd: '61.50', fecha: hoy },
      { tipo: 'apertura', codigo: 'PF-001', cantidad: '50.0000', costo_total_usd: '100.00', fecha: hoy },
    ]);
    const ex = (await db.query<{ c: string }>('select cantidad::text as c from existencia where producto_id = $1 and almacen_id = $2', [pastilla, a01])).rows[0].c;
    expect(Number(ex)).toBe(50);
    expect((await db.query<{ c: string }>('select costo_promedio_usd::text as c from producto_costo where producto_id = $1', [aceite])).rows[0].c).toBe('3.0000');
    const lineas = (await db.query<{ codigo: string; debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string }>(
      `select c.codigo, l.debe_ves::text, l.haber_ves::text, l.debe_usd::text, l.haber_usd::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = 'apertura_inventario' and a.origen_id = $1 and a.tipo = 'automatico' order by l.id`, [c1])).rows;
    expect(lineas).toEqual([
      { codigo: '1.3.01', debe_ves: '6460.00', haber_ves: '0.00', debe_usd: '161.50', haber_usd: '0.00' },
      { codigo: '3.9.01', debe_ves: '0.00', haber_ves: '6460.00', debe_usd: '0.00', haber_usd: '161.50' },
    ]);
    // El auxiliar de inventario (valor al costo promedio) es igual al mayor de la cuenta 1.3.01.
    const cuadre = (await db.query<{ aux: string; mayor: string }>(
      `select (select sum(valor_usd) from producto_costo)::text as aux,
              (select sum(l.debe_usd - l.haber_usd) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '1.3.01')::text as mayor`)).rows[0];
    expect(Number(cuadre.aux)).toBe(Number(cuadre.mayor));
    expect(await controlApertura(db).then((x) => x.totales.find((t) => t.tipo === 'inventario'))).toMatchObject({ documentos: 1, usd: '161.50' });
  });

  it('un conteo aprobado no se modifica ni se borra, y no se repite el del almacén', async () => {
    await esperarError(db.query(`update apertura_inventario set estado = 'borrador' where id = $1`, [c1]), 'Cambio de estado no permitido');
    await esperarError(como(almacenista, (tx) => quitarLineaConteo(tx, almacenista, c1, (c1 as string))), 'Solo se edita un conteo en borrador');
    await esperarError(como(almacenista, (tx) => eliminarConteo(tx, almacenista, c1)), 'Solo se edita un conteo en borrador');
    await esperarError(como(almacenista, (tx) => crearConteo(tx, almacenista, { almacenId: a01 })), 'duplicate');
    await esperarError(db.query('delete from apertura_inventario where id = $1', [c1]), 'no se borra');
    await esperarError(db.query('update apertura_inventario_linea set cantidad = 1 where apertura_id = $1', [c1]), 'no se modifican');
  });

  describe('segundo almacén: costos fijados por Gerencia y rechazo', () => {
    let c2 = '';

    it('quien fijó los costos no aprueba, aunque sea Gerencia', async () => {
      const r = await como(otroAlmacenista, (tx) => crearConteo(tx, otroAlmacenista, { almacenId: a02 }));
      c2 = r.id;
      await linea(c2, aceite, '10', otroAlmacenista);
      await costos(c2, { 'AC-001': '3.5' }, gerente);                            // Gerencia fija el costo
      await como(otroAlmacenista, (tx) => enviarConteo(tx, otroAlmacenista, c2));
      await esperarError(aprobar(c2, gerente), 'fijó sus costos');
      expect(await estado(c2)).toBe('pendiente');
    });

    it('rechazado no mueve nada y se puede registrar otro conteo del almacén', async () => {
      await como(otroGerente, (tx) => resolverAprobacion(tx, 'apertura_inventario', c2, otroGerente.id, 'rechazada', { comentario: 'Falta contar la estantería 3' }));
      expect(await estado(c2)).toBe('rechazado');
      const otro = await como(otroAlmacenista, (tx) => crearConteo(tx, otroAlmacenista, { almacenId: a02 }));
      expect(otro.id).not.toBe(c2);
      const ex = (await db.query<{ c: string }>('select coalesce(sum(cantidad), 0)::text as c from existencia where producto_id = $1 and almacen_id = $2', [aceite, a02])).rows[0].c;
      expect(Number(ex)).toBe(0);
      await como(otroAlmacenista, (tx) => eliminarConteo(tx, otroAlmacenista, otro.id));
    });

    it('cada almacenista ve solo los conteos de sus almacenes', async () => {
      expect((await buscarConteos(db, almacenista)).every((c) => c.almacen_id === a01)).toBe(true);
      expect((await buscarConteos(db, gerente)).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('un conteo en borrador impide cerrar la apertura', async () => {
    const r = await como(otroAlmacenista, (tx) => crearConteo(tx, otroAlmacenista, { almacenId: a02 }));
    const c = await controlApertura(db);
    expect(c.puedeCerrar).toBe(false);
    expect(c.impedimentos.join(' ')).toContain('sin aprobar');
    await como(otroAlmacenista, (tx) => eliminarConteo(tx, otroAlmacenista, r.id));
  });
});
