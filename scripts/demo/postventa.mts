/**
 * Notas de crédito y de débito sobre facturas de venta (spec §6.3): devoluciones de mercancía, descuentos comerciales posteriores
 * y cargos por intereses de mora. Las crea quien vende (su cartera), las aprueba el Supervisor de ventas por el motor de flujo
 * y las emite Facturación con número de control.
 */
import { ErrorMaestro } from '../../src/lib/errores';
import { ImprentaSimulada } from '../../src/lib/fiscal/imprenta';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { crearNotaCredito, crearNotaDebito, emitirNota, enviarAprobacion, lineasFacturables } from '../../src/lib/ventas/notas';
import { avisar, como, contar, dinero, type Ctx } from './base.mts';

interface FacturaAbierta { id: string; cliente_id: string; saldo: string; vencida: boolean }

/** Facturas de los últimos 25 días con saldo por cobrar (no de apertura). */
async function facturasAbiertas(ctx: Ctx, fecha: string): Promise<FacturaAbierta[]> {
  const { rows } = await ctx.db.query<FacturaAbierta>(
    `select d.id, d.cliente_id, p.saldo::text, (p.vencimiento < $1::date) as vencida
       from partida_cxc p join documento_venta d on d.id = p.documento_id
      where p.estado = 'abierta' and not d.apertura and d.tipo = 'factura' and p.fecha >= $1::date - 25
        and not exists (select 1 from documento_venta n where n.documento_origen_id = d.id and n.tipo in ('nota_credito', 'nota_debito') and n.estado = 'borrador')
      order by p.fecha, d.numero`, [fecha]);
  return rows;
}

async function emitir(ctx: Ctx, tipo: 'nota_credito' | 'nota_debito', id: string, creador: Ctx['u'][string]): Promise<void> {
  const { u } = ctx;
  await como(ctx, creador, (tx) => enviarAprobacion(tx, creador, id));
  await como(ctx, u.supervisor_ventas, (tx) => resolverAprobacion(tx, tipo, id, u.supervisor_ventas.id, 'aprobada'));
  await como(ctx, u.facturacion, (tx) => emitirNota(tx, u.facturacion, id, { servicio: new ImprentaSimulada() }));
}

export async function notasDeVenta(ctx: Ctx, fecha: string): Promise<void> {
  const { azar, db } = ctx;
  const motivos = new Map((await db.query<{ clave: string; id: string }>(
    `select tipo || ':' || codigo as clave, id from motivo where (tipo = 'devolucion' and codigo = 'DEFECTO') or (tipo = 'descuento' and codigo = 'VOLUMEN')`)).rows.map((r) => [r.clave, r.id]));
  const hechas = azar.ponderado([[0, 55], [1, 35], [2, 10]] as const);

  for (let i = 0; i < hechas; i++) {
    const abiertas = await facturasAbiertas(ctx, fecha);
    if (!abiertas.length) return;
    const f = azar.elegir(abiertas);
    const cliente = ctx.clientes.find((c) => c.id === f.cliente_id)!;
    const creador = cliente.vendedorUsuario;
    const clase = azar.ponderado([['devolucion', 50], ['descuento', 20], ['intereses', 30]] as const);
    try {
      if (clase === 'devolucion') {
        const lineas = (await lineasFacturables(db, f.id)).filter((l) => l.inventariable && Number(l.disponible) >= 1);
        if (!lineas.length) continue;
        const l = azar.elegir(lineas);
        const id = await como(ctx, creador, (tx) => crearNotaCredito(tx, creador, {
          facturaId: f.id, clase: 'devolucion', motivoId: motivos.get('devolucion:DEFECTO'), observaciones: 'Producto con defecto de fábrica', lineas: [{ lineaId: l.id, cantidad: '1' }],
        }));
        await emitir(ctx, 'nota_credito', id, creador);
        contar(ctx, 'notas_credito_devolucion');
      } else if (clase === 'descuento') {
        const id = await como(ctx, creador, (tx) => crearNotaCredito(tx, creador, {
          facturaId: f.id, clase: 'descuento_comercial', motivoId: motivos.get('descuento:VOLUMEN'), porcentaje: String(azar.ponderado([[3, 50], [5, 35], [8, 15]] as const)),
        }));
        await emitir(ctx, 'nota_credito', id, creador);
        contar(ctx, 'notas_credito_descuento');
      } else {
        // Intereses por mora: solo sobre una factura vencida.
        const vencida = abiertas.filter((x) => x.vencida);
        if (!vencida.length) continue;
        const v = azar.elegir(vencida);
        const cli = ctx.clientes.find((c) => c.id === v.cliente_id)!.vendedorUsuario;
        const id = await como(ctx, cli, (tx) => crearNotaDebito(tx, cli, {
          facturaId: v.id, motivo: 'intereses', observaciones: 'Intereses por mora', lineas: [{ productoId: ctx.productoIntereses, cantidad: '1', precio: dinero(Number(v.saldo) * 0.015) }],
        }));
        await emitir(ctx, 'nota_debito', id, cli);
        contar(ctx, 'notas_debito_intereses');
      }
    } catch (e) {
      if (!(e instanceof ErrorMaestro)) throw e;
      avisar(ctx, `Nota de venta rechazada: ${e.message}`);
      if (process.env.DEMO_DEBUG) console.log(`[${fecha}] ${clase}: ${e.message}`);
    }
  }
}
