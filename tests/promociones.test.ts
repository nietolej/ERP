import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCategoria, crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, anularNotaEntrega, cambiarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import {
  ROLES_CREAN_PROMOCIONES, ROLES_VEN_PROMOCIONES, agregarAlcance, agregarAlcancePorCodigo, anularPromocion, buscarPromociones, crearPromocion,
  detallePromocion, editarPromocion, enviarAprobacion, promocionParaLinea, quitarAlcance, type DatosPromocion, type TipoAlcance,
} from '@/lib/ventas/promociones';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('promociones ligadas a las líneas de venta (R-BP, R-BQ, §6.1)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente: Usuario;
  let gerente2: Usuario;
  let supervisor: Usuario;
  let ventas: Usuario;
  let almacenista: Usuario;
  let facturacion: Usuario;
  let mostrador: string;
  let c1: string;     // descuento pactado 5 %
  let c2: string;     // sin descuento
  let c3: string;     // descuento pactado 20 %
  let pastilla: string;   // lista B US$ 10, marca GENERICA, categoría FREN-PAS
  let aceite: string;     // US$ 20, marca GENERICA, categoría LUBR
  let disco: string;      // US$ 50, marca PREMIUM
  let zapata: string;     // US$ 30, categoría FREN-ZAP (hija de FREN)
  let hoy = '';
  let motivoManual = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const dias = async (n: number) => (await db.query<{ d: string }>(`select (((now() at time zone 'America/Caracas')::date) + $1::int)::text as d`, [n])).rows[0].d;
  const datos = (extra: Partial<DatosPromocion> = {}): DatosPromocion => ({
    nombre: 'Promoción de prueba', tipo: 'descuento_pct', descuentoPct: '10', vigenteDesde: hoy, vigenteHasta: hoy, ...extra,
  });
  type Alcance = [TipoAlcance, string, string?];
  /** Promoción armada y enviada; si `aprobar`, aprobada por Gerencia por el motor de flujo. */
  async function nueva(extra: Partial<DatosPromocion>, alcances: Alcance[], aprobar = true, creador: Usuario = supervisor) {
    const fin = await dias(30);
    const p = await como(creador, (tx) => crearPromocion(tx, creador, datos({ vigenteHasta: fin, ...extra })));
    for (const [tipo, codigo, precio] of alcances) {
      await como(creador, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo, codigo, precioEspecialUsd: precio }));
    }
    await como(creador, (tx) => enviarAprobacion(tx, creador, p.id));
    if (aprobar) await como(gerente, (tx) => resolverAprobacion(tx, 'promocion', p.id, gerente.id, 'aprobada'));
    return p;
  }
  const estado = async (id: string) => (await db.query<{ estado: string }>('select estado from promocion where id = $1', [id])).rows[0].estado;
  /** Pedido en borrador de un cliente con las líneas indicadas. */
  async function pedido(cliente: string, lineas: [string, string][]) {
    const id = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: mostrador }));
    for (const [p, c] of lineas) await como(ventas, (tx) => agregarLinea(tx, ventas, id, { productoId: p, cantidad: c }));
    return id;
  }
  const lineas = async (pedidoId: string) => (await db.query<{
    codigo: string; cantidad: string; precio_unitario: string; precio_lista: string; descuento_pct: string; base: string; promocion: string | null; motivo: string | null; id: string;
  }>(
    `select l.id, p.codigo, l.cantidad::text, l.precio_unitario::text, l.precio_lista::text, l.descuento_pct::text, l.base::text,
            pr.codigo as promocion, m.codigo as motivo
       from documento_venta_linea l join producto p on p.id = l.producto_id
       left join promocion pr on pr.id = l.promocion_id left join motivo m on m.id = l.motivo_descuento_id
      where l.documento_id = $1 order by l.linea`, [pedidoId])).rows;
  const linea = async (pedidoId: string) => (await lineas(pedidoId))[0];

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    motivoManual = (await db.query<{ id: string }>(`select id from motivo where tipo = 'descuento' and sistema = false and activo order by codigo limit 1`)).rows[0].id;
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idGer2 = await usuarioDePrueba(db, 'gerente2@prueba.test', ['gerencia']);
    const idSup = await usuarioDePrueba(db, 'supervisor@prueba.test', ['supervisor_ventas']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    gerente = { id: idGer, roles: ['gerencia'] };
    gerente2 = { id: idGer2, roles: ['gerencia'] };
    supervisor = { id: idSup, roles: ['supervisor_ventas'] };
    ventas = { id: idVen, roles: ['ventas'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    facturacion = { id: idFac, roles: ['facturacion'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    hoy = await dias(0);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [idAlm]));

    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string, descuento: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, idFac, {
        rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: descuento }));
      return c.id;
    };
    c1 = await cliente('J-00000010-7', 'Repuestos Lara, C.A.', '5');
    c2 = await cliente('J-00000020-4', 'Autopartes Sur, C.A.', '0');
    c3 = await cliente('J-00000030-1', 'Frenos del Centro, C.A.', '20');

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const premium = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'PREMIUM', 'Premium'));
    const fren = await db.transaction((tx) => crearCategoria(tx, 'FREN', 'Frenos'));
    const frenPas = await db.transaction((tx) => crearCategoria(tx, 'FREN-PAS', 'Pastillas', fren));
    const frenZap = await db.transaction((tx) => crearCategoria(tx, 'FREN-ZAP', 'Zapatas', fren));
    const lubr = await db.transaction((tx) => crearCategoria(tx, 'LUBR', 'Lubricantes'));
    const nuevo = async (codigo: string, alicuota: string, marcaId: string, categoriaId: string, precio: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}`, categoriaId }));
      const id = await db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
      await db.transaction((tx) => fijarPrecio(tx, id, 'B', precio, hoy));
      await como(almacenista, (tx) => tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
         values ('entrada_compra', $1, $2, 1000, 4, 'prueba', gen_random_uuid())`, [id, mostrador]));
      return id;
    };
    pastilla = await nuevo('PF-001', general, marca, frenPas, '10.00');
    aceite = await nuevo('AC-001', exento, marca, lubr, '20.00');
    disco = await nuevo('DF-001', general, premium, frenPas, '50.00');
    zapata = await nuevo('ZF-001', general, marca, frenZap, '30.00');
  });
  afterAll(() => cerrar());

  it('se crea en borrador con código del sistema y valida sus datos', async () => {
    const p = await como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ nombre: 'Frenos de enero' })));
    expect(p.codigo).toBe('PRM0001');
    expect(await estado(p.id)).toBe('borrador');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ nombre: 'ab' }))), 'nombre');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ descuentoPct: '0' }))), 'porcentaje');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ descuentoPct: '101' }))), 'porcentaje');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ descuentoPct: undefined }))), 'porcentaje');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ vigenteDesde: '2026-02-01', vigenteHasta: '2026-01-01' }))), 'no puede terminar antes');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ vigenteDesde: 'hoy' }))), 'desde y hasta');
    await esperarError(como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ cantidadMinima: '-1' }))), 'compra mínima');
    // El precio especial no lleva porcentaje.
    const e = await como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ tipo: 'precio_especial', descuentoPct: undefined })));
    expect(e.codigo).toBe('PRM0002');
    await esperarError(db.query(`update promocion set descuento_pct = 10 where id = $1`, [e.id]), 'check');
    // En borrador se edita; la base no deja borrar ni cambiar el código.
    await como(supervisor, (tx) => editarPromocion(tx, p.id, datos({ nombre: 'Frenos de febrero', descuentoPct: '12.5', cantidadMinima: '4' })));
    expect((await detallePromocion(db, p.id))).toMatchObject({ nombre: 'Frenos de febrero', descuento_pct: '12.50', cantidad_minima: '4.0000', estado: 'borrador' });
    await esperarError(db.query(`update promocion set codigo = 'PRM9999' where id = $1`, [p.id]), 'no se cambian');
    await esperarError(db.query('delete from promocion where id = $1', [p.id]), 'se anula');
    await como(supervisor, (tx) => anularPromocion(tx, p.id, 'Prueba de anulación'));
    await como(supervisor, (tx) => anularPromocion(tx, e.id, 'Prueba de anulación'));
  });

  it('el alcance se arma por producto, código común, categoría (con sus subcategorías), marca y cliente', async () => {
    const p = await como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ nombre: 'Alcance de prueba' })));
    for (const [tipo, codigo] of [['producto', 'pf-001'], ['codigo_comun', 'BASE-AC-001'], ['categoria', 'FREN'], ['marca', 'premium'], ['cliente', 'C00001']] as [TipoAlcance, string][]) {
      await como(supervisor, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo, codigo }));
    }
    const d = (await detallePromocion(db, p.id))!;
    expect(d.alcance.map((a) => [a.tipo, a.codigo])).toEqual([
      ['categoria', 'FREN'], ['codigo_comun', 'BASE-AC-001'], ['marca', 'PREMIUM'], ['producto', 'PF-001'], ['cliente', 'C00001'],
    ]);
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo: 'producto', codigo: 'PF-001' })), 'ya está en el alcance');
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo: 'producto', codigo: 'NO-EXISTE' })), 'No existe');
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo: 'cliente', codigo: '' })), 'código');
    await esperarError(como(supervisor, (tx) => agregarAlcance(tx, p.id, { tipo: 'producto', entidadId: '00000000-0000-0000-0000-000000000000' })), 'no existe');
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo: 'producto', codigo: 'ZF-001', precioEspecialUsd: '5' })), 'no lleva precio especial');
    // La base reconoce qué alcanza: la categoría FREN incluye a sus hijas; la marca PREMIUM, al disco.
    const alcanza = async (producto: string, cliente: string) =>
      (await db.query<{ a: boolean }>('select fn_promocion_alcanza($1, $2, $3) as a', [p.id, producto, cliente])).rows[0].a;
    expect(await alcanza(zapata, (await clienteId('C00001')))).toBe(true);    // por la categoría padre
    expect(await alcanza(zapata, c2)).toBe(false);                            // el alcance de clientes solo incluye a C00001
    expect(await alcanza(disco, (await clienteId('C00001')))).toBe(true);
    // Quitar un elemento del borrador.
    await como(supervisor, (tx) => quitarAlcance(tx, d.alcance.find((a) => a.tipo === 'cliente')!.id));
    expect(await alcanza(zapata, c2)).toBe(true);
    await esperarError(como(supervisor, (tx) => quitarAlcance(tx, '00000000-0000-0000-0000-000000000000')), 'no existe');
    await como(supervisor, (tx) => anularPromocion(tx, p.id, 'Prueba de alcance'));
  });
  const clienteId = async (codigo: string) => (await db.query<{ id: string }>('select tercero_id as id from cliente where codigo = $1', [codigo])).rows[0].id;

  it('una promoción de precio especial solo lleva productos con su precio y clientes', async () => {
    const e = await como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ nombre: 'Precio especial', tipo: 'precio_especial', descuentoPct: undefined })));
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, e.id, { tipo: 'marca', codigo: 'PREMIUM' })), 'productos concretos');
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, e.id, { tipo: 'producto', codigo: 'PF-001' })), 'precio especial');
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, e.id, { tipo: 'producto', codigo: 'PF-001', precioEspecialUsd: '0' })), 'mayor que cero');
    await como(supervisor, (tx) => agregarAlcancePorCodigo(tx, e.id, { tipo: 'producto', codigo: 'PF-001', precioEspecialUsd: '7,5' }));
    expect((await detallePromocion(db, e.id))!.alcance[0].precio_especial_usd).toBe('7.50');
    await como(supervisor, (tx) => anularPromocion(tx, e.id, 'Prueba'));
  });

  it('se envía con alcance, la aprueba Gerencia (nunca quien la creó) y después no se edita (R-BP)', async () => {
    const vacia = await como(supervisor, (tx) => crearPromocion(tx, supervisor, datos({ nombre: 'Sin alcance' })));
    await esperarError(como(supervisor, (tx) => enviarAprobacion(tx, supervisor, vacia.id)), 'a qué productos aplica');
    await como(supervisor, (tx) => agregarAlcancePorCodigo(tx, vacia.id, { tipo: 'cliente', codigo: 'C00001' }));
    await esperarError(como(supervisor, (tx) => enviarAprobacion(tx, supervisor, vacia.id)), 'a qué productos aplica');   // solo clientes no alcanza
    await como(supervisor, (tx) => anularPromocion(tx, vacia.id, 'Prueba'));

    const p = await nueva({ nombre: 'Aprobación' }, [['producto', 'PF-001']], false);
    expect(await estado(p.id)).toBe('pendiente');
    expect((await db.query('select 1 from solicitud_aprobacion where objeto_tipo = $1 and objeto_id = $2 and estado = $3', ['promocion', p.id, 'pendiente'])).rows).toHaveLength(1);
    // Pendiente: ni el alcance ni los datos cambian.
    await esperarError(como(supervisor, (tx) => agregarAlcancePorCodigo(tx, p.id, { tipo: 'producto', codigo: 'AC-001' })), 'borrador');
    await esperarError(como(supervisor, (tx) => editarPromocion(tx, p.id, datos({ nombre: 'Otro' }))), 'no se edita');
    await esperarError(como(supervisor, (tx) => enviarAprobacion(tx, supervisor, p.id)), 'en borrador');

    // Quien no es Gerencia no aprueba; la base también lo exige.
    await expect(como(supervisor, (tx) => resolverAprobacion(tx, 'promocion', p.id, supervisor.id, 'aprobada'))).rejects.toThrow();
    await esperarError(db.query(`update promocion set estado = 'aprobada', aprobado_por = $2 where id = $1`, [p.id, supervisor.id]), 'rol Gerencia');
    expect(await estado(p.id)).toBe('pendiente');
    await como(gerente, (tx) => resolverAprobacion(tx, 'promocion', p.id, gerente.id, 'aprobada'));
    expect(await estado(p.id)).toBe('aprobada');
    expect((await detallePromocion(db, p.id))!.aprobador).toMatch(/Usuario de prueba/);
    await esperarError(db.query(`update promocion set nombre = 'Cambio' where id = $1`, [p.id]), 'no se edita');
    await esperarError(db.query(`update promocion set estado = 'pendiente' where id = $1`, [p.id]), 'no pasa a');
    await esperarError(db.query('delete from promocion_alcance where promocion_id = $1', [p.id]), 'borrador');
    await como(supervisor, (tx) => anularPromocion(tx, p.id, 'Prueba de aprobación'));

    // Si Gerencia la crea, otra persona con ese rol la aprueba.
    const propia = await nueva({ nombre: 'De Gerencia' }, [['producto', 'PF-001']], false, gerente);
    await expect(como(gerente, (tx) => resolverAprobacion(tx, 'promocion', propia.id, gerente.id, 'aprobada'))).rejects.toThrow();
    await esperarError(db.query(`update promocion set estado = 'aprobada', aprobado_por = $2 where id = $1`, [propia.id, gerente.id]), 'Quien creó la promoción');
    await como(gerente2, (tx) => resolverAprobacion(tx, 'promocion', propia.id, gerente2.id, 'aprobada'));
    expect(await estado(propia.id)).toBe('aprobada');
    await como(gerente, (tx) => anularPromocion(tx, propia.id, 'Prueba'));
  });

  it('un rechazo exige motivo y deja la promoción sin efecto; anular exige motivo y no se repite', async () => {
    const p = await nueva({ nombre: 'Rechazada' }, [['producto', 'PF-001']], false);
    await expect(como(gerente, (tx) => resolverAprobacion(tx, 'promocion', p.id, gerente.id, 'rechazada'))).rejects.toThrow();
    await como(gerente, (tx) => resolverAprobacion(tx, 'promocion', p.id, gerente.id, 'rechazada', { comentario: 'El margen no alcanza' }));
    expect(await estado(p.id)).toBe('rechazada');
    expect((await detallePromocion(db, p.id))!.rechazo_motivo).toBe('El margen no alcanza');
    await esperarError(db.query(`update promocion set nombre = 'x' where id = $1`, [p.id]), 'rechazada no se modifica');
    await esperarError(como(supervisor, (tx) => anularPromocion(tx, p.id, 'Ya rechazada')), 'ya no se puede anular');

    const q = await nueva({ nombre: 'Para anular' }, [['producto', 'PF-001']], false);
    await esperarError(como(supervisor, (tx) => anularPromocion(tx, q.id, ' ')), 'motivo');
    await como(supervisor, (tx) => anularPromocion(tx, q.id, 'Cambió la estrategia'));
    expect(await estado(q.id)).toBe('anulada');
    expect((await db.query('select 1 from solicitud_aprobacion where objeto_id = $1 and estado = $2', [q.id, 'cancelada'])).rows).toHaveLength(1);
    await esperarError(como(supervisor, (tx) => anularPromocion(tx, q.id, 'Otra vez')), 'ya no se puede anular');
  });

  describe('aplicación en el pedido', () => {
    let a: { id: string; codigo: string };       // 10 % sobre la pastilla
    let notaA: string;

    it('la línea toma el descuento de la promoción cuando deja un precio menor que el del cliente, con su motivo', async () => {
      a = await nueva({ nombre: 'Pastilla 10 %' }, [['producto', 'PF-001']]);
      const p1 = await pedido(c1, [[pastilla, '3']]);
      expect(await linea(p1)).toMatchObject({
        codigo: 'PF-001', precio_unitario: '10.0000', precio_lista: '10.0000', descuento_pct: '10.00', base: '27.00', promocion: a.codigo, motivo: 'PROMOCION',
      });
      // El cliente de 20 % ya tiene un precio mejor: no se acumulan ni se cambia (gana el menor precio neto).
      expect(await linea(await pedido(c3, [[pastilla, '1']]))).toMatchObject({ descuento_pct: '20.00', promocion: null, motivo: 'DESCUENTO_CLIENTE' });
      // Un producto fuera del alcance no cambia.
      expect(await linea(await pedido(c2, [[aceite, '1']]))).toMatchObject({ descuento_pct: '0.00', promocion: null, motivo: null });
      // Un descuento escrito a mano manda y no queda ligado a la promoción.
      const manual = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: c1, almacenId: mostrador }));
      await como(ventas, (tx) => agregarLinea(tx, ventas, manual, { productoId: pastilla, cantidad: '2', descuentoPct: '15', motivoDescuentoId: motivoManual }));
      expect(await linea(manual)).toMatchObject({ descuento_pct: '15.00', promocion: null });
    });

    it('la compra mínima se vuelve a evaluar al cambiar la cantidad', async () => {
      const b = await nueva({ nombre: 'Pastilla 12 % por mayor', descuentoPct: '12', cantidadMinima: '10' }, [['producto', 'PF-001']]);
      const p = await pedido(c1, [[pastilla, '5']]);
      const l = (await linea(p)).id;
      expect(await linea(p)).toMatchObject({ descuento_pct: '10.00', promocion: a.codigo });
      await como(ventas, (tx) => cambiarLinea(tx, ventas, p, l, { cantidad: '10' }));
      expect(await linea(p)).toMatchObject({ descuento_pct: '12.00', promocion: b.codigo, motivo: 'PROMOCION', base: '88.00' });
      await como(ventas, (tx) => cambiarLinea(tx, ventas, p, l, { cantidad: '3' }));
      expect(await linea(p)).toMatchObject({ descuento_pct: '10.00', promocion: a.codigo });
      // Si quien vende escribe un descuento propio, la línea deja la promoción y la cantidad ya no la vuelve a poner.
      await como(ventas, (tx) => cambiarLinea(tx, ventas, p, l, { cantidad: '3', descuentoPct: '7', motivoDescuentoId: motivoManual }));
      expect(await linea(p)).toMatchObject({ descuento_pct: '7.00', promocion: null });
      await como(ventas, (tx) => cambiarLinea(tx, ventas, p, l, { cantidad: '12' }));
      expect(await linea(p)).toMatchObject({ descuento_pct: '7.00', promocion: null });
      await como(supervisor, (tx) => anularPromocion(tx, b.id, 'Fin de la prueba'));
    });

    it('un precio especial fija el precio sin descuento y puede limitarse a ciertos clientes; gana el menor precio neto', async () => {
      const c = await nueva({ nombre: 'Precio especial al cliente 2', tipo: 'precio_especial', descuentoPct: undefined },
        [['producto', 'PF-001', '7.50'], ['cliente', 'C00002']]);
      // El cliente 2 (sin descuento): la promoción A deja 9,00 y la de precio especial 7,50.
      expect(await linea(await pedido(c2, [[pastilla, '2']]))).toMatchObject({
        precio_unitario: '7.5000', precio_lista: '10.0000', descuento_pct: '0.00', base: '15.00', promocion: c.codigo, motivo: null,
      });
      // El cliente 1 no está en el alcance de esa promoción: sigue con la A.
      expect(await linea(await pedido(c1, [[pastilla, '2']]))).toMatchObject({ precio_unitario: '10.0000', descuento_pct: '10.00', promocion: a.codigo });
      await como(supervisor, (tx) => anularPromocion(tx, c.id, 'Fin de la prueba'));
    });

    it('alcanza por marca, categoría (con sus hijas) y código común; solo aplica si ya empezó y está aprobada', async () => {
      const marca = await nueva({ nombre: 'Marca premium', descuentoPct: '5' }, [['marca', 'PREMIUM']]);
      expect(await linea(await pedido(c2, [[disco, '1']]))).toMatchObject({ descuento_pct: '5.00', promocion: marca.codigo });
      expect(await linea(await pedido(c3, [[disco, '1']]))).toMatchObject({ descuento_pct: '20.00', promocion: null });
      const cat = await nueva({ nombre: 'Todo frenos', descuentoPct: '8' }, [['categoria', 'FREN']]);
      expect(await linea(await pedido(c2, [[zapata, '1']]))).toMatchObject({ descuento_pct: '8.00', promocion: cat.codigo });   // FREN-ZAP es hija de FREN
      expect(await linea(await pedido(c2, [[aceite, '1']]))).toMatchObject({ promocion: null });                                  // lubricantes no
      const comun = await nueva({ nombre: 'Aceite por código común', descuentoPct: '6' }, [['codigo_comun', 'BASE-AC-001']]);
      expect(await linea(await pedido(c2, [[aceite, '1']]))).toMatchObject({ descuento_pct: '6.00', promocion: comun.codigo });
      // Aprobada pero que empieza mañana: todavía no aplica. Pendiente de aprobar: tampoco.
      await nueva({ nombre: 'Aceite mañana', descuentoPct: '50', vigenteDesde: await dias(1) }, [['producto', 'AC-001']]);
      await nueva({ nombre: 'Aceite sin aprobar', descuentoPct: '60' }, [['producto', 'AC-001']], false);
      expect(await linea(await pedido(c2, [[aceite, '1']]))).toMatchObject({ descuento_pct: '6.00', promocion: comun.codigo });
      // fn_promocion_para_linea: la mejor promoción y su precio neto.
      const hace5 = await dias(-5);
      const mejor = await como(ventas, (tx) => promocionParaLinea(tx, { productoId: zapata, clienteId: c2, fecha: hoy, cantidad: '1', precioLista: '30' }));
      expect(mejor).toMatchObject({ promocionId: cat.id, descuentoPct: '8.00', precioNeto: '27.6000' });
      expect(await como(ventas, (tx) => promocionParaLinea(tx, { productoId: zapata, clienteId: c2, fecha: hace5, cantidad: '1', precioLista: '30' }))).toBeNull();
      for (const x of [marca, cat, comun]) await como(supervisor, (tx) => anularPromocion(tx, x.id, 'Fin de la prueba'));
    });

    it('la base rechaza ligar una línea a una promoción que no corresponde', async () => {
      const b = await nueva({ nombre: 'Mínimo 10', descuentoPct: '12', cantidadMinima: '10' }, [['producto', 'PF-001']]);
      const m = await nueva({ nombre: 'Disco', descuentoPct: '5' }, [['producto', 'DF-001']]);
      const sinAprobar = await nueva({ nombre: 'Sin aprobar', descuentoPct: '10' }, [['producto', 'PF-001']], false);
      const especial = await nueva({ nombre: 'Solo cliente 2', tipo: 'precio_especial', descuentoPct: undefined }, [['producto', 'PF-001', '7.50'], ['cliente', 'C00002']]);
      const p = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: c1, almacenId: mostrador }));
      await como(ventas, (tx) => agregarLinea(tx, ventas, p, { productoId: pastilla, cantidad: '3', descuentoPct: '15', motivoDescuentoId: motivoManual }));
      const l = (await linea(p)).id;
      const ligar = (promo: string) => db.query('update documento_venta_linea set promocion_id = $2 where id = $1', [l, promo]);
      await esperarError(ligar(sinAprobar.id), 'no está aprobada');
      await esperarError(ligar(b.id), 'al menos');                           // compra 3 y la promoción exige 10
      await esperarError(ligar(m.id), 'no aplica a este producto');
      await esperarError(ligar(especial.id), 'no aplica a este producto o a este cliente');
      await esperarError(ligar(a.id), 'no coincide con el descuento');       // la línea tiene 15 %, la promoción da 10 %
      await db.query('update documento_venta_linea set descuento_pct = 10 where id = $1', [l]);
      await ligar(a.id);                                                      // con el descuento de la promoción, sí
      expect((await linea(p)).promocion).toBe(a.codigo);
      for (const x of [b, m, especial]) await como(supervisor, (tx) => anularPromocion(tx, x.id, 'Fin de la prueba'));
      await como(supervisor, (tx) => anularPromocion(tx, sinAprobar.id, 'Fin de la prueba'));
    });

    it('la promoción viaja del pedido a la nota de entrega y a la factura, y se mide en vw_promocion_aplicada', async () => {
      const p = await pedido(c1, [[pastilla, '3']]);
      await como(ventas, (tx) => emitirPedido(tx, ventas, p));
      notaA = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, p));
      const enNota = (await db.query<{ promocion_id: string | null }>('select promocion_id from documento_venta_linea where documento_id = $1', [notaA])).rows;
      expect(enNota).toEqual([{ promocion_id: a.id }]);
      await como(almacenista, (tx) => confirmarSalida(tx, almacenista, notaA));
      const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [notaA], { servicio: new ImprentaSimulada() }));
      const enFactura = (await db.query<{ promocion_id: string | null }>('select promocion_id from documento_venta_linea where documento_id = $1', [f.facturaId])).rows;
      expect(enFactura).toEqual([{ promocion_id: a.id }]);

      // Lo que movió la promoción: 3 unidades de 10 a lista (30,00), cobradas 27,00, con 3,00 de descuento.
      const { rows } = await db.query<Record<string, string | number>>(
        `select lineas, notas, unidades::text, venta_lista_usd::text, venta_cobrada_usd::text, descuento_usd::text from vw_promocion_aplicada where promocion_id = $1`, [a.id]);
      expect(rows[0]).toEqual({ lineas: 1, notas: 1, unidades: '3.0000', venta_lista_usd: '30.00', venta_cobrada_usd: '27.00', descuento_usd: '3.00' });
      expect((await detallePromocion(db, a.id))!.aplicada).toMatchObject({ lineas: 1, descuento_usd: '3.00' });
      // Las notas anuladas no cuentan: una nueva nota con la promoción que se anula antes de salir no cambia la medición.
      const p2 = await pedido(c1, [[pastilla, '4']]);
      await como(ventas, (tx) => emitirPedido(tx, ventas, p2));
      const nota2 = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, p2));
      expect((await db.query<{ lineas: number }>('select lineas from vw_promocion_aplicada where promocion_id = $1', [a.id])).rows[0].lineas).toBe(2);
      const otro = (await db.query<{ id: string }>(`select id from motivo where tipo = 'anulacion' and codigo = 'OTRO'`)).rows[0].id;
      await como(ventas, (tx) => anularNotaEntrega(tx, ventas, nota2, { motivoId: otro, detalle: 'Prueba' }));
      expect((await db.query<{ lineas: number }>('select lineas from vw_promocion_aplicada where promocion_id = $1', [a.id])).rows[0].lineas).toBe(1);
      const lista = await buscarPromociones(db, { estado: 'aprobada' });
      expect(lista.find((x) => x.id === a.id)).toMatchObject({ vigente_hoy: true, lineas: 1, unidades: '3.0000', descuento_usd: '3.00' });
    });

    it('una promoción anulada deja de aplicarse y lo ya vendido conserva su vínculo', async () => {
      await como(supervisor, (tx) => anularPromocion(tx, a.id, 'Termina la campaña'));
      expect(await linea(await pedido(c1, [[pastilla, '3']]))).toMatchObject({ descuento_pct: '5.00', promocion: null, motivo: 'DESCUENTO_CLIENTE' });
      expect((await db.query('select 1 from documento_venta_linea where promocion_id = $1', [a.id])).rows.length).toBeGreaterThan(0);
      expect((await buscarPromociones(db, { estado: 'anulada' })).some((x) => x.id === a.id && !x.vigente_hoy)).toBe(true);
    });
  });

  it('crean Gerencia y el Supervisor de ventas; ven además Ventas, Facturación y Auditor', () => {
    expect([...ROLES_CREAN_PROMOCIONES].sort()).toEqual(['gerencia', 'supervisor_ventas']);
    expect([...ROLES_VEN_PROMOCIONES].sort()).toEqual(['auditor', 'facturacion', 'gerencia', 'supervisor_ventas', 'ventas']);
    for (const rol of ['almacen', 'compras', 'cobranzas', 'tesoreria']) expect(ROLES_VEN_PROMOCIONES as readonly string[]).not.toContain(rol);
  });
});
