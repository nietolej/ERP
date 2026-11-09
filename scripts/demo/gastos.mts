/**
 * Gastos y notas del proveedor de la empresa ficticia (spec §7.3, §7.4, §9): facturas de proveedores de servicios (alquiler,
 * electricidad) con su soporte y la aprobación de Gerencia, caja chica con vales y reposiciones, y notas de crédito del
 * proveedor de mercancía (devolución y ajuste de precio).
 */
import { ErrorMaestro } from '../../src/lib/errores';
import { crearNota } from '../../src/lib/compras/notas-proveedor';
import { crearFondo, registrarVale, solicitarConstitucion, solicitarReposicion } from '../../src/lib/gastos/caja-chica';
import { crearGastoProveedor, listarCategorias } from '../../src/lib/gastos/gastos';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { avisar, como, contar, dinero, sumarDias, type Ctx } from './base.mts';

const TOPE_VALE = 9000;
const FONDO = 60_000;

/** PDF mínimo como soporte: el ERP exige adjuntar el comprobante y valida que sea PDF o imagen. */
const soporte = (ctx: Ctx) => {
  const n = ++ctx.estado.secuencia;
  return { almacen: ctx.archivos, nombre: `soporte-${n}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n% soporte demostración ${n}\n`) };
};

async function ids(ctx: Ctx) {
  const alicuotas = new Map((await ctx.db.query<{ codigo: string; id: string }>('select codigo, id from alicuota_iva')).rows.map((r) => [r.codigo, r.id]));
  return { general: alicuotas.get('GENERAL')!, exento: alicuotas.get('EXENTO')! };
}

/** Facturas mensuales de los proveedores de servicios: alquiler el día 3 (US$) y electricidad el día 12 (Bs). */
async function gastosDeProveedor(ctx: Ctx, fecha: string): Promise<void> {
  const dia = fecha.slice(8);
  if (dia !== '03' && dia !== '12') return;
  const { compras, gerencia } = ctx.u;
  const categorias = await listarCategorias(ctx.db, true);
  if (categorias.length < 2) throw new Error('Faltan categorías de gasto sembradas.');
  const a = await ids(ctx);
  const esAlquiler = dia === '03';
  const prov = ctx.proveedoresServicio[esAlquiler ? 0 : 1];
  const categoria = categorias[esAlquiler ? 0 : 1];
  const n = ++ctx.estado.secuencia;
  const g = await como(ctx, compras, (tx) => crearGastoProveedor(tx, compras, {
    proveedorId: prov.id, categoriaId: categoria.id, descripcion: esAlquiler ? `Alquiler del galpón, ${fecha.slice(0, 7)}` : `Consumo eléctrico, ${fecha.slice(0, 7)}`,
    numeroFactura: `GS-${String(n).padStart(5, '0')}`, numeroControl: `00-${String(600_000 + n).padStart(8, '0')}`, fechaFactura: fecha, fechaVencimiento: sumarDias(fecha, 15),
    moneda: esAlquiler ? 'USD' : 'VES', base: esAlquiler ? '1200.00' : dinero(ctx.azar.entero(900, 1700) * 100), alicuotaIvaId: esAlquiler ? a.exento : a.general,
  }, soporte(ctx)));
  await como(ctx, gerencia, (tx) => resolverAprobacion(tx, 'gasto_proveedor', g.id, gerencia.id, 'aprobada'));
  contar(ctx, 'gastos_de_proveedor');
}

/** Caja chica: se constituye el primer día hábil y se repone cuando lo gastado pasa del 60 % del fondo. */
async function cajaChica(ctx: Ctx, fecha: string, dia: number): Promise<void> {
  const { tesoreria, gerencia, } = ctx.u;
  if (!ctx.estado.fondoId) {
    const f = await como(ctx, gerencia, (tx) => crearFondo(tx, gerencia, { nombre: 'Caja chica administrativa', custodioId: tesoreria.id, cuentaBancariaId: ctx.cuentaCajaId, montoFijo: dinero(FONDO), topeVale: dinero(TOPE_VALE) }));
    const c = await como(ctx, tesoreria, (tx) => solicitarConstitucion(tx, tesoreria, f.id, ctx.cuentaVesId, 'Retiro para constituir la caja chica'));
    await como(ctx, gerencia, (tx) => resolverAprobacion(tx, 'reposicion_caja', c.id, gerencia.id, 'aprobada'));
    ctx.estado.fondoId = f.id;
    contar(ctx, 'fondos_de_caja_chica');
    return;
  }
  if (dia === 0) return;
  const a = await ids(ctx);
  const categorias = (await listarCategorias(ctx.db, true));
  if (ctx.azar() < 0.55) {
    const base = ctx.azar.entero(8, 74) * 100;                          // con IVA no pasa del tope por vale
    const exento = ctx.azar() < 0.3;
    const total = exento ? base : base * 1.16;
    try {
      await como(ctx, tesoreria, (tx) => registrarVale(tx, tesoreria, {
        fondoId: ctx.estado.fondoId!, fecha, categoriaId: ctx.azar.elegir(categorias).id, beneficiario: ctx.azar.elegir(['Ferretería El Tornillo', 'Papelería Central', 'Transporte Hermanos Pérez', 'Café y Más']),
        descripcion: ctx.azar.elegir(['Suministros de oficina', 'Flete menor', 'Artículos de limpieza', 'Refrigerio de personal']), comprobante: `V-${++ctx.estado.secuencia}`,
        control: ctx.azar() < 0.5 ? `00-${String(500_000 + ctx.estado.secuencia)}` : undefined, base: dinero(Math.min(base, TOPE_VALE / 1.16 - 1)), alicuotaIvaId: exento ? a.exento : a.general,
      }, soporte(ctx)));
      ctx.estado.valesSinReponer += Math.min(total, TOPE_VALE);
      contar(ctx, 'vales_de_caja_chica');
    } catch (e) {
      if (!(e instanceof ErrorMaestro)) throw e;
      avisar(ctx, `Vale de caja chica rechazado: ${e.message}`);
    }
  }
  if (ctx.estado.valesSinReponer > FONDO * 0.6) {
    const r = await como(ctx, tesoreria, (tx) => solicitarReposicion(tx, tesoreria, ctx.estado.fondoId!, ctx.cuentaVesId, 'Reposición de caja chica'));
    await como(ctx, gerencia, (tx) => resolverAprobacion(tx, 'reposicion_caja', r.id, gerencia.id, 'aprobada'));
    ctx.estado.valesSinReponer = 0;
    contar(ctx, 'reposiciones_de_caja');
  }
}

/** Cada miércoles, una nota de crédito de un proveedor de mercancía sobre una factura reciente aún por pagar. */
async function notasDeProveedor(ctx: Ctx, fecha: string): Promise<void> {
  const { db, azar, u } = ctx;
  const { rows } = await db.query<{ id: string; linea: string; cantidad: string; base: string; vencimiento: string }>(
    `select f.id, l.id as linea, l.cantidad::text, l.base::text, c.vencimiento::text
       from factura_compra f join partida_cxp c on c.factura_id = f.id join factura_compra_linea l on l.factura_id = f.id
      where f.estado = 'contabilizada' and c.estado = 'abierta' and f.fecha_factura >= $1::date - 10 and f.fecha_factura < $1::date order by f.fecha_factura, f.numero_factura, l.linea`, [fecha]);
  if (!rows.length) return;
  const l = azar.elegir(rows);
  const devolucion = azar() < 0.5;
  const n = ++ctx.estado.secuencia;
  try {
    const nota = await como(ctx, u.compras, (tx) => crearNota(tx, u.compras, {
      facturaId: l.id, tipo: 'nota_credito', clase: devolucion ? 'devolucion' : 'ajuste_precio', numeroDocumento: `NCP-${String(n).padStart(5, '0')}`,
      numeroControl: `00-${String(400_000 + n).padStart(8, '0')}`, fecha, motivo: devolucion ? 'Mercancía recibida con defecto' : 'Diferencia de precio acordada con el proveedor',
      lineas: [devolucion ? { facturaLineaId: l.linea, cantidad: String(Math.min(3, Number(l.cantidad))) } : { facturaLineaId: l.linea, monto: dinero(Number(l.base) * 0.03) }],
    }));
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'nota_proveedor', nota.id, u.gerencia.id, 'aprobada'));
    contar(ctx, devolucion ? 'notas_proveedor_devolucion' : 'notas_proveedor_ajuste');
  } catch (e) {
    if (!(e instanceof ErrorMaestro)) throw e;
    avisar(ctx, `Nota del proveedor rechazada: ${e.message}`);
  }
}

export async function gastosDelDia(ctx: Ctx, fecha: string, diaSemana: number): Promise<void> {
  await gastosDeProveedor(ctx, fecha);
  await cajaChica(ctx, fecha, diaSemana);
  if (diaSemana === 3) await notasDeProveedor(ctx, fecha);
}
