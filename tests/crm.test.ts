import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolverAprobacion } from '@/lib/flujo/objetos';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { actualizarParametro } from '@/lib/maestros/parametros-reportes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { abrirCaso, cambiarEstadoCaso, detalleCaso, enlazarNotaCredito, listarCasos } from '@/lib/crm/casos';
import { soloLoSuyo, terceroCrm } from '@/lib/crm/comun';
import { contactosDe, crearContacto, listarActividades, registrarActividad } from '@/lib/crm/contactos';
import {
  agregarLineaCotizacion, anularCotizacion, crearCotizacion, detalleCotizacion, emitirCotizacion, listarCotizaciones,
} from '@/lib/crm/cotizaciones';
import { actividadesPorVendedor, casosPorTipo, clientesSinContacto, conversion, embudo } from '@/lib/crm/indicadores';
import {
  avanzarOportunidad, crearOportunidad, detalleOportunidad, ganarOportunidad, generarPedidoDeOportunidad, listarOportunidades, perderOportunidad,
} from '@/lib/crm/oportunidades';
import { descartarProspecto, listarProspectos, reactivarProspecto, registrarProspecto } from '@/lib/crm/prospectos';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { crearNotaCredito, emitirNota, enviarAprobacion } from '@/lib/ventas/notas';
import { agregarLinea, crearPedido, detalleDocumento, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('CRM y postventa (§6.5, Fase 7, R-CR1 a R-CR6)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas1: Usuario;
  let ventas2: Usuario;
  let supervisor: Usuario;
  let gerente: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let auditor: Usuario;
  let mostrador: string;
  let vendedor1: string;
  let vendedor2: string;
  let cliente1: string;       // de vendedor1, nivel B, 5 % de descuento pactado
  let cliente2: string;       // de vendedor2
  let pastilla: string;       // A 9,00 · B 10,00 · IVA general
  let aceite: string;         // A 18,00 · B 20,00 · exento
  let hoy = '';
  let manana = '';
  let ayer = '';
  let motivoPrecio = '';
  let motivoOtro = '';
  let motivoVolumen = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
  const tercero = { domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false };

  /** Cotización emitida con las líneas indicadas. */
  async function cotizar(u: Usuario, terceroId: string, lineas: [string, string][], opciones: { lista?: string; vigencia?: string } = {}) {
    const id = await como(u, (tx) => crearCotizacion(tx, u, { terceroId, almacenId: mostrador, listaPrecio: opciones.lista }));
    for (const [p, c] of lineas) await como(u, (tx) => agregarLineaCotizacion(tx, u, id, { productoId: p, cantidad: c }));
    await como(u, (tx) => emitirCotizacion(tx, u, id, opciones.vigencia ?? manana));
    return id;
  }
  /** Oportunidad llevada hasta Negociación con su cotización. */
  async function enNegociacion(u: Usuario, terceroId: string, cot: string, titulo = 'Pastillas para la flota') {
    const id = await como(u, (tx) => crearOportunidad(tx, u, terceroId, { titulo, montoEstimadoUsd: '100' }));
    await como(u, (tx) => avanzarOportunidad(tx, u, id));
    await como(u, (tx) => avanzarOportunidad(tx, u, id, { cotizacionId: cot }));
    await como(u, (tx) => avanzarOportunidad(tx, u, id));
    return id;
  }

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const usuario = async (email: string, roles: string[]): Promise<Usuario> => ({ id: await usuarioDePrueba(db, email, roles), roles });
    gerente = await usuario('gerente@prueba.test', ['gerencia']);
    ventas1 = await usuario('ventas1@prueba.test', ['ventas']);
    ventas2 = await usuario('ventas2@prueba.test', ['ventas']);
    supervisor = await usuario('supervisor@prueba.test', ['supervisor_ventas']);
    facturacion = await usuario('facturacion@prueba.test', ['facturacion']);
    almacenista = await usuario('almacen@prueba.test', ['almacen']);
    auditor = await usuario('auditor@prueba.test', ['auditor']);
    motivoPrecio = (await db.query<{ id: string }>(`select id from motivo where tipo = 'venta_perdida' and codigo = 'PRECIO'`)).rows[0].id;
    motivoOtro = (await db.query<{ id: string }>(`select id from motivo where tipo = 'venta_perdida' and codigo = 'OTRO'`)).rows[0].id;
    motivoVolumen = (await db.query<{ id: string }>(`select id from motivo where tipo = 'descuento' and codigo = 'VOLUMEN'`)).rows[0].id;

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Distribuciones Hanei Motors, C.A.', 'Barquisimeto, Lara')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const f = (await db.query<{ h: string; m: string; a: string }>(
      `select fn_hoy_caracas()::text as h, (fn_hoy_caracas() + 1)::text as m, (fn_hoy_caracas() - 1)::text as a`)).rows[0];
    ({ h: hoy, m: manana, a: ayer } = f);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    mostrador = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, mostrador, [almacenista.id]));

    vendedor1 = (await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: ventas1.id }))).id;
    vendedor2 = (await db.transaction((tx) => crearVendedor(tx, gerente.id, { nombre: 'Ana Gómez', tipo: 'interno', usuarioId: ventas2.id }))).id;
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    const cliente = async (rif: string, nombre: string, vendedorId: string, descuento: string) => {
      const c = await db.transaction((tx) => crearCliente(tx, facturacion.id, { rif, tercero: { razonSocial: nombre, ...tercero }, comercial: { vendedorId } }));
      await db.transaction((tx) => aprobarCliente(tx, c.id, gerente.id, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: descuento }));
      return c.id;
    };
    cliente1 = await cliente('J-00000010-7', 'Repuestos Lara, C.A.', vendedor1, '5');
    cliente2 = await cliente('J-00000020-4', 'Autopartes Sur, C.A.', vendedor2, '0');

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const exento = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'EXENTO'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string, alicuota: string, a: string, b: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      const id = await db.transaction((tx) => crearProducto(tx, almacenista.id, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
      }));
      await db.transaction((tx) => fijarPrecio(tx, id, 'A', a, hoy));
      await db.transaction((tx) => fijarPrecio(tx, id, 'B', b, hoy));
      await como(almacenista, (tx) => tx.query(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
         values ('entrada_compra', $1, $2, 500, 4, 'prueba', gen_random_uuid())`, [id, mostrador]));
      return id;
    };
    pastilla = await nuevo('PF-001', general, '9.00', '10.00');
    aceite = await nuevo('AC-001', exento, '18.00', '20.00');
  });
  afterAll(() => cerrar());

  it('un prospecto es un tercero con RIF y vendedor, sin ficha de cliente: no se le puede pedir ni facturar', async () => {
    const id = await como(ventas1, (tx) => registrarProspecto(tx, ventas1, { rif: 'J-00000030-1', tercero: { razonSocial: 'Taller El Pistón', ...tercero }, origen: 'Visita' }));
    const t = (await terceroCrm(db, id))!;
    expect(t).toMatchObject({ es_cliente: false, es_prospecto: true, prospecto_estado: 'activo', vendedor_id: vendedor1 });
    // El vendedor queda asignado al suyo, aunque indique otro.
    await esperarError(como(ventas1, (tx) => registrarProspecto(tx, ventas1, { rif: 'J-00000030-1', tercero: { razonSocial: 'Otro', ...tercero } })), 'ya está registrado como prospecto');
    await esperarError(como(ventas1, (tx) => registrarProspecto(tx, ventas1, { rif: 'J-00000010-7', tercero: { razonSocial: 'Otro', ...tercero } })), 'ya es el cliente');
    await esperarError(como(ventas1, (tx) => registrarProspecto(tx, ventas1, { rif: 'J-0000003', tercero: { razonSocial: 'Taller Nuevo', ...tercero } })), 'RIF');
    // La base rechaza un prospecto que ya es cliente, aunque se salte la aplicación.
    await esperarError(como(gerente, (tx) => tx.query(`insert into prospecto (tercero_id, vendedor_id, created_by) values ($1, $2, $3)`, [cliente1, vendedor1, gerente.id])), 'ya es cliente');

    // Un prospecto no puede pedirse ni facturarse: no tiene ficha de cliente.
    await esperarError(como(ventas1, (tx) => crearPedido(tx, ventas1, { clienteId: id, almacenId: mostrador })), 'Seleccione el cliente');
    await expect(como(gerente, (tx) => tx.query(
      `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, created_by)
       select 'pedido', sucursal_id, id, $2, $3 from almacen where id = $1`, [mostrador, id, gerente.id]))).rejects.toThrow(/foreign key|llave foránea|violates/i);

    // Descartar exige motivo; se puede reactivar.
    await esperarError(como(ventas1, (tx) => descartarProspecto(tx, ventas1, id, '')), 'por qué');
    await como(ventas1, (tx) => descartarProspecto(tx, ventas1, id, 'Cerró el taller'));
    await esperarError(como(ventas1, (tx) => crearOportunidad(tx, ventas1, id, { titulo: 'Algo', montoEstimadoUsd: '0' })), 'prospecto activo');
    await como(ventas1, (tx) => reactivarProspecto(tx, ventas1, id));
    expect((await terceroCrm(db, id))!.prospecto_estado).toBe('activo');
  });

  it('seguridad por fila: un vendedor no ve ni trabaja el CRM de otro; Supervisor y Auditor ven todo', async () => {
    const id = await como(ventas2, (tx) => registrarProspecto(tx, ventas2, { rif: 'J-00000040-9', tercero: { razonSocial: 'Frenos del Centro', ...tercero } }));
    const op = await como(ventas2, (tx) => crearOportunidad(tx, ventas2, id, { titulo: 'Frenos de la flota', montoEstimadoUsd: '500' }));
    await registrarActividad(db, ventas2, { terceroId: id, tipo: 'llamada', resultado: 'Pide visita' });

    expect(soloLoSuyo(ventas1)).toBe(true);
    expect(soloLoSuyo(supervisor)).toBe(false);
    expect((await listarProspectos(db, ventas1)).map((p) => p.id)).not.toContain(id);
    expect((await listarProspectos(db, ventas2)).map((p) => p.id)).toContain(id);
    expect((await listarProspectos(db, supervisor)).map((p) => p.id)).toContain(id);
    expect((await listarOportunidades(db, ventas1)).map((o) => o.id)).not.toContain(op);
    expect((await listarOportunidades(db, auditor)).map((o) => o.id)).toContain(op);
    expect((await listarActividades(db, ventas1)).some((a) => a.tercero_id === id)).toBe(false);
    expect((await listarActividades(db, ventas2)).some((a) => a.tercero_id === id)).toBe(true);

    await esperarError(como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op)), 'otro vendedor');
    await esperarError(como(ventas1, (tx) => crearOportunidad(tx, ventas1, id, { titulo: 'Intruso', montoEstimadoUsd: '1' })), 'otro vendedor');
    await esperarError(registrarActividad(db, ventas1, { terceroId: id, tipo: 'visita', resultado: 'Nada' }), 'otro vendedor');
    await esperarError(como(ventas1, (tx) => crearContacto(tx, ventas1, id, { nombre: 'Juan' })), 'otro vendedor');
    await esperarError(como(ventas1, (tx) => crearCotizacion(tx, ventas1, { terceroId: cliente2, almacenId: mostrador })), 'otro vendedor');
    // El supervisor sí trabaja la oportunidad de cualquier vendedor.
    expect(await como(supervisor, (tx) => avanzarOportunidad(tx, supervisor, op))).toBe('calificada');
  });

  it('contactos: uno solo principal por tercero; correo validado', async () => {
    await como(ventas1, (tx) => crearContacto(tx, ventas1, cliente1, { nombre: 'María Rodríguez', cargo: 'Compras', principal: true }));
    await como(ventas1, (tx) => crearContacto(tx, ventas1, cliente1, { nombre: 'José Lara', correo: 'jose@lara.test', principal: true }));
    const c = await contactosDe(db, cliente1);
    expect(c.filter((x) => x.principal).map((x) => x.nombre)).toEqual(['José Lara']);
    await esperarError(como(ventas1, (tx) => crearContacto(tx, ventas1, cliente1, { nombre: 'Malo', correo: 'no-es-correo' })), 'formato');
  });

  it('cotización: precio de la lista, numerada al emitir, sin editarse después; el prospecto elige lista', async () => {
    // Cliente: su lista (B) y su descuento pactado (5 %) por omisión.
    const c = await como(ventas1, (tx) => crearCotizacion(tx, ventas1, { terceroId: cliente1, almacenId: mostrador }));
    await como(ventas1, (tx) => agregarLineaCotizacion(tx, ventas1, c, { productoId: pastilla, cantidad: '10' }));
    await esperarError(como(ventas1, (tx) => agregarLineaCotizacion(tx, ventas1, c, { productoId: aceite, cantidad: '1', descuentoPct: '12' })), 'motivo del descuento');
    await como(ventas1, (tx) => agregarLineaCotizacion(tx, ventas1, c, { productoId: aceite, cantidad: '2', descuentoPct: '12', motivoDescuentoId: motivoVolumen }));
    let d = (await detalleCotizacion(db, c))!;
    // Pastilla 10 × 10 − 5 % = 95,00 + IVA 16 % 15,20; aceite 2 × 20 − 12 % = 35,20 exento.
    expect(d).toMatchObject({ estado: 'borrador', numero: null, lista_precio: 'B', base_imponible: '95.00', exento: '35.20', iva: '15.20', total: '145.40', total_ves: '5816.00' });
    expect(d.lineas.map((l) => [l.precio_unitario, l.descuento_pct])).toEqual([['10.0000', '5.00'], ['20.0000', '12.00']]);

    await esperarError(como(ventas1, (tx) => emitirCotizacion(tx, ventas1, c, ayer)), 'vigencia');
    const n1 = await como(ventas1, (tx) => emitirCotizacion(tx, ventas1, c, manana));
    expect(n1).toBe('1');
    d = (await detalleCotizacion(db, c))!;
    expect(d).toMatchObject({ estado: 'emitida', tasa: '40.000000', vencida: false });
    await esperarError(como(ventas1, (tx) => agregarLineaCotizacion(tx, ventas1, c, { productoId: pastilla, cantidad: '1' })), 'borrador');
    await esperarError(como(gerente, (tx) => tx.query(`update cotizacion set total = 1 where id = $1`, [c])), 'no se edita');
    await esperarError(como(gerente, (tx) => tx.query(`update cotizacion_linea set cantidad = 1 where cotizacion_id = $1`, [c])), 'no se modifican');
    await esperarError(como(gerente, (tx) => tx.query(`delete from cotizacion where id = $1`, [c])), 'no se borra');

    // Prospecto: elige la lista, sin descuento pactado.
    const p = await como(ventas1, (tx) => registrarProspecto(tx, ventas1, { rif: 'J-00000050-6', tercero: { razonSocial: 'Lubricantes Oeste', ...tercero } }));
    await esperarError(como(ventas1, (tx) => crearCotizacion(tx, ventas1, { terceroId: p, almacenId: mostrador })), 'lista de precio');
    const q = await cotizar(ventas1, p, [[pastilla, '3']], { lista: 'A' });
    expect((await detalleCotizacion(db, q))!).toMatchObject({ numero: '2', lista_precio: 'A', base_imponible: '27.00', total: '31.32', prospecto: true });

    // Anular exige motivo; los números no se reutilizan.
    await esperarError(como(ventas1, (tx) => anularCotizacion(tx, ventas1, q, '')), 'motivo');
    await como(ventas1, (tx) => anularCotizacion(tx, ventas1, q, 'Cambió de proveedor'));
    expect((await listarCotizaciones(db, ventas1, { terceroId: p }))[0]).toMatchObject({ estado: 'anulada', numero: '2' });
  });

  it('las etapas avanzan una a una; Cotizada exige cotización emitida del mismo tercero; Perdida exige motivo', async () => {
    const op = await como(ventas1, (tx) => crearOportunidad(tx, ventas1, cliente1, { titulo: 'Aceite para el taller', montoEstimadoUsd: '300', cierreEstimado: manana }));
    // La base impide saltar etapas o nacer avanzada.
    await esperarError(como(gerente, (tx) => tx.query(`update oportunidad set etapa = 'negociacion' where id = $1`, [op])), 'una a una');
    await esperarError(como(gerente, (tx) => tx.query(
      `insert into oportunidad (titulo, tercero_id, vendedor_id, etapa, created_by) values ('x y z', $1, $2, 'calificada', $3)`, [cliente1, vendedor1, gerente.id])), 'Prospecto');
    expect(await como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op))).toBe('calificada');
    await esperarError(como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op)), 'cotización emitida');

    const borrador = await como(ventas1, (tx) => crearCotizacion(tx, ventas1, { terceroId: cliente1, almacenId: mostrador }));
    await esperarError(como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op, { cotizacionId: borrador })), 'emitida');
    const ajena = await cotizar(supervisor, cliente2, [[aceite, '1']]);
    await esperarError(como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op, { cotizacionId: ajena })), 'mismo cliente');
    const cot = await cotizar(ventas1, cliente1, [[aceite, '5']]);
    expect(await como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op, { cotizacionId: cot }))).toBe('cotizada');
    // El monto estimado toma el total de la cotización: 5 × 20 − 5 % = 95,00.
    expect((await detalleOportunidad(db, op))!).toMatchObject({ etapa: 'cotizada', monto_estimado_usd: '95.00', cotizacion_numero: expect.any(String) });
    // Una cotización enlazada a una oportunidad abierta no se anula.
    await esperarError(como(ventas1, (tx) => anularCotizacion(tx, ventas1, cot, 'Error de precio')), 'oportunidad abierta');

    await esperarError(como(ventas1, (tx) => perderOportunidad(tx, ventas1, op, motivoOtro)), 'Explique');
    await como(ventas1, (tx) => perderOportunidad(tx, ventas1, op, motivoPrecio, 'La competencia dio 10 % menos'));
    expect((await detalleOportunidad(db, op))!).toMatchObject({ etapa: 'perdida', motivo_perdida: 'Precio más alto que la competencia · La competencia dio 10 % menos' });
    // Cerrada: no cambia.
    await esperarError(como(ventas1, (tx) => avanzarOportunidad(tx, ventas1, op)), 'cerrada');
    await esperarError(como(gerente, (tx) => tx.query(`update oportunidad set monto_estimado_usd = 1 where id = $1`, [op])), 'cerrada no se modifica');
    await esperarError(como(gerente, (tx) => tx.query(`delete from oportunidad where id = $1`, [op])), 'no se borra');
  });

  it('ganar con un cliente activo genera el pedido en borrador desde la cotización', async () => {
    const cot = await cotizar(ventas1, cliente1, [[pastilla, '4'], [aceite, '2']]);
    const op = await enNegociacion(ventas1, cliente1, cot);
    const r = await como(ventas1, (tx) => ganarOportunidad(tx, ventas1, op));
    expect(r).toMatchObject({ clientePendiente: false, difiereDeCotizacion: false });
    const ped = (await detalleDocumento(db, r.pedidoId!))!;
    expect(ped).toMatchObject({ tipo: 'pedido', estado: 'borrador', cliente_id: cliente1 });
    expect(ped.lineas.map((l) => [l.cantidad, l.descuento_pct])).toEqual([['4.0000', '5.00'], ['2.0000', '5.00']]);
    expect((await detalleCotizacion(db, cot))!).toMatchObject({ estado: 'convertida', pedido_id: r.pedidoId });
    expect((await detalleOportunidad(db, op))!).toMatchObject({ etapa: 'ganada', pedido_id: r.pedidoId });
    await esperarError(como(ventas1, (tx) => generarPedidoDeOportunidad(tx, ventas1, op)), 'ya generó');
    // El pedido no se cambia por otro.
    await esperarError(como(gerente, (tx) => tx.query(`update oportunidad set pedido_id = null where id = $1`, [op])), 'cerrada no se modifica');
  });

  it('ganar con un prospecto lo registra como cliente pendiente; el pedido se genera cuando Gerencia lo aprueba', async () => {
    const p = await como(ventas1, (tx) => registrarProspecto(tx, ventas1, { rif: 'J-00000060-3', tercero: { razonSocial: 'Transporte Llano', ...tercero } }));
    const cot = await cotizar(ventas1, p, [[pastilla, '10']], { lista: 'B' });
    const op = await enNegociacion(ventas1, p, cot, 'Primera compra');
    const r = await como(ventas1, (tx) => ganarOportunidad(tx, ventas1, op));
    expect(r).toEqual({ pedidoId: null, clientePendiente: true, difiereDeCotizacion: false });
    const t = (await terceroCrm(db, p))!;
    expect(t).toMatchObject({ es_cliente: true, cliente_estado: 'pendiente', prospecto_estado: 'convertido', vendedor_id: vendedor1 });
    const { rows: sol } = await db.query<{ estado: string }>(`select estado from solicitud_aprobacion where objeto_tipo = 'cliente' and objeto_id = $1`, [p]);
    expect(sol[0]?.estado).toBe('pendiente');
    await esperarError(como(ventas1, (tx) => generarPedidoDeOportunidad(tx, ventas1, op)), 'Gerencia apruebe');
    // Un convertido no vuelve a prospecto.
    await esperarError(como(gerente, (tx) => tx.query(`update prospecto set estado = 'activo' where tercero_id = $1`, [p])), 'convertido');

    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    await como(gerente, (tx) => resolverAprobacion(tx, 'cliente', p, gerente.id, 'aprobada', {
      datos: { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'A', descuentoPct: '0' },
    }));
    const g = await como(ventas1, (tx) => generarPedidoDeOportunidad(tx, ventas1, op));
    // Gerencia le dio la lista A (9,00) y se cotizó con la B (10,00): el pedido avisa que no suma lo mismo.
    expect(g.difiereDeCotizacion).toBe(true);
    const ped = (await detalleDocumento(db, g.pedidoId))!;
    expect(ped.lineas[0]).toMatchObject({ cantidad: '10.0000', precio_unitario: '9.0000' });
  });

  it('una cotización vencida no gana la oportunidad', async () => {
    const cot = await cotizar(ventas1, cliente1, [[aceite, '1']], { vigencia: hoy });
    const op = await enNegociacion(ventas1, cliente1, cot, 'Vence hoy');
    await db.query(`alter table cotizacion disable trigger cotizacion_antes`);
    await db.query(`update cotizacion set vigente_hasta = $2 where id = $1`, [cot, ayer]);
    await db.query(`alter table cotizacion enable trigger cotizacion_antes`);
    await esperarError(como(ventas1, (tx) => ganarOportunidad(tx, ventas1, op)), 'venció');
  });

  it('las actividades son hechos: no se editan ni se borran', async () => {
    const id = await registrarActividad(db, ventas1, { terceroId: cliente1, tipo: 'visita', resultado: 'Revisamos el inventario del taller', proximaAccion: 'Enviar cotización', proximaFecha: manana });
    await esperarError(registrarActividad(db, ventas1, { terceroId: cliente1, tipo: 'llamada' }), 'resultado');
    await esperarError(db.query(`update actividad_crm set resultado = 'otro' where id = $1`, [id]), 'no se modifica');
    await esperarError(db.query(`delete from actividad_crm where id = $1`, [id]), 'no se modifica');
    expect((await listarActividades(db, ventas1, { terceroId: cliente1 }))[0]).toMatchObject({ tipo: 'visita', proxima_accion: 'Enviar cotización' });
  });

  it('caso de devolución: nace de una factura, no mueve inventario y se resuelve solo con su NC por devolución emitida', async () => {
    // Factura de 2 pastillas al cliente2.
    const pedido = await como(ventas2, (tx) => crearPedido(tx, ventas2, { clienteId: cliente2, almacenId: mostrador }));
    await como(ventas2, (tx) => agregarLinea(tx, ventas2, pedido, { productoId: pastilla, cantidad: '2' }));
    await como(ventas2, (tx) => emitirPedido(tx, ventas2, pedido));
    const nota = await como(ventas2, (tx) => generarNotaEntrega(tx, ventas2, pedido));
    await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
    const fac = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));
    const linea = (await db.query<{ id: string }>('select id from documento_venta_linea where documento_id = $1', [fac.facturaId])).rows[0].id;
    const existencia = async () => (await db.query<{ c: string }>('select cantidad::text as c from existencia where producto_id = $1 and almacen_id = $2', [pastilla, mostrador])).rows[0].c;

    await esperarError(como(ventas2, (tx) => abrirCaso(tx, ventas2, { clienteId: cliente2, tipo: 'devolucion', descripcion: 'Llegaron dañadas' })), 'factura');
    await esperarError(como(ventas1, (tx) => abrirCaso(tx, ventas1, { clienteId: cliente2, tipo: 'reclamo', descripcion: 'No es mío' })), 'cartera');
    await esperarError(como(ventas2, (tx) => abrirCaso(tx, ventas2, { clienteId: cliente1, tipo: 'reclamo', descripcion: 'Factura de otro', facturaId: fac.facturaId })), 'cartera');
    const antes = await existencia();
    const k = await como(ventas2, (tx) => abrirCaso(tx, ventas2, { clienteId: cliente2, tipo: 'devolucion', facturaId: fac.facturaId, descripcion: 'Una pastilla llegó dañada' }));
    expect(await existencia()).toBe(antes);
    expect((await listarCasos(db, ventas1)).map((c) => c.id)).not.toContain(k.id);

    await como(ventas2, (tx) => cambiarEstadoCaso(tx, ventas2, k.id, 'en_analisis'));
    await esperarError(como(ventas2, (tx) => cambiarEstadoCaso(tx, ventas2, k.id, 'resuelto', 'Se acredita la pieza')), 'nota de crédito');
    await esperarError(como(ventas2, (tx) => enlazarNotaCredito(tx, ventas2, k.id, fac.facturaId)), 'nota de crédito por devolución');

    const motivoDev = (await db.query<{ id: string }>(`select id from motivo where tipo = 'devolucion' and codigo = 'DEFECTO'`)).rows[0].id;
    const nc = await como(ventas2, (tx) => crearNotaCredito(tx, ventas2, { facturaId: fac.facturaId, clase: 'devolucion', motivoId: motivoDev, lineas: [{ lineaId: linea, cantidad: '1' }] }));
    await como(ventas2, (tx) => enlazarNotaCredito(tx, ventas2, k.id, nc));
    // Enlazada pero sin emitir: todavía no se resuelve.
    await esperarError(como(ventas2, (tx) => cambiarEstadoCaso(tx, ventas2, k.id, 'resuelto', 'Se acredita la pieza')), 'emitida');
    await como(ventas2, (tx) => enviarAprobacion(tx, ventas2, nc));
    await como(supervisor, (tx) => resolverAprobacion(tx, 'nota_credito', nc, supervisor.id, 'aprobada'));
    await como(facturacion, (tx) => emitirNota(tx, facturacion, nc, { servicio: new ImprentaSimulada() }));
    await como(ventas2, (tx) => cambiarEstadoCaso(tx, ventas2, k.id, 'resuelto', 'Se acredita la pieza'));
    await como(ventas2, (tx) => cambiarEstadoCaso(tx, ventas2, k.id, 'cerrado'));
    const d = (await detalleCaso(db, k.id))!;
    expect(d).toMatchObject({ estado: 'cerrado', nota_numero: expect.any(String), solucion: 'Se acredita la pieza' });
    expect(d.resuelto).not.toBeNull();
    await esperarError(como(ventas2, (tx) => cambiarEstadoCaso(tx, ventas2, k.id, 'en_analisis')), 'cerrado');
  });

  it('caso sin factura: estados en orden y la solución obligatoria al resolver', async () => {
    const k = await como(facturacion, (tx) => abrirCaso(tx, facturacion, { clienteId: cliente1, tipo: 'consulta', descripcion: '¿Tienen pastillas cerámicas?' }));
    await esperarError(como(facturacion, (tx) => cambiarEstadoCaso(tx, facturacion, k.id, 'cerrado')), 'no pasa a');
    await esperarError(como(facturacion, (tx) => cambiarEstadoCaso(tx, facturacion, k.id, 'resuelto')), 'solución');
    await como(facturacion, (tx) => cambiarEstadoCaso(tx, facturacion, k.id, 'resuelto', 'Sí, llegan el mes próximo'));
    await esperarError(como(gerente, (tx) => tx.query(`update caso_postventa set tipo = 'reclamo' where id = $1`, [k.id])), 'no cambian');
    await esperarError(como(gerente, (tx) => tx.query(`delete from caso_postventa where id = $1`, [k.id])), 'no se borra');
  });

  it('indicadores: embudo ponderado por el parámetro, conversión, actividades, clientes sin contacto y resolución de casos', async () => {
    const e = await embudo(db, supervisor);
    for (const f of e) expect(f.ponderado_usd).toBe((Math.round(Number(f.monto_usd) * Number(f.probabilidad_pct)) / 100).toFixed(2));
    const calificadas = e.find((f) => f.etapa === 'calificada')!;
    expect(calificadas).toMatchObject({ oportunidades: 1, monto_usd: '500.00', probabilidad_pct: '25.0000', ponderado_usd: '125.00' });
    // La probabilidad es un parámetro editable: cambia el valor ponderado.
    await como(gerente, (tx) => actualizarParametro(tx, 'reporte', 'CRM_PROB_CALIFICADA_PCT', '40'));
    expect((await embudo(db, supervisor)).find((f) => f.etapa === 'calificada')!.ponderado_usd).toBe('200.00');
    // El vendedor 1 no ve en su embudo la oportunidad calificada del vendedor 2.
    expect((await embudo(db, ventas1)).find((f) => f.etapa === 'calificada')).toBeUndefined();

    const conv = await conversion(db, supervisor, hoy, hoy);
    // Vendedor 1: 2 ganadas (cliente y prospecto), 1 perdida → 66,67 %.
    expect(conv.find((c) => c.vendedor === 'Pedro Pérez')).toMatchObject({ ganadas: 2, perdidas: 1, tasa_pct: '66.67' });
    expect(await conversion(db, ventas2, hoy, hoy)).toEqual([]);

    const act = await actividadesPorVendedor(db, supervisor, hoy, hoy);
    expect(act.find((a) => a.usuario === 'Pedro Pérez')).toMatchObject({ visitas: 1, total: 1 });
    expect(act.find((a) => a.usuario === 'Ana Gómez')).toMatchObject({ llamadas: 1, total: 1 });

    // Sin contacto: con 30 días ninguno (recién aprobados); con 1 día y el cliente2 aprobado hace 2 días, aparece.
    expect((await clientesSinContacto(db, supervisor)).filas).toEqual([]);
    await db.query(`alter table cliente disable trigger cliente_antes`);
    await db.query(`update cliente set aprobado_at = now() - interval '2 days' where tercero_id = $1`, [cliente2]);
    await db.query(`alter table cliente enable trigger cliente_antes`);
    await como(gerente, (tx) => actualizarParametro(tx, 'reporte', 'CRM_SIN_CONTACTO_DIAS', '1'));
    const sc = await clientesSinContacto(db, supervisor);
    expect(sc.dias).toBe(1);
    expect(sc.filas.map((f) => f.cliente_id)).toEqual([cliente2]);
    expect((await clientesSinContacto(db, ventas1)).filas).toEqual([]);

    const casos = await casosPorTipo(db, hoy, hoy);
    expect(casos.find((c) => c.tipo === 'devolucion')).toMatchObject({ resueltos: 1, pendientes: 0 });
    expect(casos.find((c) => c.tipo === 'consulta')).toMatchObject({ resueltos: 1, pendientes: 0 });
  });
});
