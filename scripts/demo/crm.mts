/**
 * CRM y postventa (spec §6.5, Fase 7): los vendedores registran visitas y llamadas, prospectan, cotizan y llevan cada
 * oportunidad por sus etapas hasta ganarla o perderla; al ganar con un prospecto, Gerencia aprueba su alta como cliente y
 * el pedido sale de la cotización. Los clientes abren reclamos, consultas y garantías que se atienden en unos días.
 * Usa un azar propio (ctx.estado.azarCrm) para no alterar la secuencia de los demás flujos.
 */
import { ErrorMaestro } from '../../src/lib/errores';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { abrirCaso, cambiarEstadoCaso, type TipoCaso } from '../../src/lib/crm/casos';
import { registrarActividad } from '../../src/lib/crm/contactos';
import { agregarLineaCotizacion, crearCotizacion, emitirCotizacion } from '../../src/lib/crm/cotizaciones';
import { avanzarOportunidad, crearOportunidad, ganarOportunidad, generarPedidoDeOportunidad, perderOportunidad } from '../../src/lib/crm/oportunidades';
import { registrarProspecto } from '../../src/lib/crm/prospectos';
import { rifDe } from './fundaciones.mts';
import { avisar, como, contar, programar, sumarDias, type Cliente, type Ctx } from './base.mts';

/** Cierra la venta de un pedido en borrador (operacion.mts → cerrarVenta). */
export type CerrarVenta = (cliente: Cliente, pedido: string, lineas: { productoId: string; cantidad: number }[], fecha: string) => Promise<void>;

const RESULTADOS = ['Revisamos su inventario de repuestos', 'Pidió precios de filtros y pastillas', 'Conforme con el último despacho', 'Comentó que la competencia bajó precios', 'Solicitó visita del vendedor la próxima semana'];
const ACCIONES = ['Enviar lista de precios', 'Llamar para confirmar pedido', 'Visitar con muestras', 'Enviar cotización'];
const PROSPECTOS = ['Taller', 'Repuestos', 'Autopartes', 'Lubricentro', 'Servicentro'];
const LUGARES = ['Los Llanos', 'El Tocuyo', 'Carora', 'Quíbor', 'Duaca', 'Sanare', 'Siquisique'];
const CASOS: { tipo: TipoCaso; descripcion: string; solucion: string }[] = [
  { tipo: 'reclamo', descripcion: 'El despacho llegó con un día de retraso', solucion: 'Se ajustó la ruta del transportista' },
  { tipo: 'consulta', descripcion: 'Pregunta si hay pastillas cerámicas para su flota', solucion: 'Se le envió la ficha de las cerámicas disponibles' },
  { tipo: 'garantia', descripcion: 'Un filtro presentó fuga a los pocos días de instalado', solucion: 'El proveedor reconoce la garantía: se repone en el próximo despacho' },
];

/** Gestiones de CRM de un día hábil. `stock`: disponible por producto, para cotizar lo que hay. */
export async function crmDelDia(ctx: Ctx, fecha: string, dia: number, stock: Map<string, number>, cerrar: CerrarVenta): Promise<void> {
  const azar = ctx.estado.azarCrm;
  // Visitas, llamadas y mensajes a clientes de la cartera.
  for (let i = azar.entero(1, 3); i > 0; i--) {
    const c = azar.elegir(ctx.clientes);
    const prox = azar() < 0.3;
    await registrarActividad(ctx.db, c.vendedorUsuario, {
      terceroId: c.id, tipo: azar.ponderado([['visita', 45], ['llamada', 35], ['mensaje', 20]] as const), resultado: azar.elegir(RESULTADOS),
      proximaAccion: prox ? azar.elegir(ACCIONES) : undefined, proximaFecha: prox ? sumarDias(fecha, 7) : undefined,
    });
    contar(ctx, 'actividades_crm');
  }
  // Lunes y jueves nace una oportunidad: con un prospecto nuevo o con un cliente.
  if (dia === 1 || dia === 4) await nuevaOportunidad(ctx, fecha, stock, cerrar);
  // Miércoles: un cliente abre un caso de postventa.
  if (dia === 3 && azar() < 0.6) await nuevoCaso(ctx, fecha);
}

async function nuevaOportunidad(ctx: Ctx, fecha: string, stock: Map<string, number>, cerrar: CerrarVenta): Promise<void> {
  const azar = ctx.estado.azarCrm;
  const base = azar.elegir(ctx.clientes);
  const vendedor = base.vendedorUsuario;
  let terceroId = base.id;
  let cliente: Cliente | null = base;
  if (azar() < 0.4) {
    const n = ++ctx.estado.prospectos;
    terceroId = await como(ctx, vendedor, (tx) => registrarProspecto(tx, vendedor, {
      rif: rifDe('J', 31_000_300 + n * 17),
      tercero: { razonSocial: `${azar.elegir(PROSPECTOS)} ${azar.elegir(LUGARES)} ${n}, C.A.`, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      origen: azar.elegir(['Referido', 'Visita en frío', 'Feria de repuestos', 'Redes sociales']),
    }));
    cliente = null;
    contar(ctx, 'prospectos');
  }
  const lineas = azar.barajar(ctx.productos.filter((p) => (stock.get(p.id) ?? 0) >= 6)).slice(0, azar.entero(1, 3))
    .map((p) => ({ productoId: p.id, cantidad: azar.entero(2, 6) }));
  if (!lineas.length) { avisar(ctx, 'CRM: sin existencia para cotizar'); return; }
  const op = await como(ctx, vendedor, (tx) => crearOportunidad(tx, vendedor, terceroId, {
    titulo: cliente ? 'Reposición de repuestos de alta rotación' : 'Primera compra', montoEstimadoUsd: String(azar.entero(2, 12) * 50),
    cierreEstimado: sumarDias(fecha, 7),
  }));
  contar(ctx, 'oportunidades');

  const paso = (dias: number, fn: (dia: string) => Promise<void>) => {
    const d = sumarDias(fecha, dias);
    if (d <= ctx.hasta) programar(ctx, d, async () => {
      try { await fn(d); } catch (e) {
        if (!(e instanceof ErrorMaestro)) throw e;
        avisar(ctx, `CRM: ${e.message}`);
      }
    });
  };
  paso(1, () => como(ctx, vendedor, (tx) => avanzarOportunidad(tx, vendedor, op)).then(() => undefined));
  paso(2, async (d) => {
    const cot = await como(ctx, vendedor, async (tx) => {
      const id = await crearCotizacion(tx, vendedor, { terceroId, almacenId: ctx.almacenId, listaPrecio: 'B' });
      for (const l of lineas) await agregarLineaCotizacion(tx, vendedor, id, { productoId: l.productoId, cantidad: String(l.cantidad) });
      await emitirCotizacion(tx, vendedor, id, sumarDias(d, 10));
      return id;
    });
    contar(ctx, 'cotizaciones');
    await como(ctx, vendedor, (tx) => avanzarOportunidad(tx, vendedor, op, { cotizacionId: cot }));
  });
  paso(4, () => como(ctx, vendedor, (tx) => avanzarOportunidad(tx, vendedor, op)).then(() => undefined));
  paso(6, async (d) => {
    if (azar() < 0.35) {
      const motivo = (await ctx.db.query<{ id: string }>(
        `select id from motivo where tipo = 'venta_perdida' and codigo = $1`, [azar.elegir(['PRECIO', 'PLAZO_ENTREGA', 'CONDICION_PAGO'])])).rows[0].id;
      await como(ctx, vendedor, (tx) => perderOportunidad(tx, vendedor, op, motivo));
      contar(ctx, 'oportunidades_perdidas');
      return;
    }
    const r = await como(ctx, vendedor, (tx) => ganarOportunidad(tx, vendedor, op));
    contar(ctx, 'oportunidades_ganadas');
    let pedido = r.pedidoId;
    let quien = cliente;
    if (r.clientePendiente) {
      // Gerencia aprueba el alta del nuevo cliente: de contado, lista B, sin descuento ni crédito.
      const contado = (await ctx.db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
      await como(ctx, ctx.u.gerencia, (tx) => resolverAprobacion(tx, 'cliente', terceroId, ctx.u.gerencia.id, 'aprobada', {
        datos: { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '0' },
      }));
      const { rows } = await ctx.db.query<{ codigo: string; razon_social: string }>(
        `select c.codigo, t.razon_social from cliente c join tercero t on t.id = c.tercero_id where c.tercero_id = $1`, [terceroId]);
      quien = { id: terceroId, codigo: rows[0].codigo, nombre: rows[0].razon_social, vendedorUsuario: vendedor, retrasoDias: 0, pagaEnDivisas: false, condicionDias: 0, agenteRetencion: false };
      ctx.clientes.push(quien);
      contar(ctx, 'prospectos_convertidos');
      pedido = (await como(ctx, vendedor, (tx) => generarPedidoDeOportunidad(tx, vendedor, op))).pedidoId;
    }
    if (pedido && quien) await cerrar(quien, pedido, lineas, d);
  });
}

async function nuevoCaso(ctx: Ctx, fecha: string): Promise<void> {
  const azar = ctx.estado.azarCrm;
  const { rows } = await ctx.db.query<{ id: string; cliente_id: string }>(
    `select id, cliente_id from documento_venta where tipo = 'factura' and estado = 'emitido' and not apertura
        and (fecha_emision at time zone 'America/Caracas')::date between $1::date - 20 and $1::date order by numero`, [fecha]);
  if (!rows.length) return;
  const f = azar.elegir(rows);
  const cliente = ctx.clientes.find((c) => c.id === f.cliente_id);
  if (!cliente) return;
  const quien = cliente.vendedorUsuario;
  const plantilla = azar.elegir(CASOS);
  const k = await como(ctx, quien, (tx) => abrirCaso(tx, quien, {
    clienteId: cliente.id, tipo: plantilla.tipo, facturaId: plantilla.tipo === 'consulta' ? null : f.id, descripcion: plantilla.descripcion,
  }));
  contar(ctx, 'casos_postventa');
  const resolver = sumarDias(fecha, azar.entero(1, 4));
  if (resolver <= ctx.hasta) programar(ctx, resolver, async () => {
    await como(ctx, quien, (tx) => cambiarEstadoCaso(tx, quien, k.id, 'en_analisis'));
    await como(ctx, quien, (tx) => cambiarEstadoCaso(tx, quien, k.id, 'resuelto', plantilla.solucion));
  });
  const cerrarCaso = sumarDias(resolver, 2);
  if (cerrarCaso <= ctx.hasta) programar(ctx, cerrarCaso, () => como(ctx, quien, (tx) => cambiarEstadoCaso(tx, quien, k.id, 'cerrado')));
}
