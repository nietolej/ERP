import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearOrden, detalleOrden, enviarOrden, guardarLinea, type Usuario } from '@/lib/compras/ordenes';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { FILTRO_STOCK_CERO, consultarDisponibilidad } from '@/lib/inventario/disponibilidad';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import {
  crearOrdenDesdeSugerido, saludPorGrupo, sugeridoCompra, tarjetasInventario, valorizacionMensual,
} from '@/lib/reportes/inventario';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('M6 Inventario (spec_reportes §9, §9.1, §9.2)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let comprador: Usuario;
  let gerente: Usuario;
  let almacen = '';
  let proveedor = '';
  let p1 = '';
  let p2 = '';
  let p3 = '';
  let desde = '';
  let hasta = '';
  const sinGrupo = 'Sin grupo';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const mover = (tipo: 'entrada_compra' | 'salida_venta', producto: string, cantidad: number, costo: number) => como(comprador, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ($1, $2, $3, $4, $5, 'prueba', gen_random_uuid())`, [tipo, producto, almacen, tipo === 'salida_venta' ? -cantidad : cantidad, costo]));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idCom = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    comprador = { id: idCom, roles: ['compras'] };
    gerente = { id: idGer, roles: ['gerencia'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    almacen = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.transaction((tx) => asignarUsuarios(tx, almacen, [idCom]));

    const condicion = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const rif = `J-11111111-${digitoVerificador('J', '11111111')}`;
    const prov = await como(comprador, (tx) => crearProveedor(tx, comprador.id, {
      rif, sensibles: { razonSocial: 'Proveedor 11111111', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: { telefono: '0212-5550000' },
    }));
    await db.transaction((tx) => aprobarProveedor(tx, prov.id, gerente.id, condicion));
    proveedor = prov.id;

    const g1 = (await db.query<{ id: string }>(`insert into grupo_producto (codigo, nombre) values ('G1', 'Frenos') returning id`)).rows[0].id;
    const g2 = (await db.query<{ id: string }>(`insert into grupo_producto (codigo, nombre) values ('G2', 'Filtros') returning id`)).rows[0].id;
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const crear = async (codigo: string, grupo: string | null) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      const id = await db.transaction((tx) => crearProducto(tx, idCom, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
      }));
      if (grupo) await db.query('update producto set grupo_id = $2 where id = $1', [id, grupo]);
      return id;
    };
    p1 = await crear('PF-001', g1);
    p2 = await crear('FI-001', g2);
    p3 = await crear('SM-001', null);

    // P1: entran 100 a US$ 2 y hoy salen 30 (stock 70, capital 140). P2: 10 a US$ 5 sin ventas (capital 50).
    // P3: entran 5 y salen 5 (stock cero).
    await mover('entrada_compra', p1, 100, 2);
    await mover('salida_venta', p1, 30, 0);
    await mover('entrada_compra', p2, 10, 5);
    await mover('entrada_compra', p3, 5, 1);
    await mover('salida_venta', p3, 5, 0);
    ({ desde, hasta } = await consultarDisponibilidad(db, {}));
  });
  afterAll(() => cerrar());

  it('capital inmovilizado a costo promedio (no precio de venta) y venta perdida total', async () => {
    const t = await tarjetasInventario(db, desde, hasta);
    expect(t.capitalInmovilizadoUsd).toBe('190.00'); // 70 × 2 + 10 × 5
    expect(Number(t.ventaPerdidaUsd)).toBe(0);       // hoy todo tuvo existencia
  });

  it('valorización mensual: el mes actual vale lo mismo que el capital y los meses anteriores quedan en cero', async () => {
    const serie = await valorizacionMensual(db, 12);
    expect(serie).toHaveLength(12);
    expect(serie.every((s) => s.almacen.includes('Principal'))).toBe(true);
    const ultimo = serie[serie.length - 1];
    expect(ultimo.valorUsd).toBe('190.00');
    expect(serie.slice(0, 11).every((s) => s.valorUsd === '0.00')).toBe(true);
  });

  it('sugerido de compra: velocidad × días de cobertura − (stock + tránsito); solo lo que necesita reposición', async () => {
    const s = await sugeridoCompra(db);
    expect(s.diasCobertura).toBe(90);
    expect(s.filas.map((f) => f.codigo)).toEqual(['PF-001']); // P2 no vendió; P3 no tiene ventas con existencia
    const f = s.filas[0];
    expect(Number(f.stock)).toBe(70);
    expect(Number(f.transito)).toBe(0);
    expect(f.sugerido).toBe(Math.ceil(Number(f.velocidadAjustada) * 90 - 70));
  });

  it('el tránsito (orden aprobada no recibida) se descuenta del sugerido', async () => {
    const antes = (await sugeridoCompra(db)).filas[0];
    const orden = await como(comprador, (tx) => crearOrden(tx, comprador, { proveedorId: proveedor, almacenId: almacen, moneda: 'USD' }));
    await como(comprador, (tx) => guardarLinea(tx, orden, { productoId: p1, cantidad: '600', precio: '2.0000' }));
    await como(comprador, (tx) => enviarOrden(tx, comprador, orden));
    await como(gerente, (tx) => resolverAprobacion(tx, 'orden_compra', orden, gerente.id, 'aprobada'));
    const despues = (await sugeridoCompra(db)).filas[0];
    expect(Number(despues.transito)).toBe(600);
    expect(despues.sugerido).toBe(antes.sugerido - 600);
  });

  it('filtro "solo stock cero": lista únicamente los productos sin existencia comercial', async () => {
    const { filas } = await consultarDisponibilidad(db, { estado: FILTRO_STOCK_CERO });
    expect(filas.map((f) => f.codigo)).toEqual(['SM-001']);
    expect(filas[0].grupo).toBeNull();
  });

  it('salud por grupo: ítems, capital, quiebres, sobrestock y venta perdida (incluye "Sin grupo")', async () => {
    const g = await saludPorGrupo(db, desde, hasta);
    const por = Object.fromEntries(g.map((x) => [x.nombre, x]));
    expect(por['Frenos']).toMatchObject({ codigo: 'G1', items: 1, capitalUsd: '140.00', enQuiebre: 1, enSobrestock: 0 });
    expect(por['Filtros']).toMatchObject({ codigo: 'G2', items: 1, capitalUsd: '50.00', enQuiebre: 0 });
    expect(por[sinGrupo]).toMatchObject({ codigo: null, items: 1, capitalUsd: '0.00', enQuiebre: 1 }); // stock cero = riesgo de quiebre
    expect(g.reduce((s, x) => s + Number(x.capitalUsd), 0)).toBe(190);
  });

  it('crear orden de compra desde el sugerido: borrador en USD con las líneas elegidas a su costo promedio', async () => {
    const id = await como(comprador, (tx) => crearOrdenDesdeSugerido(tx, comprador, { proveedorId: proveedor, almacenId: almacen, lineas: [{ productoId: p1, cantidad: '120' }] }));
    const d = (await detalleOrden(db, id))!;
    expect(d.estado).toBe('borrador');
    expect(d.lineas).toHaveLength(1);
    expect(Number(d.lineas[0].cantidad)).toBe(120);
    expect(Number(d.lineas[0].precio_unitario)).toBe(2);
  });

  it('sin líneas seleccionadas no se crea nada', async () => {
    await esperarError(como(comprador, (tx) => crearOrdenDesdeSugerido(tx, comprador, { proveedorId: proveedor, almacenId: almacen, lineas: [] })), 'al menos un producto');
  });
});
