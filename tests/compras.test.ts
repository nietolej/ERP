import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repartirCosto, type LineaReparto } from '@/lib/compras/costo-destino';
import {
  anularOrden, buscarOrdenes, crearOrden, detalleOrden, enviarOrden, guardarLinea, quitarLinea, type Usuario,
} from '@/lib/compras/ordenes';
import { buscarRecepciones, recibirMercancia } from '@/lib/compras/recepciones';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase, type DatosProducto } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const linea = (id: string, cantidad: string, valor: string, peso: string | null = null, volumen: string | null = null): LineaReparto =>
  ({ id, codigo: id, cantidad, valor, pesoUnitarioKg: peso, volumenUnitarioM3: volumen });
const suma = (m: Map<string, string>) => [...m.values()].reduce((s, v) => s + Math.round(Number(v) * 100), 0) / 100;

describe('reparto de gastos de importación (§7.2 regla 3)', () => {
  it('por valor, peso, volumen y cantidad: proporcional y exacto a centavos', () => {
    const ls = [linea('A', '10', '100.00', '2', '0.001'), linea('B', '5', '300.00', '4', '0.004'), linea('C', '20', '100.00', '1', '0.0005')];
    expect([...repartirCosto(ls, '100.00', 'valor')]).toEqual([['A', '20.00'], ['B', '60.00'], ['C', '20.00']]);
    // pesos totales: A 20 kg, B 20 kg, C 20 kg → tercios; el centavo sobrante va a la primera línea
    expect([...repartirCosto(ls, '100.00', 'peso')]).toEqual([['A', '33.34'], ['B', '33.33'], ['C', '33.33']]);
    // volúmenes: A 0,01 · B 0,02 · C 0,01 m³
    expect([...repartirCosto(ls, '100.00', 'volumen')]).toEqual([['A', '25.00'], ['B', '50.00'], ['C', '25.00']]);
    // unidades: 10 / 5 / 20 de 35
    const q = repartirCosto(ls, '350.00', 'cantidad');
    expect([...q]).toEqual([['A', '100.00'], ['B', '50.00'], ['C', '200.00']]);
  });

  it('la suma de las partes es siempre el gasto, sin diferencias de redondeo', () => {
    const ls = Array.from({ length: 7 }, (_, i) => linea(`L${i}`, String(i + 3), String((i + 1) * 13.37)));
    for (const monto of ['0.01', '1.00', '99.99', '1234.57']) {
      for (const c of ['valor', 'cantidad'] as const) expect(suma(repartirCosto(ls, monto, c))).toBe(Number(monto));
    }
  });

  it('sin la medida que pide el criterio no hay reparto, y lo dice', () => {
    const ls = [linea('A', '1', '10', '2', null), linea('B', '1', '10', null, null)];
    expect(() => repartirCosto(ls, '10', 'peso')).toThrow(/peso por unidad.*B/);
    expect(() => repartirCosto(ls, '10', 'volumen')).toThrow(/medidas del empaque.*A, B/);
    expect(() => repartirCosto(ls, '0', 'valor')).toThrow(/mayor que cero/);
    expect(() => repartirCosto([], '10', 'valor')).toThrow(/líneas/);
  });
});

describe('orden de compra y recepción (§7, R-AY a R-BB)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let gerente: Usuario;
  let almacenista: Usuario;
  let otroAlmacenista: Usuario;
  let auditor: Usuario;
  let a01: string;
  let a02: string;
  let proveedor: string;
  let inactivo: string;
  let filtro: string;
  let pastilla: string;
  let sinMedidas: string;
  let servicio: string;

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const nuevaOrden = (extra: { moneda?: string; criterio?: string; almacen?: string; proveedorId?: string } = {}) =>
    como(comprador, (tx) => crearOrden(tx, comprador, {
      proveedorId: extra.proveedorId ?? proveedor, almacenId: extra.almacen ?? a01, moneda: extra.moneda ?? 'USD', criterioReparto: extra.criterio,
    }));
  const agregar = (id: string, prod: string, cantidad: string, precio: string) =>
    como(comprador, (tx) => guardarLinea(tx, id, { productoId: prod, cantidad, precio }));
  const aprobada = async (extra: Parameters<typeof nuevaOrden>[0] = {}, lineas: [string, string, string][] = [[pastilla, '100', '4.00']]) => {
    const id = await nuevaOrden(extra);
    for (const [p, c, pr] of lineas) await agregar(id, p, c, pr);
    await como(comprador, (tx) => enviarOrden(tx, comprador, id));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', id, gerente.id, 'aprobada'));
    return id;
  };
  const recibir = (u: Usuario, id: string, lineas: { lineaId: string; cantidad: string }[]) =>
    como(u, (tx) => recibirMercancia(tx, u, id, lineas));
  const lineasDe = async (id: string) => (await detalleOrden(db, id))!.lineas;
  const existencia = async (prod: string, almacen = a01) =>
    (await db.query<{ cantidad: string }>('select cantidad::text from existencia where producto_id = $1 and almacen_id = $2', [prod, almacen])).rows[0]?.cantidad;
  const costoPromedio = async (prod: string) =>
    (await db.query<{ c: string }>('select costo_promedio_usd::text as c from producto_costo where producto_id = $1', [prod])).rows[0]?.c;
  const asiento = async (origenTipo: string, id: string) =>
    (await db.query<{ codigo: string; debe_usd: string; haber_usd: string; debe_ves: string; haber_ves: string }>(
      `select c.codigo, l.debe_usd::text, l.haber_usd::text, l.debe_ves::text, l.haber_ves::text
         from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta_contable c on c.id = l.cuenta_id
        where a.origen_tipo = $1 and a.origen_id = $2 order by l.id`, [origenTipo, id])).rows;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idCom = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idAlm2 = await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']);
    const idAud = await usuarioDePrueba(db, 'auditor@prueba.test', ['auditor']);
    comprador = { id: idCom, roles: ['compras'] };
    gerente = { id: idGer, roles: ['gerencia'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    otroAlmacenista = { id: idAlm2, roles: ['almacen'] };
    auditor = { id: idAud, roles: ['auditor'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'EUR', 50.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    a02 = await db.transaction((tx) => crearAlmacen(tx, '02', { nombre: 'Otro', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction(async (tx) => {
      await asignarUsuarios(tx, a01, [idAlm]);
      await asignarUsuarios(tx, a02, [idAlm2]);
    });

    const condicion = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const nuevoProveedor = async (n: string, activar: boolean) => {
      const r = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
        rif: `J-${n}-${digitoVerificador('J', n)}`,
        sensibles: { razonSocial: `Proveedor ${n}`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'importacion', pais: 'CN', conceptoIslrId: null },
        contacto: { telefono: '0212-5550000' },
      }));
      if (activar) await db.transaction((tx) => aprobarProveedor(tx, r.id, gerente.id, condicion));
      return r.id;
    };
    proveedor = await nuevoProveedor('11111111', true);
    inactivo = await nuevoProveedor('22222222', false);

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const crear = async (codigo: string, extra: Partial<DatosProducto> = {}) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true, ...extra,
      }));
    };
    pastilla = await crear('PF-001', { pesoKg: '0.5', empaqueLargoCm: '10', empaqueAnchoCm: '10', empaqueAltoCm: '10', unidadesPorEmpaque: '1' });
    filtro = await crear('FI-001', { pesoKg: '0.2', empaqueLargoCm: '20', empaqueAnchoCm: '10', empaqueAltoCm: '5', unidadesPorEmpaque: '10' });
    sinMedidas = await crear('SM-001');
    servicio = await crear('SERV-001', { inventariable: false });
  });
  afterAll(() => cerrar());

  it('armar, enviar y aprobar: la base calcula el total, asigna el número y Gerencia (otra persona) aprueba', async () => {
    const id = await nuevaOrden({ moneda: 'EUR' });
    await agregar(id, pastilla, '100', '4.5000');
    await agregar(id, filtro, '40.5', '2.2500');
    await agregar(id, filtro, '40', '2.2500');                       // reemplaza la línea del mismo producto
    let d = (await detalleOrden(db, id))!;
    expect(d.estado).toBe('borrador');
    expect(d.numero).toBeNull();
    expect(d.lineas.map((l) => [l.codigo, l.cantidad, l.precio_unitario])).toEqual([['PF-001', '100.0000', '4.5000'], ['FI-001', '40.0000', '2.2500']]);

    await como(comprador, (tx) => enviarOrden(tx, comprador, id));
    d = (await detalleOrden(db, id))!;
    expect(d.estado).toBe('pendiente');
    expect(d.numero).toMatch(/^\d+$/);
    expect(d.total).toBe('540.00');                                   // 450,00 + 90,00 EUR
    expect(d.tasa).toBe('50.000000');
    expect(d.total_usd).toBe('675.00');                               // × 50 ÷ 40

    // Enviada, no se edita ni se borra.
    await esperarError(agregar(id, filtro, '1', '1'), 'en borrador');
    await esperarError(db.query(`update documento_compra set moneda = 'USD' where id = $1`, [id]), 'no se edita');
    await esperarError(db.query('delete from documento_compra where id = $1', [id]), 'no se borra');

    // Quien la creó no la aprueba, ni siquiera siendo Gerencia (la base lo exige además del flujo).
    await esperarError(db.query(`update documento_compra set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, comprador.id]), 'Gerencia');
    await esperarError(como(comprador, (tx) => resolverAprobacion(tx, 'orden_compra', id, comprador.id, 'aprobada')), '');
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', id, gerente.id, 'aprobada'));
    d = (await detalleOrden(db, id))!;
    expect(d.estado).toBe('aprobada');
    expect(d.aprobado_por).toBe('Usuario de prueba');
  });

  it('el creador no aprueba su propia orden aunque sea Gerencia', async () => {
    const gerenteComprador: Usuario = { id: await usuarioDePrueba(db, 'gc@prueba.test', ['gerencia', 'compras']), roles: ['gerencia', 'compras'] };
    const id = await como(gerenteComprador, (tx) => crearOrden(tx, gerenteComprador, { proveedorId: proveedor, almacenId: a01, moneda: 'USD' }));
    await como(gerenteComprador, (tx) => guardarLinea(tx, id, { productoId: pastilla, cantidad: '1', precio: '1' }));
    await como(gerenteComprador, (tx) => enviarOrden(tx, gerenteComprador, id));
    await esperarError(db.query(`update documento_compra set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, gerenteComprador.id]), 'no la aprueba');
  });

  it('validaciones: proveedor activo, productos con inventario, líneas válidas y orden con productos', async () => {
    await esperarError(nuevaOrden({ proveedorId: inactivo }), 'activo');
    const id = await nuevaOrden();
    await esperarError(agregar(id, pastilla, '0', '4'), 'mayor que cero');
    await esperarError(agregar(id, pastilla, '1', '-4'), 'precio');
    await esperarError(agregar(id, servicio, '1', '4'), 'inventario');
    await esperarError(como(comprador, (tx) => enviarOrden(tx, comprador, id)), 'al menos un producto');
    await agregar(id, pastilla, '3', '4');
    const [l] = await lineasDe(id);
    await como(comprador, (tx) => quitarLinea(tx, id, l.id));
    expect(await lineasDe(id)).toEqual([]);
  });

  it('R-BB: repartir por peso o volumen exige esas medidas en todos los productos', async () => {
    const porPeso = await nuevaOrden({ criterio: 'peso' });
    await agregar(porPeso, pastilla, '1', '4');
    await agregar(porPeso, sinMedidas, '1', '4');
    await esperarError(como(comprador, (tx) => enviarOrden(tx, comprador, porPeso)), 'SM-001');
    const porVolumen = await nuevaOrden({ criterio: 'volumen' });
    await agregar(porVolumen, filtro, '1', '4');
    await como(comprador, (tx) => enviarOrden(tx, comprador, porVolumen));       // FI-001 sí tiene medidas
    expect((await detalleOrden(db, porVolumen))!.criterio_reparto).toBe('volumen');
    // Volumen por unidad del filtro: 20×10×5 cm = 0,001 m³ por empaque ÷ 10 unidades = 0,0001 m³.
    expect(Number((await lineasDe(porVolumen))[0].volumen_unitario_m3)).toBeCloseTo(0.0001, 10);
  });

  it('R-BA: la recepción entra al inventario al precio de la orden en USD, con su asiento y sin pasarse de lo pendiente', async () => {
    const id = await aprobada({ moneda: 'EUR' }, [[pastilla, '100', '4.0000'], [filtro, '50', '2.0000']]);
    const [lp, lf] = await lineasDe(id);
    await esperarError(recibir(almacenista, id, [{ lineaId: lp.id, cantidad: '101' }]), 'solo quedan 100');
    await esperarError(recibir(otroAlmacenista, id, [{ lineaId: lp.id, cantidad: '1' }]), 'entre los suyos');
    await esperarError(recibir(almacenista, id, [{ lineaId: lp.id, cantidad: '0' }]), 'al menos un producto');

    const r1 = await recibir(almacenista, id, [{ lineaId: lp.id, cantidad: '60' }, { lineaId: lf.id, cantidad: '50' }]);
    // 4,00 EUR × 50 ÷ 40 = 5,00 USD por unidad; 2,00 EUR → 2,50 USD
    expect(await existencia(pastilla)).toBe('60.0000');
    expect(await costoPromedio(pastilla)).toBe('5.0000');
    expect(await existencia(filtro)).toBe('50.0000');
    expect(r1.costoUsd).toBe('425.00');                                  // 60×5,00 + 50×2,50
    const ass = await asiento('recepcion', r1.id);
    expect(ass.map((l) => [l.codigo, l.debe_usd, l.haber_usd])).toEqual([['1.3.01', '425.00', '0.00'], ['2.1.02', '0.00', '425.00']]);
    expect(ass.map((l) => [l.debe_ves, l.haber_ves])).toEqual([['17000.00', '0.00'], ['0.00', '17000.00']]);   // × 40
    // Idempotencia por origen: no hay un segundo asiento.
    expect((await db.query('select 1 from asiento where origen_tipo = $1 and origen_id = $2', ['recepcion', r1.id])).rows).toHaveLength(1);

    let d = (await detalleOrden(db, id))!;
    expect(d.lineas.map((l) => [l.codigo, l.recibida, l.pendiente])).toEqual([['PF-001', '60.0000', '40.0000'], ['FI-001', '50.0000', '0.0000']]);
    expect(d.recepciones).toHaveLength(1);

    // Segunda recepción con el saldo; lo ya completo no se vuelve a recibir.
    await esperarError(recibir(almacenista, id, [{ lineaId: lf.id, cantidad: '1' }]), 'solo quedan 0');
    await esperarError(recibir(almacenista, id, [{ lineaId: lp.id, cantidad: '41' }]), 'solo quedan 40');
    const r2 = await recibir(almacenista, id, [{ lineaId: lp.id, cantidad: '40' }]);
    expect(Number(r2.numero)).toBe(Number(r1.numero) + 1);
    expect(await existencia(pastilla)).toBe('100.0000');
    d = (await detalleOrden(db, id))!;
    expect(d.lineas[0].pendiente).toBe('0.0000');
    expect((await buscarOrdenes(db, comprador, {})).find((o) => o.id === id)!.pendiente).toBe('0.0000');

    // Una recepción emitida no se edita, no se borra ni se anula.
    await esperarError(db.query(`update documento_compra set estado = 'anulada', anulado_motivo = 'prueba' where id = $1`, [r1.id]), 'no se edita ni se anula');
    await esperarError(db.query('delete from documento_compra where id = $1', [r1.id]), 'no se borra');
    await esperarError(db.query(`update documento_compra_linea set cantidad = 1 where documento_id = $1`, [r1.id]), 'no se modifican');
    expect((await buscarRecepciones(db, almacenista)).map((r) => r.numero)).toContain(r1.numero);
    expect(await buscarRecepciones(db, otroAlmacenista)).toEqual([]);
  });

  it('el costo promedio se mezcla con las entradas anteriores y una orden en USD no convierte', async () => {
    const id = await aprobada({}, [[sinMedidas, '10', '8.0000']]);
    const [l] = await lineasDe(id);
    await recibir(almacenista, id, [{ lineaId: l.id, cantidad: '10' }]);
    expect(await costoPromedio(sinMedidas)).toBe('8.0000');
    const id2 = await aprobada({}, [[sinMedidas, '30', '12.0000']]);
    const [l2] = await lineasDe(id2);
    await recibir(almacenista, id2, [{ lineaId: l2.id, cantidad: '30' }]);
    expect(await costoPromedio(sinMedidas)).toBe('11.0000');          // (80 + 360) ÷ 40
  });

  it('solo se recibe contra una orden aprobada y de la misma persona jurídica; el rechazo y la anulación exigen motivo', async () => {
    const pendiente = await nuevaOrden();
    await agregar(pendiente, pastilla, '5', '4');
    await como(comprador, (tx) => enviarOrden(tx, comprador, pendiente));
    const [l] = await lineasDe(pendiente);
    await esperarError(recibir(almacenista, pendiente, [{ lineaId: l.id, cantidad: '1' }]), 'aprobada');

    await esperarError(como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', pendiente, gerente.id, 'rechazada')), '');
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', pendiente, gerente.id, 'rechazada', { comentario: 'Precio fuera de mercado' }));
    const rechazada = (await detalleOrden(db, pendiente))!;
    expect(rechazada.estado).toBe('rechazada');
    expect(rechazada.rechazo_motivo).toBe('Precio fuera de mercado');
    await esperarError(como(comprador, (tx) => anularOrden(tx, comprador, pendiente, 'x')), 'pendiente o aprobada');

    const buena = await aprobada();
    await esperarError(como(comprador, (tx) => anularOrden(tx, comprador, buena, 'a')), 'motivo');
    await como(comprador, (tx) => anularOrden(tx, comprador, buena, 'El proveedor no tiene el producto'));
    expect((await detalleOrden(db, buena))!.estado).toBe('anulada');
    const [lb] = await lineasDe(buena);
    await esperarError(recibir(almacenista, buena, [{ lineaId: lb.id, cantidad: '1' }]), 'aprobada');
  });

  it('una orden con mercancía recibida no se anula', async () => {
    const id = await aprobada();
    const [l] = await lineasDe(id);
    await recibir(almacenista, id, [{ lineaId: l.id, cantidad: '1' }]);
    await esperarError(como(comprador, (tx) => anularOrden(tx, comprador, id, 'Ya no la necesitamos')), 'mercancía recibida');
  });

  it('una falla a mitad de la recepción no deja nada a medias', async () => {
    const id = await aprobada({}, [[pastilla, '10', '4.0000']]);
    const [l] = await lineasDe(id);
    const antes = await existencia(pastilla);
    await db.query(`delete from tasa_cambio where moneda = 'USD'`);
    await esperarError(recibir(almacenista, id, [{ lineaId: l.id, cantidad: '5' }]), 'tasa');
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    expect(await existencia(pastilla)).toBe(antes);
    expect((await detalleOrden(db, id))!.recepciones).toEqual([]);
    expect((await db.query(`select 1 from documento_compra where orden_id = $1`, [id])).rows).toHaveLength(0);
  });

  it('visibilidad por rol', async () => {
    expect((await buscarOrdenes(db, comprador, {})).length).toBeGreaterThan(0);
    expect((await buscarOrdenes(db, auditor, {})).length).toBeGreaterThan(0);
    expect(await buscarOrdenes(db, { id: comprador.id, roles: ['ventas'] }, {})).toEqual([]);
  });
});
