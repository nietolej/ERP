import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import {
  buscarAjustes, crearAjuste, detalleAjuste, eliminarBorrador, enviarAjuste, guardarLinea, listarExistencias, quitarLinea, type Usuario,
} from '@/lib/inventario/ajustes';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('ajuste de inventario con aprobación (§4.3, §8.3, R-AT a R-AX)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacenista: Usuario;
  let otroAlmacenista: Usuario;
  let contador: Usuario;
  let gerente: Usuario;
  let otroGerente: Usuario;
  let a01: string;
  let a02: string;
  let pastilla: string;
  let aceite: string;
  let nuevo: string;
  let servicio: string;
  let dano: string;
  let errorConteo: string;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const stock = (prod: string, almacen: string, cantidad: string, costo: string) => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ('entrada_compra', $1, $2, $3, $4, 'prueba', gen_random_uuid())`, [prod, almacen, cantidad, costo]));
  const existencia = async (prod: string, almacen = a01) =>
    (await db.query<{ cantidad: string; reservado: string }>(
      'select cantidad::text, reservado::text from existencia where producto_id = $1 and almacen_id = $2', [prod, almacen])).rows[0];
  const costoPromedio = async (prod: string) =>
    (await db.query<{ c: string }>('select costo_promedio_usd::text as c from producto_costo where producto_id = $1', [prod])).rows[0]?.c;
  const lineas = (id: string) => detalleAjuste(db, id).then((d) => d!.lineas);
  const nuevoAjuste = (u = almacenista, almacen = a01, contado?: string) => como(u, (tx) => crearAjuste(tx, u, { almacenId: almacen, contadoPorId: contado }));
  const contar = (u: Usuario, id: string, prod: string, contada: string, motivoId?: string, costoUnitario?: string) =>
    como(u, (tx) => guardarLinea(tx, u, id, { productoId: prod, cantidadContada: contada, motivoId, costoUnitario }));
  const asiento = async (evento: string, id: string) =>
    (await db.query<{ codigo: string; debe_usd: string; haber_usd: string; debe_ves: string; haber_ves: string }>(
      `select c.codigo, l.debe_usd::text, l.haber_usd::text, l.debe_ves::text, l.haber_ves::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = $1 and a.origen_id = $2 order by l.id`, [evento, id])).rows;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idAlm2 = await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']);
    const idCont = await usuarioDePrueba(db, 'contador@prueba.test', ['contabilidad']);
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idGer2 = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    almacenista = { id: idAlm, roles: ['almacen'] };
    otroAlmacenista = { id: idAlm2, roles: ['almacen'] };
    contador = { id: idCont, roles: ['contabilidad'] };
    gerente = { id: idGer, roles: ['gerencia'] };
    otroGerente = { id: idGer2, roles: ['gerencia'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    a02 = await db.transaction((tx) => crearAlmacen(tx, '02', { nombre: 'Otro', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction(async (tx) => {
      await asignarUsuarios(tx, a01, [idAlm]);
      await asignarUsuarios(tx, a02, [idAlm2]);
    });

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const crear = async (codigo: string, inventariable = true) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable,
      }));
    };
    pastilla = await crear('PF-001');
    aceite = await crear('AC-001');
    nuevo = await crear('NU-001');
    servicio = await crear('SERV-001', false);
    dano = (await db.query<{ id: string }>(`select id from motivo where tipo = 'merma' and codigo = 'DANO'`)).rows[0].id;
    errorConteo = (await db.query<{ id: string }>(`select id from motivo where tipo = 'merma' and codigo = 'ERROR_CONTEO'`)).rows[0].id;
    await stock(pastilla, a01, '50', '4.00');
    await stock(aceite, a01, '20', '6.50');
  });
  afterAll(() => cerrar());

  it('un ajuste con faltante y sobrante: se envía, Gerencia aprueba y se aplican los movimientos y el asiento', async () => {
    const id = await nuevoAjuste();
    await contar(almacenista, id, pastilla, '47', dano);       // faltan 3 → 3 × 4,00 = 12,00
    await contar(almacenista, id, aceite, '22', errorConteo);  // sobran 2 → 2 × 6,50 = 13,00
    const antes = await detalleAjuste(db, id);
    expect(antes!.estado).toBe('borrador');
    expect(antes!.numero).toBeNull();
    expect(antes!.lineas.map((l) => [l.codigo, l.sistema, l.contada, l.diferencia, l.motivo])).toEqual([
      ['PF-001', '50.0000', '47.0000', '-3.0000', 'Daño o rotura'],
      ['AC-001', '20.0000', '22.0000', '2.0000', 'Diferencia de conteo'],
    ]);
    expect(antes!.valor_usd).toBe('25.00');

    await como(almacenista, (tx) => enviarAjuste(tx, almacenista, id));
    const enviado = (await detalleAjuste(db, id))!;
    expect(enviado.estado).toBe('pendiente');
    expect(enviado.numero).toMatch(/^\d+$/);
    expect(await puedeDecidirObjeto(db, gerente.id, 'ajuste_inventario', id)).toBe(true);
    expect(await puedeDecidirObjeto(db, almacenista.id, 'ajuste_inventario', id)).toBe(false);
    // Sin aprobar no se mueve nada.
    expect(await existencia(pastilla)).toEqual({ cantidad: '50.0000', reservado: '0.0000' });

    await como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'aprobada'));
    expect((await detalleAjuste(db, id))!.estado).toBe('aprobado');
    expect((await existencia(pastilla)).cantidad).toBe('47.0000');
    expect((await existencia(aceite)).cantidad).toBe('22.0000');

    const { rows: movs } = await db.query<{ tipo: string; cantidad: string; costo_total_usd: string }>(
      `select tipo, cantidad::text, costo_total_usd::text from movimiento_inventario where origen_tipo = 'ajuste_inventario' and origen_id = $1 order by id`, [id]);
    expect(movs).toEqual([
      { tipo: 'ajuste_negativo', cantidad: '-3.0000', costo_total_usd: '-12.00' },
      { tipo: 'ajuste_positivo', cantidad: '2.0000', costo_total_usd: '13.00' },
    ]);
    // Faltante: Dr 5.1.02 / Cr 1.3.01. Sobrante: Dr 1.3.01 / Cr 5.1.02. A la tasa 40.
    expect(await asiento('ajuste_faltante', id)).toEqual([
      { codigo: '5.1.02', debe_usd: '12.00', haber_usd: '0.00', debe_ves: '480.00', haber_ves: '0.00' },
      { codigo: '1.3.01', debe_usd: '0.00', haber_usd: '12.00', debe_ves: '0.00', haber_ves: '480.00' },
    ]);
    expect(await asiento('ajuste_sobrante', id)).toEqual([
      { codigo: '1.3.01', debe_usd: '13.00', haber_usd: '0.00', debe_ves: '520.00', haber_ves: '0.00' },
      { codigo: '5.1.02', debe_usd: '0.00', haber_usd: '13.00', debe_ves: '0.00', haber_ves: '520.00' },
    ]);
  });

  it('un ajuste enviado no se edita ni se borra, y el borrador sí se puede cambiar y eliminar sin dejar huecos', async () => {
    const id = await nuevoAjuste();
    await contar(almacenista, id, pastilla, '40', dano);
    await contar(almacenista, id, pastilla, '45', dano);                   // reemplaza lo contado del mismo producto
    const [l] = await lineas(id);
    expect(l.contada).toBe('45.0000');
    await como(almacenista, (tx) => quitarLinea(tx, almacenista, id, l.id));
    expect(await lineas(id)).toEqual([]);
    await como(almacenista, (tx) => eliminarBorrador(tx, almacenista, id));

    const borrador = await nuevoAjuste();
    await como(almacenista, (tx) => eliminarBorrador(tx, almacenista, borrador));
    expect(await detalleAjuste(db, borrador)).toBeNull();

    const real = await nuevoAjuste();
    await contar(almacenista, real, pastilla, '46', dano);
    const antesNumero = (await db.query<{ siguiente: string }>(`select siguiente::text from numerador where tipo_documento = 'ajuste_inventario'`)).rows[0].siguiente;
    await como(almacenista, (tx) => enviarAjuste(tx, almacenista, real));
    const num = (await detalleAjuste(db, real))!.numero;
    expect(num).toBe(antesNumero);                                        // el borrador eliminado no consumió número
    await esperarError(contar(almacenista, real, aceite, '1', dano), 'borrador');
    await esperarError(como(almacenista, (tx) => eliminarBorrador(tx, almacenista, real)), 'borrador');
    await esperarError(db.query(`update ajuste_inventario set observaciones = 'x' where id = $1`, [real]), 'no se edita');
    await esperarError(db.query(`delete from ajuste_inventario where id = $1`, [real]), 'no se borra');
    await esperarError(db.query(`delete from ajuste_inventario_linea where ajuste_id = $1`, [real]), 'no se modifican');
    await como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', real, gerente.id, 'rechazada', { comentario: 'Se cuenta de nuevo' }));
    await esperarError(db.query(`update ajuste_inventario set estado = 'aprobado' where id = $1`, [real]), 'no se modifica');
  });

  it('valida el conteo, el motivo y el costo del sobrante', async () => {
    const id = await nuevoAjuste();
    await esperarError(contar(almacenista, id, pastilla, '-1', dano), 'cantidad contada');
    await esperarError(contar(almacenista, id, pastilla, 'x', dano), 'cantidad contada');
    await esperarError(contar(almacenista, id, pastilla, '40'), 'motivo de la diferencia');
    await esperarError(contar(almacenista, id, servicio, '1', dano), 'no maneja inventario');
    const devolucion = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;
    await esperarError(contar(almacenista, id, pastilla, '40', devolucion), 'no corresponde');
    // Sin diferencias no hay nada que aplicar.
    const existenteCont = (await existencia(pastilla)).cantidad;
    await contar(almacenista, id, pastilla, existenteCont);
    await esperarError(como(almacenista, (tx) => enviarAjuste(tx, almacenista, id)), 'no tiene diferencias');
    // Un producto sin costo exige el costo unitario del sobrante.
    await esperarError(contar(almacenista, id, nuevo, '5', dano), 'costo unitario');
    await esperarError(contar(almacenista, id, nuevo, '5', dano, '0'), 'costo unitario');
    await contar(almacenista, id, nuevo, '5', dano, '3.5');
    await como(almacenista, (tx) => enviarAjuste(tx, almacenista, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'aprobada'));
    expect(await existencia(nuevo)).toEqual({ cantidad: '5.0000', reservado: '0.0000' });
    expect(await costoPromedio(nuevo)).toBe('3.5000');
    expect(await asiento('ajuste_sobrante', id)).toEqual([
      expect.objectContaining({ codigo: '1.3.01', debe_usd: '17.50' }),
      expect.objectContaining({ codigo: '5.1.02', haber_usd: '17.50' }),
    ]);
  });

  it('quien creó el ajuste o hizo el conteo no lo aprueba; solo Gerencia lo decide (R-AT)', async () => {
    // El almacenista cuenta y otra persona de Gerencia lo crea; ni él ni quien lo creó pueden aprobarlo.
    const id = await nuevoAjuste(gerente, a01, almacenista.id);
    await contar(gerente, id, aceite, '21', dano);
    await como(gerente, (tx) => enviarAjuste(tx, gerente, id));
    expect(await puedeDecidirObjeto(db, gerente.id, 'ajuste_inventario', id)).toBe(false);   // lo creó
    expect(await puedeDecidirObjeto(db, otroGerente.id, 'ajuste_inventario', id)).toBe(true);
    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'aprobada')), 'no aprueba su propia');
    await esperarError(como(contador, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, contador.id, 'aprobada')), 'rol');
    await esperarError(como(almacenista, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, almacenista.id, 'aprobada')), 'rol');
    // Aunque alguien se salte el motor de flujo, la base rechaza a quien hizo el conteo.
    const quien = await usuarioDePrueba(db, 'gerente3@prueba.test', ['gerencia', 'almacen']);
    const id2 = await como(otroGerente, (tx) => crearAjuste(tx, { id: otroGerente.id, roles: ['gerencia'] }, { almacenId: a01, contadoPorId: quien }));
    await como(otroGerente, (tx) => guardarLinea(tx, { id: otroGerente.id, roles: ['gerencia'] }, id2, { productoId: aceite, cantidadContada: '20', motivoId: dano }));
    await como(otroGerente, (tx) => enviarAjuste(tx, { id: otroGerente.id, roles: ['gerencia'] }, id2));
    await esperarError(db.query(`update ajuste_inventario set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id2, quien]), 'hizo el conteo');
    await esperarError(db.query(`update ajuste_inventario set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id2, almacenista.id]), 'rol Gerencia');
    await como(otroGerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, otroGerente.id, 'aprobada'));
    expect((await detalleAjuste(db, id))!.estado).toBe('aprobado');
    await como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id2, gerente.id, 'aprobada'));
    expect((await detalleAjuste(db, id2))!.estado).toBe('aprobado');
  });

  it('el rechazo exige motivo y no mueve nada', async () => {
    const antes = await existencia(pastilla);
    const id = await nuevoAjuste();
    await contar(almacenista, id, pastilla, '1', dano);
    await como(almacenista, (tx) => enviarAjuste(tx, almacenista, id));
    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'rechazada')), 'motivo');
    await como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'rechazada', { comentario: 'Volver a contar' }));
    const d = (await detalleAjuste(db, id))!;
    expect([d.estado, d.rechazo_motivo]).toEqual(['rechazado', 'Volver a contar']);
    expect(await existencia(pastilla)).toEqual(antes);
    expect((await db.query('select 1 from asiento where origen_id = $1', [id])).rows).toHaveLength(0);
  });

  it('un faltante no puede dejar la existencia por debajo de lo reservado y revierte todo el ajuste', async () => {
    // Se reservan 10 aceites para un pedido ficticio directamente (reserva técnica de prueba).
    const e = await existencia(aceite);
    await db.query(`select set_config('app.inventario_interno', '1', false)`);
    await db.query(`update existencia set reservado = 10 where producto_id = $1 and almacen_id = $2`, [aceite, a01]);
    await db.query(`select set_config('app.inventario_interno', '', false)`);
    const id = await nuevoAjuste();
    await contar(almacenista, id, aceite, '5', dano);                      // quedaría en 5, con 10 reservados
    await contar(almacenista, id, pastilla, '30', dano);
    await como(almacenista, (tx) => enviarAjuste(tx, almacenista, id));
    const antesPastilla = await existencia(pastilla);
    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'aprobada')), 'por debajo de lo reservado');
    expect(await existencia(pastilla)).toEqual(antesPastilla);             // nada se aplicó
    expect((await detalleAjuste(db, id))!.estado).toBe('pendiente');
    await db.query(`select set_config('app.inventario_interno', '1', false)`);
    await db.query(`update existencia set reservado = 0 where producto_id = $1 and almacen_id = $2`, [aceite, a01]);
    await db.query(`select set_config('app.inventario_interno', '', false)`);
    expect(e.cantidad).toBeDefined();
  });

  it('la diferencia se aplica contra lo que decía el sistema al contar, sin perder movimientos intermedios', async () => {
    const base = Number((await existencia(pastilla)).cantidad);
    const id = await nuevoAjuste();
    await contar(almacenista, id, pastilla, String(base - 2), dano);       // se cuenta 2 menos que el sistema
    await stock(pastilla, a01, '10', '4.00');                              // llega mercancía antes de aprobar
    await como(almacenista, (tx) => enviarAjuste(tx, almacenista, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'ajuste_inventario', id, gerente.id, 'aprobada'));
    expect(Number((await existencia(pastilla)).cantidad)).toBe(base + 10 - 2);
  });

  it('seguridad por almacén: el almacenista solo crea y ve ajustes de sus almacenes', async () => {
    await esperarError(nuevoAjuste(almacenista, a02), 'no está entre los suyos');
    const id = await nuevoAjuste();
    await esperarError(contar(otroAlmacenista, id, pastilla, '1', dano), 'no está entre los suyos');
    expect((await buscarAjustes(db, almacenista, {})).map((f) => f.id)).toContain(id);
    expect((await buscarAjustes(db, otroAlmacenista, {})).map((f) => f.id)).not.toContain(id);
    expect((await buscarAjustes(db, gerente, {})).map((f) => f.id)).toContain(id);
    expect(await buscarAjustes(db, { id: gerente.id, roles: ['ventas'] }, {})).toEqual([]);
    await como(almacenista, (tx) => eliminarBorrador(tx, almacenista, id));
  });

  it('las existencias se consultan por almacén con su valor al costo promedio', async () => {
    const filas = await listarExistencias(db, almacenista, a01);
    const p = filas.find((f) => f.codigo === 'PF-001')!;
    expect(Number(p.valor_usd)).toBeCloseTo(Number(p.cantidad) * Number(p.costo_promedio), 1);
    expect(await listarExistencias(db, otroAlmacenista, a01)).toEqual([]);
    expect(await listarExistencias(db, { id: gerente.id, roles: ['tesoreria'] }, a01)).toEqual([]);
  });
});
