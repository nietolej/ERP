import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import {
  actualizarDireccion, crearDireccion, fijarVentanas, leerCoordenadas, listarDirecciones, puedeEditarDirecciones, resumenVentanas,
} from '@/lib/maestros/direcciones';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { aprobarProveedor, crearProveedor } from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import {
  actualizarTransportista, actualizarVehiculo, agregarTarifa, buscarTransportistas, cerrarTarifa, crearTransportista, crearVehiculo,
  detalleTransportista,
} from '@/lib/maestros/transportistas';
import { crearVendedor } from '@/lib/maestros/vendedores';
import {
  agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario,
} from '@/lib/ventas/pedidos';
import { detalleOrden, empacarOrden, finalizarOrden, iniciarOrden, registrarRecogida } from '@/lib/ventas/picking';
import {
  agregarParada, anularTransporte, buscarTransportes, cambiarDireccionParada, cargarTransporte, cerrarTransporte, crearTransporte,
  detalleTransporte, editarTransporte, moverParada, notasDespachables, quitarParada, registrarEntrega, registrarLlegada,
  registrarNoEntrega, salirARuta,
} from '@/lib/ventas/transportes';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const rif = (letra: string, n: string) => `${letra}-${n}-${digitoVerificador(letra, n)}`;

describe('direcciones de entrega, transportistas y transporte (§5.1, §6.4)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacenista: Usuario;
  let otroAlmacenista: Usuario;
  let gerente: Usuario;
  let ventas: Usuario;
  let otroVendedor: Usuario;
  let compras: Usuario;
  let a01: string;
  let mostrador: string;
  let cliente: string;
  let cliente2: string;
  let pastilla: string;     // peso 2,5 kg, 10×10×10 cm
  let aceite: string;       // sin medidas
  let propia: string;       // transportista de flota propia
  let camion: string;       // vehículo de la flota propia
  let courier: string;      // encomienda de terceros
  let hoy = '';
  let dirPrincipal = '';
  let dirDeposito = '';
  let dirCliente2 = '';

  const como = <T,>(usuario: string, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  const dias = async (n: number) => (await db.query<{ d: string }>(
    `select (((now() at time zone 'America/Caracas')::date) + $1::int)::text as d`, [n])).rows[0].d;

  /** Nota de entrega emitida (con su picking recogido y empacado si el almacén lo usa). */
  async function nota(almacen: string, lineas: [string, string][], clienteId = cliente, listaParaDespachar = true) {
    const pedido = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId, almacenId: almacen }));
    for (const [p, c] of lineas) await como(ventas.id, (tx) => agregarLinea(tx, ventas, pedido, { productoId: p, cantidad: c }));
    await como(ventas.id, (tx) => emitirPedido(tx, ventas, pedido));
    const notaId = await como(ventas.id, (tx) => generarNotaEntrega(tx, ventas, pedido));
    const { rows } = await db.query<{ id: string }>(`select id from orden_picking where nota_entrega_id = $1 and estado <> 'cancelada'`, [notaId]);
    const orden = rows[0]?.id;
    if (orden && listaParaDespachar) {
      await como(almacenista.id, (tx) => iniciarOrden(tx, almacenista, orden));
      for (const l of (await detalleOrden(db, orden))!.lineas) {
        await como(almacenista.id, (tx) => registrarRecogida(tx, almacenista, orden, l.id, { cantidad: l.pedida }));
      }
      await como(almacenista.id, (tx) => finalizarOrden(tx, almacenista, orden));
      await como(almacenista.id, (tx) => empacarOrden(tx, almacenista, orden));
    }
    return { notaId, orden };
  }
  const salida = async (notaId: string) =>
    (await db.query<{ s: boolean }>('select salida_at is not null as s from documento_venta where id = $1', [notaId])).rows[0].s;
  const nuevoTransporte = (extra: Partial<Parameters<typeof crearTransporte>[2]> = {}) =>
    como(almacenista.id, (tx) => crearTransporte(tx, almacenista, {
      almacenId: a01, transportistaId: propia, vehiculoId: camion, chofer: 'Luis Gómez', fechaProgramada: hoy, ...extra,
    }));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idAlm2 = await usuarioDePrueba(db, 'almacen2@prueba.test', ['almacen']);
    const idVentas = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idVentas2 = await usuarioDePrueba(db, 'ventas2@prueba.test', ['ventas']);
    const idFact = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idCompras = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    gerente = { id: idGerente, roles: ['gerencia'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    otroAlmacenista = { id: idAlm2, roles: ['almacen'] };
    ventas = { id: idVentas, roles: ['ventas'] };
    otroVendedor = { id: idVentas2, roles: ['ventas'] };
    compras = { id: idCompras, roles: ['compras'] };

    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    hoy = await dias(0);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    await db.query('update almacen set usa_picking = false where id = $1', [mostrador]);
    await db.transaction(async (tx) => {
      await asignarUsuarios(tx, a01, [idAlm]);
      await asignarUsuarios(tx, mostrador, [idAlm, idAlm2]);
    });

    const vendedor = await db.transaction((tx) => crearVendedor(tx, idGerente, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVentas }));
    await db.transaction((tx) => crearVendedor(tx, idGerente, { nombre: 'Ana Díaz', tipo: 'interno', usuarioId: idVentas2 }));
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const nuevoCliente = async (r: string, nombre: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, idFact, {
        rif: r, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
        comercial: { vendedorId: vendedor.id },
      }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, idGerente, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' }));
      return c.id;
    };
    cliente = await nuevoCliente('J-12345678-4', 'Repuestos Lara, C.A.');
    cliente2 = await nuevoCliente(rif('J', '30000001'), 'Autos del Sur, C.A.');

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, idAlm, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
    };
    pastilla = await nuevo('PF-001', general);
    aceite = await nuevo('AC-001', exento);
    await db.query(
      `update producto set peso_kg = 2.5, empaque_largo_cm = 10, empaque_ancho_cm = 10, empaque_alto_cm = 10 where id = $1`, [pastilla]);
    await db.transaction(async (tx) => {
      await fijarPrecio(tx, pastilla, 'B', '10.00', hoy);
      await fijarPrecio(tx, aceite, 'B', '20.00', hoy);
    });
    for (const [p, a, c, costo] of [[pastilla, a01, '500', '4.00'], [aceite, a01, '500', '6.50'], [pastilla, mostrador, '50', '4.00']]) {
      await como(idAlm, (tx) => tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
         values ('entrada_compra', $1, $2, $3, $4, 'prueba', gen_random_uuid())`, [p, a, c, costo]));
    }

    propia = (await como(idAlm, (tx) => crearTransportista(tx, { nombre: 'Reparto propio Barquisimeto', modalidad: 'flota_propia' }))).id;
    camion = await como(idAlm, (tx) => crearVehiculo(tx, propia, { placa: 'ab-123cd', descripcion: 'Camión 350', capacidadKg: '30', capacidadM3: '2' }));
    // Un proveedor de servicios aprobado para la encomienda.
    const prov = await como(idCompras, (tx) => crearProveedor(tx, idCompras, {
      rif: rif('J', '40000001'),
      sensibles: { razonSocial: 'Encomiendas Rápidas, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'servicios', pais: 'VE', conceptoIslrId: null },
      contacto: {},
    }));
    await como(idGerente, (tx) => aprobarProveedor(tx, prov.id, idGerente, contado));
    courier = (await como(idAlm, (tx) => crearTransportista(tx, { nombre: 'Encomiendas Rápidas', modalidad: 'encomienda', proveedorId: prov.id }))).id;

    dirPrincipal = await como(idFact, (tx) => crearDireccion(tx, cliente, {
      nombre: 'Sede principal', direccion: 'Av. Lara, local 5', ciudad: 'Barquisimeto', entidadFederal: 'Lara', coordenadas: '10.0678, -69.3467',
    }));
    dirDeposito = await como(idFact, (tx) => crearDireccion(tx, cliente, {
      nombre: 'Depósito Cabudare', direccion: 'Zona industrial, galpón 3', ciudad: 'Cabudare', entidadFederal: 'Lara', coordenadas: '10.0333, -69.2500',
    }));
    dirCliente2 = await como(idFact, (tx) => crearDireccion(tx, cliente2, {
      nombre: 'Tienda', direccion: 'Calle 12 con carrera 4', ciudad: 'Valencia', entidadFederal: 'Carabobo',
    }));
  });
  afterAll(() => cerrar());

  describe('direcciones de entrega del cliente (R-BJ)', () => {
    it('lee las coordenadas como las copian los mapas y rechaza las que no son de Venezuela', () => {
      expect(leerCoordenadas('10.0678, -69.3467')).toEqual({ latitud: '10.0678', longitud: '-69.3467' });
      expect(leerCoordenadas('10.0678 -69.3467')).toEqual({ latitud: '10.0678', longitud: '-69.3467' });
      expect(leerCoordenadas('10,0678; -69,3467')).toEqual({ latitud: '10.0678', longitud: '-69.3467' });
      expect(leerCoordenadas('  ')).toBeNull();
      expect(() => leerCoordenadas('abc')).toThrow('latitud y longitud');
      expect(() => leerCoordenadas('10.0')).toThrow('latitud y longitud');
      expect(() => leerCoordenadas('-69.3467, 10.0678')).toThrow('fuera de Venezuela');   // invertidas
      expect(() => leerCoordenadas('40.4, -3.7')).toThrow('fuera de Venezuela');
    });

    it('la primera dirección vigente es la predeterminada y solo hay una a la vez', async () => {
      const lista = await listarDirecciones(db, cliente);
      expect(lista.map((d) => [d.nombre, d.predeterminada])).toEqual([['Sede principal', true], ['Depósito Cabudare', false]]);
      expect(lista[0]).toMatchObject({ latitud: '10.067800', longitud: '-69.346700', minutos_descarga: 15, ventana_tipo: 'blanda' });
      // Cambiar la predeterminada libera la anterior.
      const dep = lista[1];
      await db.transaction((tx) => actualizarDireccion(tx, dep.id, {
        nombre: dep.nombre, direccion: dep.direccion, ciudad: dep.ciudad, entidadFederal: dep.entidad_federal,
        coordenadas: '10.0333, -69.2500', predeterminada: true, activa: true,
      }));
      expect((await listarDirecciones(db, cliente)).map((d) => [d.nombre, d.predeterminada])).toEqual([['Depósito Cabudare', true], ['Sede principal', false]]);
      await db.transaction((tx) => actualizarDireccion(tx, dirPrincipal, {
        nombre: 'Sede principal', direccion: 'Av. Lara, local 5', ciudad: 'Barquisimeto', entidadFederal: 'Lara',
        coordenadas: '10.0678, -69.3467', predeterminada: true, activa: true,
      }));
      expect((await listarDirecciones(db, cliente))[0].nombre).toBe('Sede principal');
    });

    it('la base exige latitud y longitud juntas, dentro de Venezuela, y no borra direcciones', async () => {
      const ins = (lat: string | null, lon: string | null) => db.query(
        `insert into cliente_direccion_entrega (cliente_id, nombre, direccion, ciudad, entidad_federal, latitud, longitud)
         values ($1, 'X', 'Calle 1 con 2', 'Coro', 'Falcón', $2, $3)`, [cliente2, lat, lon]);
      await esperarError(ins('11.4', null), 'check');
      await esperarError(ins('-69.3', '10.0'), 'check');
      await esperarError(db.query('delete from cliente_direccion_entrega where id = $1', [dirPrincipal]), 'se inactiva');
      await esperarError(db.query('update cliente_direccion_entrega set cliente_id = $2 where id = $1', [dirPrincipal, cliente2]), 'no cambia de cliente');
      await esperarError(db.transaction((tx) => crearDireccion(tx, cliente2, { nombre: 'A', direccion: 'x', ciudad: 'C', entidadFederal: 'E' })), 'Indique');
    });

    it('el horario de recepción admite varios rangos por día sin solaparse y la base dice si un instante cae dentro', async () => {
      await db.transaction((tx) => fijarVentanas(tx, dirPrincipal, [
        { dia: 1, desde: '08:00', hasta: '12:00' }, { dia: 1, desde: '14:00', hasta: '17:00' },
        ...[2, 3, 4, 5].map((dia) => ({ dia, desde: '08:00', hasta: '12:00' })),
      ]));
      const d = (await listarDirecciones(db, cliente))[0];
      expect(d.ventanas).toHaveLength(6);
      expect(resumenVentanas(d.ventanas)).toBe('Lun-Vie 08:00-12:00 · Lun 14:00-17:00');
      expect(resumenVentanas([])).toBe('Cualquier hora');

      await esperarError(db.transaction((tx) => fijarVentanas(tx, dirPrincipal, [
        { dia: 1, desde: '08:00', hasta: '12:00' }, { dia: 1, desde: '11:00', hasta: '13:00' }])), 'solapar');
      await esperarError(db.transaction((tx) => fijarVentanas(tx, dirPrincipal, [{ dia: 8, desde: '08:00', hasta: '12:00' }])), 'día de la ventana');
      await esperarError(db.transaction((tx) => fijarVentanas(tx, dirPrincipal, [{ dia: 1, desde: '12:00', hasta: '08:00' }])), 'posterior');
      // El rechazo revirtió el reemplazo: el horario anterior sigue.
      expect((await listarDirecciones(db, cliente))[0].ventanas).toHaveLength(6);

      // 2026-03-02 es lunes.
      const en = async (instante: string) => (await db.query<{ v: boolean | null }>(
        'select fn_en_ventana($1, $2::timestamptz) as v', [dirPrincipal, instante])).rows[0].v;
      expect(await en('2026-03-02 10:00-04')).toBe(true);
      expect(await en('2026-03-02 13:00-04')).toBe(false);
      expect(await en('2026-03-02 15:00-04')).toBe(true);
      expect(await en('2026-03-07 10:00-04')).toBe(false);                 // sábado
      expect((await db.query<{ v: boolean | null }>('select fn_en_ventana($1, now()) as v', [dirCliente2])).rows[0].v).toBeNull();   // sin ventana
      await db.transaction((tx) => fijarVentanas(tx, dirPrincipal, []));
      expect(await en('2026-03-07 10:00-04')).toBeNull();
    });

    it('Ventas solo edita direcciones de su cartera; Facturación, Supervisor y Gerencia las de todos', async () => {
      const original = (await db.query<{ v: string }>('select vendedor_id as v from cliente where tercero_id = $1', [cliente2])).rows[0].v;
      await db.transaction(async (tx) => {
        const v = (await tx.query<{ id: string }>('select id from vendedor where usuario_id = $1', [otroVendedor.id])).rows[0].id;
        await tx.query('update cliente set vendedor_id = $2 where tercero_id = $1', [cliente2, v]);
      });
      expect(await puedeEditarDirecciones(db, ventas, cliente)).toBe(true);
      expect(await puedeEditarDirecciones(db, ventas, cliente2)).toBe(false);
      expect(await puedeEditarDirecciones(db, otroVendedor, cliente2)).toBe(true);
      expect(await puedeEditarDirecciones(db, gerente, cliente2)).toBe(true);
      expect(await puedeEditarDirecciones(db, { id: 'x', roles: ['facturacion'] }, cliente2)).toBe(true);
      expect(await puedeEditarDirecciones(db, almacenista, cliente)).toBe(false);
      expect(await puedeEditarDirecciones(db, compras, cliente)).toBe(false);
      await db.query('update cliente set vendedor_id = $2 where tercero_id = $1', [cliente2, original]);
    });
  });

  describe('transportistas, vehículos y tarifas (R-BK, R-BL)', () => {
    it('la flota propia no tiene proveedor; los terceros son un proveedor de servicios aprobado', async () => {
      await esperarError(db.transaction((tx) => crearTransportista(tx, { nombre: 'Reparto X', modalidad: 'flota_propia', proveedorId: cliente })), 'no tiene proveedor');
      await esperarError(db.transaction((tx) => crearTransportista(tx, { nombre: 'Fletes Lara', modalidad: 'carga' })), 'proveedor de servicios');
      // Un proveedor de mercancía no sirve, ni uno pendiente.
      const mercancia = await como(compras.id, (tx) => crearProveedor(tx, compras.id, {
        rif: rif('J', '40000002'),
        sensibles: { razonSocial: 'Autopartes Centro, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
        contacto: {},
      }));
      await esperarError(db.transaction((tx) => crearTransportista(tx, { nombre: 'Fletes Lara', modalidad: 'carga', proveedorId: mercancia.id })), 'proveedor de servicios ya aprobado');
      const servicios = await como(compras.id, (tx) => crearProveedor(tx, compras.id, {
        rif: rif('J', '40000003'),
        sensibles: { razonSocial: 'Fletes Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'servicios', pais: 'VE', conceptoIslrId: null },
        contacto: {},
      }));
      await esperarError(db.transaction((tx) => crearTransportista(tx, { nombre: 'Fletes Lara', modalidad: 'carga', proveedorId: servicios.id })), 'ya aprobado y activo');
      const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
      await como(gerente.id, (tx) => aprobarProveedor(tx, servicios.id, gerente.id, contado));
      const t = await db.transaction((tx) => crearTransportista(tx, { nombre: 'Fletes Lara', modalidad: 'carga', proveedorId: servicios.id }));
      expect(t.codigo).toMatch(/^T\d{5}$/);
      // El mismo proveedor no es dos veces transportista de la misma modalidad, ni dos transportistas se llaman igual.
      await esperarError(db.transaction((tx) => crearTransportista(tx, { nombre: 'Otro nombre', modalidad: 'carga', proveedorId: servicios.id })), 'Ya existe');
      await esperarError(db.transaction((tx) => crearTransportista(tx, { nombre: 'fletes  lara', modalidad: 'flota_propia' })), 'Ya existe');

      const d = (await detalleTransportista(db, t.id))!;
      expect(d).toMatchObject({ modalidad: 'carga', activo: true });
      expect(d.proveedor).toMatch(/Fletes Lara/);
      // La modalidad y el proveedor no se cambian.
      await esperarError(db.query(`update transportista set modalidad = 'encomienda' where id = $1`, [t.id]), 'no se cambian');
      await esperarError(db.query('delete from transportista where id = $1', [t.id]), 'se inactiva');
      const lista = await buscarTransportistas(db);
      expect(lista.map((x) => x.nombre)).toEqual(expect.arrayContaining(['Reparto propio Barquisimeto', 'Fletes Lara', 'Encomiendas Rápidas']));
    });

    it('la placa se normaliza y no se repite; la encomienda no tiene vehículos', async () => {
      const v = (await detalleTransportista(db, propia))!.vehiculos[0];
      expect(v).toMatchObject({ placa: 'AB123CD', capacidad_kg: '30.00', capacidad_m3: '2.000', activo: true });
      await esperarError(db.transaction((tx) => crearVehiculo(tx, propia, { placa: 'AB 123-CD', descripcion: 'Otro' })), 'unique');
      await esperarError(db.transaction((tx) => crearVehiculo(tx, propia, { placa: 'X1', descripcion: 'Moto' })), 'placa');
      await esperarError(db.transaction((tx) => crearVehiculo(tx, courier, { placa: 'ZZ999ZZ', descripcion: 'Moto' })), 'encomienda');
      await esperarError(db.transaction((tx) => crearVehiculo(tx, propia, { placa: 'QQ111QQ', descripcion: 'Moto', capacidadKg: '-5' })), 'Capacidad en kg');
      await db.transaction((tx) => actualizarVehiculo(tx, camion, { descripcion: 'Camión 350', capacidadKg: '30', capacidadM3: '2', costoKmUsd: '0.35', costoHoraUsd: '4', activo: true }));
      expect((await detalleTransportista(db, propia))!.vehiculos[0]).toMatchObject({ costo_km_usd: '0.3500', costo_hora_usd: '4.00' });
    });

    it('las tarifas no se editan ni se borran: una nueva cierra la anterior y no se solapan', async () => {
      const carga = (await buscarTransportistas(db)).find((x) => x.modalidad === 'carga')!.id;
      const manana = await dias(1);
      const en10 = await dias(10);
      const ayer = await dias(-1);
      const en30 = await dias(30);
      const en60 = await dias(60);
      await esperarError(db.transaction((tx) => agregarTarifa(tx, propia, { unidadCobro: 'por_viaje', moneda: 'USD', monto: '20', vigenteDesde: hoy })), 'flota propia no tiene tarifas');
      await esperarError(db.transaction((tx) => agregarTarifa(tx, carga, { unidadCobro: 'por_kg', moneda: 'USD', monto: '0.1', vigenteDesde: ayer })), 'pasado');
      await esperarError(db.transaction((tx) => agregarTarifa(tx, carga, { unidadCobro: 'por_kg', moneda: 'USD', monto: '0.1', ciudad: 'Coro', vigenteDesde: hoy })), 'también el estado');

      const t1 = await db.transaction((tx) => agregarTarifa(tx, carga, { entidadFederal: 'Falcón', ciudad: 'Coro', unidadCobro: 'por_kg', moneda: 'USD', monto: '0.15', minimo: '5', vigenteDesde: hoy }));
      // Otra para el mismo destino y unidad más adelante: la anterior se cierra el día anterior.
      const t2 = await db.transaction((tx) => agregarTarifa(tx, carga, { entidadFederal: 'falcon ', ciudad: 'CORO', unidadCobro: 'por_kg', moneda: 'USD', monto: '0.18', vigenteDesde: en10 }));
      let tarifas = (await detalleTransportista(db, carga))!.tarifas;
      expect(tarifas.find((x) => x.id === t1)).toMatchObject({ vigente_hasta: await dias(9), monto: '0.1500', minimo: '5.00', vigente: true });
      expect(tarifas.find((x) => x.id === t2)).toMatchObject({ vigente_hasta: null, vigente: false });
      // Otra unidad o destino no se afecta; un destino general convive con uno específico.
      await db.transaction((tx) => agregarTarifa(tx, carga, { unidadCobro: 'por_viaje', moneda: 'USD', monto: '40', vigenteDesde: hoy }));
      // Solapes directos se rechazan.
      await esperarError(db.query(
        `insert into transportista_tarifa (transportista_id, entidad_federal, ciudad, unidad_cobro, moneda, monto, vigente_desde)
         values ($1, 'Falcón', 'Coro', 'por_kg', 'USD', 0.2, $2)`, [carga, manana]), 'cubre esas fechas');
      // Inmutables.
      await esperarError(db.query('update transportista_tarifa set monto = 1 where id = $1', [t1]), 'no se edita');
      await esperarError(db.query('delete from transportista_tarifa where id = $1', [t1]), 'no se borra');
      await esperarError(db.query('update transportista_tarifa set vigente_hasta = null where id = $1', [t1]), 'cerrar o acortar');
      await db.transaction((tx) => cerrarTarifa(tx, t2, en30));
      tarifas = (await detalleTransportista(db, carga))!.tarifas;
      expect(tarifas.find((x) => x.id === t2)!.vigente_hasta).toBe(await dias(30));
      await esperarError(db.transaction((tx) => cerrarTarifa(tx, t2, en60)), 'cerrar o acortar');
      expect((await buscarTransportistas(db)).find((x) => x.id === carga)!.tarifas_vigentes).toBe(2);
    });
  });

  describe('transporte y paradas (R-BM, R-BN)', () => {
    it('crea con número correlativo y valida el transportista, el vehículo, el almacén y la fecha', async () => {
      const a = await nuevoTransporte();
      const b = await nuevoTransporte();
      const [da, db2] = [(await detalleTransporte(db, a))!, (await detalleTransporte(db, b))!];
      expect(da.estado).toBe('planificado');
      expect(Number(db2.numero.split('-')[1])).toBe(Number(da.numero.split('-')[1]) + 1);
      expect(da).toMatchObject({ chofer: 'Luis Gómez', vehiculo: 'AB123CD · Camión 350', modalidad: 'flota_propia' });

      await esperarError(nuevoTransporte({ fechaProgramada: await dias(-1) }), 'anterior a hoy');
      await esperarError(nuevoTransporte({ transportistaId: courier }), 'pertenecer al transportista');   // el camión no es del courier
      await esperarError(como(otroAlmacenista.id, (tx) => crearTransporte(tx, otroAlmacenista, { almacenId: a01, transportistaId: propia, fechaProgramada: hoy })), 'no está entre los suyos');
      await esperarError(nuevoTransporte({ fechaProgramada: 'mañana' }), 'fecha programada');
      // No se editan el número ni el almacén; el transporte no se borra.
      await esperarError(db.query('update transporte set numero = 999 where id = $1', [a]), 'no cambia de serie');
      await esperarError(db.query('delete from transporte where id = $1', [a]), 'se anula');
      await como(almacenista.id, (tx) => editarTransporte(tx, almacenista, a, { transportistaId: propia, vehiculoId: camion, chofer: 'Pedro Rojas', fechaProgramada: hoy }));
      expect((await detalleTransporte(db, a))!.chofer).toBe('Pedro Rojas');
    });

    it('solo se despachan notas emitidas del mismo almacén, con picking completo y una dirección activa de su cliente', async () => {
      const t = await nuevoTransporte();
      const incompleta = await nota(a01, [[pastilla, '1']], cliente, false);
      const lista = await nota(a01, [[pastilla, '1']]);
      const delMostrador = await nota(mostrador, [[pastilla, '1']]);

      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: incompleta.notaId })), 'picking de la nota debe estar completo');
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: delMostrador.notaId })), 'otro almacén');
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: lista.notaId, direccionId: dirCliente2 })), 'dirección activa del cliente');
      await esperarError(como(otroAlmacenista.id, (tx) => agregarParada(tx, otroAlmacenista, t, { notaId: lista.notaId })), 'no está entre los suyos');
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: '00000000-0000-0000-0000-000000000000' })), 'no existe');

      const disponibles = await notasDespachables(db, almacenista, a01);
      expect(disponibles.map((n) => n.id)).toContain(lista.notaId);
      expect(disponibles.map((n) => n.id)).not.toContain(incompleta.notaId);

      const p = await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: lista.notaId }));
      expect((await detalleTransporte(db, t))!.paradas[0]).toMatchObject({ id: p, orden: 1, direccion_id: dirPrincipal, ubicada: true, vigente: true });
      expect((await notasDespachables(db, almacenista, a01)).map((n) => n.id)).not.toContain(lista.notaId);
      // El almacén sin picking despacha sin él (R-AL).
      const t2 = await nuevoTransporte({ almacenId: mostrador });
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t2, { notaId: delMostrador.notaId }));
      // Un cliente sin dirección de entrega no puede despacharse.
      const sinDireccion = await nota(a01, [[pastilla, '1']], cliente2);
      await db.query('update cliente_direccion_entrega set activa = false where id = $1', [dirCliente2]);
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: sinDireccion.notaId })), 'no tiene dirección de entrega');
      await db.query('update cliente_direccion_entrega set activa = true where id = $1', [dirCliente2]);
      // Una nota solo está en un transporte a la vez, también contra el SQL directo (R-BN).
      const otro = await nuevoTransporte();
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, otro, { notaId: lista.notaId })), 'ya está en otro transporte');
      await esperarError(db.query(
        'insert into transporte_parada (transporte_id, nota_entrega_id, direccion_entrega_id, orden) values ($1, $2, $3, 1)',
        [otro, lista.notaId, dirPrincipal]), 'ya está en otro transporte');
      // Se puede reordenar y quitar mientras está planificado.
      const m = await nota(a01, [[aceite, '1']]);
      const p2 = await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: m.notaId, direccionId: dirDeposito }));
      await como(almacenista.id, (tx) => moverParada(tx, almacenista, p2, 'subir'));
      expect((await detalleTransporte(db, t))!.paradas.map((x) => [x.orden, x.nota_id])).toEqual([[1, m.notaId], [2, lista.notaId]]);
      await como(almacenista.id, (tx) => moverParada(tx, almacenista, p2, 'subir'));            // ya es la primera: no pasa nada
      await como(almacenista.id, (tx) => cambiarDireccionParada(tx, almacenista, p2, dirPrincipal));
      await esperarError(como(almacenista.id, (tx) => cambiarDireccionParada(tx, almacenista, p2, dirCliente2)), 'dirección activa del cliente');
      await como(almacenista.id, (tx) => quitarParada(tx, almacenista, p2));
      expect((await detalleTransporte(db, t))!.paradas.map((x) => [x.orden, x.nota_id])).toEqual([[1, lista.notaId]]);
      expect((await notasDespachables(db, almacenista, a01)).map((n) => n.id)).toContain(m.notaId);
    });

    it('no se puede inactivar la dirección, el vehículo ni el transportista de un transporte en curso', async () => {
      const t = await nuevoTransporte();
      const n = await nota(a01, [[pastilla, '1']]);
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: n.notaId }));
      await esperarError(db.transaction((tx) => actualizarDireccion(tx, dirPrincipal, {
        nombre: 'Sede principal', direccion: 'Av. Lara, local 5', ciudad: 'Barquisimeto', entidadFederal: 'Lara', activa: false,
      })), 'transporte en curso');
      await esperarError(db.transaction((tx) => actualizarVehiculo(tx, camion, { descripcion: 'Camión 350', activo: false })), 'transporte en curso');
      await esperarError(db.transaction((tx) => actualizarTransportista(tx, propia, { nombre: 'Reparto propio Barquisimeto', activo: false })), 'transporte en curso');
      await como(almacenista.id, (tx) => anularTransporte(tx, almacenista, t, 'Prueba'));
    });

    it('anular libera las notas, exige motivo y solo vale con el transporte planificado', async () => {
      const t = await nuevoTransporte();
      const n = await nota(a01, [[pastilla, '2']]);
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: n.notaId }));
      await esperarError(como(almacenista.id, (tx) => anularTransporte(tx, almacenista, t, ' ')), 'motivo');
      await como(almacenista.id, (tx) => anularTransporte(tx, almacenista, t, 'Cliente canceló la entrega'));
      const d = (await detalleTransporte(db, t))!;
      expect(d).toMatchObject({ estado: 'anulado', anulado_motivo: 'Cliente canceló la entrega' });
      expect(d.paradas[0].vigente).toBe(false);
      await esperarError(como(almacenista.id, (tx) => anularTransporte(tx, almacenista, t, 'otra vez')), 'planificado');
      await esperarError(como(almacenista.id, (tx) => editarTransporte(tx, almacenista, t, { transportistaId: propia, fechaProgramada: hoy })), 'anulado no se modifica');
      // El número del transporte anulado se conserva y la nota puede ir en otro.
      const otro = await nuevoTransporte();
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, otro, { notaId: n.notaId }));
      await como(almacenista.id, (tx) => anularTransporte(tx, almacenista, otro, 'Prueba'));
      expect((await buscarTransportes(db, almacenista, { estado: 'anulado' })).length).toBeGreaterThanOrEqual(2);
    });

    it('cargar confirma la salida de todas las notas con su asiento, o no hace nada; exige vehículo y chofer (R-BM)', async () => {
      const t = await nuevoTransporte();
      const n1 = await nota(a01, [[pastilla, '3']]);
      const n2 = await nota(a01, [[aceite, '2']]);
      await esperarError(como(almacenista.id, (tx) => cargarTransporte(tx, almacenista, t)), 'al menos una parada');
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: n1.notaId }));
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: n2.notaId }));

      // Sin periodo contable abierto la salida falla y revierte todo.
      await db.query(`update periodo_contable set estado = 'cerrado'`);
      await esperarError(como(almacenista.id, (tx) => cargarTransporte(tx, almacenista, t)), 'eriodo');
      await db.query(`update periodo_contable set estado = 'abierto'`);
      expect([await salida(n1.notaId), await salida(n2.notaId)]).toEqual([false, false]);
      expect((await detalleTransporte(db, t))!.estado).toBe('planificado');

      // Sin chofer tampoco se carga, y la salida de las notas también se revierte.
      await db.query('update transporte set chofer = null where id = $1', [t]);
      await esperarError(como(almacenista.id, (tx) => cargarTransporte(tx, almacenista, t)), 'vehículo y el chofer');
      expect([await salida(n1.notaId), await salida(n2.notaId)]).toEqual([false, false]);
      await db.query(`update transporte set chofer = 'Luis Gómez' where id = $1`, [t]);

      await esperarError(como(otroAlmacenista.id, (tx) => cargarTransporte(tx, otroAlmacenista, t)), 'no está entre los suyos');
      const r = await como(almacenista.id, (tx) => cargarTransporte(tx, almacenista, t));
      expect(r.notasDespachadas).toBe(2);
      expect([await salida(n1.notaId), await salida(n2.notaId)]).toEqual([true, true]);
      const { rows: asientos } = await db.query<{ n: number }>(
        `select count(*)::int as n from asiento where origen_tipo = 'nota_entrega' and origen_id in ($1, $2)`, [n1.notaId, n2.notaId]);
      expect(asientos[0].n).toBe(2);
      const d = (await detalleTransporte(db, t))!;
      expect(d.estado).toBe('cargado');
      expect(d.cargado).not.toBeNull();

      // Cargado: ya no se tocan las paradas ni se anula; la salida de mercancía ya ocurrió.
      const extra = await nota(a01, [[pastilla, '1']]);
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: extra.notaId })), 'planificado');
      await esperarError(como(almacenista.id, (tx) => anularTransporte(tx, almacenista, t, 'Prueba')), 'planificado');
      await esperarError(como(almacenista.id, (tx) => quitarParada(tx, almacenista, d.paradas[0].id)), 'planificado');
      await esperarError(db.query('delete from transporte_parada where id = $1', [d.paradas[0].id]), 'planificado');
      await esperarError(como(almacenista.id, (tx) => registrarEntrega(tx, almacenista, d.paradas[0].id, { recibidoPor: 'Juan' })), 'en ruta');
      await esperarError(db.query(`update transporte set estado = 'entregado' where id = $1`, [t]), 'no pasa a');
      await esperarError(db.query(`update transporte set chofer = 'Otro' where id = $1`, [t]), 'planificado');
      await como(almacenista.id, (tx) => salirARuta(tx, almacenista, t));
    });

    it('un servicio de encomienda se carga sin vehículo ni chofer', async () => {
      const n = await nota(a01, [[pastilla, '1']]);
      const t = await nuevoTransporte({ transportistaId: courier, vehiculoId: undefined, chofer: undefined });
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: n.notaId }));
      await como(almacenista.id, (tx) => cargarTransporte(tx, almacenista, t));
      expect((await detalleTransporte(db, t))!.estado).toBe('cargado');
    });

    it('recorrido completo: llegadas, entrega, no entrega, cierre con flete, reprogramación e indicadores', async () => {
      // La sede principal recibe a cualquier hora de hoy; el depósito solo otro día.
      const hoyIso = (await db.query<{ d: number }>(`select extract(isodow from (now() at time zone 'America/Caracas'))::int as d`)).rows[0].d;
      const otroDia = (hoyIso % 7) + 1;
      await db.transaction(async (tx) => {
        await fijarVentanas(tx, dirPrincipal, [1, 2, 3, 4, 5, 6, 7].map((dia) => ({ dia, desde: '00:00', hasta: '23:59' })));
        await fijarVentanas(tx, dirDeposito, [{ dia: otroDia, desde: '08:00', hasta: '12:00' }]);
      });

      const t = await nuevoTransporte();
      const a = await nota(a01, [[pastilla, '10']]);
      const b = await nota(a01, [[pastilla, '4'], [aceite, '2']]);
      const pa = await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: a.notaId }));
      const pb = await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t, { notaId: b.notaId, direccionId: dirDeposito }));

      // Carga con las medidas del producto: 14 pastillas de 2,5 kg y 0,001 m³; el aceite no tiene medidas.
      let d = (await detalleTransporte(db, t))!;
      expect(d).toMatchObject({ peso_kg: '35.000', volumen_m3: '0.0140', lineas_sin_medidas: 1, excede_peso: true, excede_volumen: false });
      expect(d.capacidad_kg).toBe('30.00');

      await esperarError(como(almacenista.id, (tx) => registrarLlegada(tx, almacenista, pa)), 'en ruta');
      await como(almacenista.id, (tx) => cargarTransporte(tx, almacenista, t));
      await como(almacenista.id, (tx) => salirARuta(tx, almacenista, t));
      await esperarError(como(almacenista.id, (tx) => salirARuta(tx, almacenista, t)), 'cargado');
      await esperarError(db.query('update transporte_parada set orden = 9 where id = $1', [pa]), 'no se cambia el orden');

      await como(almacenista.id, (tx) => registrarLlegada(tx, almacenista, pa));
      await esperarError(como(almacenista.id, (tx) => registrarEntrega(tx, almacenista, pa, { recibidoPor: ' ' })), 'quién recibió');
      await como(almacenista.id, (tx) => registrarEntrega(tx, almacenista, pa, { recibidoPor: 'María Torres' }));
      await esperarError(como(almacenista.id, (tx) => registrarEntrega(tx, almacenista, pa, { recibidoPor: 'Otra persona' })), 'ya tiene su resultado');
      await esperarError(db.query(`update transporte_parada set recibido_por = 'Otro' where id = $1`, [pa]), 'no se modifica');
      expect((await detalleTransporte(db, t))!.estado).toBe('en_ruta');
      await esperarError(como(almacenista.id, (tx) => registrarNoEntrega(tx, almacenista, pb, 'no')), 'por qué');
      await como(almacenista.id, (tx) => registrarNoEntrega(tx, almacenista, pb, 'Local cerrado, nadie recibe'));

      // Con todas las paradas resueltas pasa solo a entregado.
      d = (await detalleTransporte(db, t))!;
      expect(d.estado).toBe('entregado');
      expect(d.paradas.map((p) => [p.resultado, p.en_ventana])).toEqual([['entregada', true], ['no_entregada', false]]);
      expect(d.paradas[0]).toMatchObject({ recibido_por: 'María Torres', vigente: true });
      expect(d.salida).not.toBeNull();

      await esperarError(como(almacenista.id, (tx) => cerrarTransporte(tx, almacenista, t, '12,5x')), 'flete');
      await como(almacenista.id, (tx) => cerrarTransporte(tx, almacenista, t, '12,5'));
      d = (await detalleTransporte(db, t))!;
      expect(d).toMatchObject({ estado: 'cerrado', flete_usd: '12.50' });
      await esperarError(db.query(`update transporte set flete_usd = 1 where id = $1`, [t]), 'cerrado no se modifica');

      // Indicadores de la vista (calculados una sola vez).
      const { rows } = await db.query<Record<string, string | number | boolean | null>>(
        `select paradas, entregadas, no_entregadas, con_incidencia, con_ventana, en_ventana, salio_en_fecha, (transito_seg is not null) as con_transito
           from vw_transporte_resumen where transporte_id = $1`, [t]);
      expect(rows[0]).toEqual({ paradas: 2, entregadas: 1, no_entregadas: 1, con_incidencia: 1, con_ventana: 2, en_ventana: 1, salio_en_fecha: true, con_transito: true });

      // La nota no entregada queda libre para otro transporte; la entregada no.
      const t2 = await nuevoTransporte();
      await como(almacenista.id, (tx) => agregarParada(tx, almacenista, t2, { notaId: b.notaId }));
      await esperarError(como(almacenista.id, (tx) => agregarParada(tx, almacenista, t2, { notaId: a.notaId })), 'ya está en otro transporte');
      await como(almacenista.id, (tx) => anularTransporte(tx, almacenista, t2, 'Prueba'));
    });

    it('la constancia de entrega es un adjunto de la parada (§4.2)', async () => {
      const { rows } = await db.query<{ id: string }>('select id from transporte_parada limit 1');
      const insertar = (entidad: string) => db.query(
        `insert into adjunto (entidad_tipo, entidad_id, nombre, tipo_contenido, tamano_bytes, hash_sha256, subido_por)
         values ('transporte_parada', $1, 'constancia.pdf', 'application/pdf', 10, repeat('a', 64), $2)`, [entidad, almacenista.id]);
      await insertar(rows[0].id);
      await esperarError(insertar('00000000-0000-0000-0000-000000000000'), 'no existe');
    });

    it('cada rol ve lo suyo: el almacenista solo los transportes de sus almacenes', async () => {
      const mios = await buscarTransportes(db, almacenista, {});
      expect(mios.length).toBeGreaterThan(0);
      expect(await buscarTransportes(db, otroAlmacenista, {})).toEqual(expect.not.arrayContaining(mios.filter((m) => m.almacen === '01')));
      expect((await buscarTransportes(db, otroAlmacenista, {})).every((t) => t.almacen === 'MOS')).toBe(true);
      expect((await buscarTransportes(db, gerente, {})).length).toBeGreaterThanOrEqual(mios.length);
      expect(await buscarTransportes(db, ventas, {})).toEqual([]);
      expect(await buscarTransportes(db, compras, {})).toEqual([]);
      expect(await notasDespachables(db, otroAlmacenista, a01)).toEqual([]);
    });
  });
});
