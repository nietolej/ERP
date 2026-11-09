/**
 * Producción (ensamblaje de kits) y ajustes de inventario de la empresa ficticia (spec §8.3, §8.4).
 *
 * - Kits: dos productos terminados que Almacén ensambla con repuestos que ya están en el almacén. La orden la crea Almacén,
 *   la libera Gerencia, se pone en proceso y se termina (los componentes salen al costo promedio y el kit entra por la suma).
 *   Una de cada seis la rechaza Gerencia; si falta algún componente, Almacén la anula con su motivo.
 * - Ajustes: cada viernes por la tarde Almacén cuenta algunos productos, otra persona (Compras) figura como quien contó y
 *   Gerencia aprueba; faltantes y sobrantes se contabilizan con su motivo del catálogo de mermas.
 */
import { ErrorMaestro } from '../../src/lib/errores';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { crearAjuste, enviarAjuste, guardarLinea as guardarLineaAjuste } from '../../src/lib/inventario/ajustes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '../../src/lib/maestros/productos';
import { anularOrden, crearOrden, enviarOrden, faltantesDe, guardarComponente, iniciarOrden, terminarOrden } from '../../src/lib/produccion/ordenes';
import { avisar, como, contar, type Ctx } from './base.mts';

// [código, descripción, [código del componente (sin marca), cantidad por kit]…]. Los componentes son de la marca Andina.
const KITS = [
  { codigo: 'KIT-FRENO-DEL', descripcion: 'Kit de frenos delanteros (pastillas y disco)', componentes: [['PF-DEL', 2], ['DI-DEL', 2]] as const },
  { codigo: 'KIT-SERV-MOTOR', descripcion: 'Kit de servicio de motor (filtros y bujías)', componentes: [['FI-ACE', 1], ['FI-AIR', 1], ['FI-COM', 1], ['BU-IRI', 1]] as const },
] as const;

const MARCA_COMPONENTES = 'ANDINA';

/** Día 0: crea los kits como productos inventariables con su precio de venta (sin existencia hasta que se produzcan). */
export async function sembrarKits(ctx: Ctx, desde: string): Promise<void> {
  const { db, u } = ctx;
  const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'ENSAMBLE', 'Kits ensamblados'));
  const iva = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
  for (const k of KITS) {
    const base = await db.transaction((tx) => resolverProductoBase(tx, k.codigo, { descripcion: k.descripcion }));
    const id = await db.transaction((tx) => crearProducto(tx, u.almacen.id, `${k.codigo}`, {
      descripcion: k.descripcion, productoBaseId: base.id, marcaId: marca, unidad: 'jgo', alicuotaIvaId: iva, inventariable: true,
    }));
    const componentes = k.componentes.map(([c, cantidad]) => {
      const p = ctx.productos.find((x) => x.codigo === `${c}-${MARCA_COMPONENTES}`);
      if (!p) throw new Error(`Falta el componente ${c}-${MARCA_COMPONENTES} para el kit ${k.codigo}`);
      return { producto: p, cantidad };
    });
    const costo = componentes.reduce((s, c) => s + c.producto.costoUsd * c.cantidad, 0);
    const precio = (f: number) => (Math.round(costo * f * 100) / 100).toFixed(2);
    await como(ctx, u.gerencia, async (tx) => {
      await fijarPrecio(tx, id, 'A', precio(1.6), desde);
      await fijarPrecio(tx, id, 'B', precio(1.45), desde);
      await fijarPrecio(tx, id, 'D', precio(1.3), desde);
    });
    ctx.estado.kits.push({ id, codigo: k.codigo, marcaId: marca, costoUsd: costo, precioBUsd: Number(precio(1.45)), componentes: componentes.map((c) => ({ productoId: c.producto.id, cantidad: c.cantidad })), enVenta: false });
  }
}

/** Una orden de producción completa (martes): de borrador a terminada, rechazada por Gerencia o anulada por falta de componentes. */
export async function producirUnKit(ctx: Ctx): Promise<void> {
  const { azar, u, estado } = ctx;
  const kit = azar.elegir(estado.kits);
  const cantidad = azar.entero(4, 12);
  try {
    const orden = await como(ctx, u.almacen, async (tx) => {
      const o = await crearOrden(tx, u.almacen, { productoId: kit.id, cantidad: String(cantidad), almacenId: ctx.almacenId, observaciones: `Ensamblaje semanal de ${kit.codigo}` });
      for (const c of kit.componentes) await guardarComponente(tx, u.almacen, o.id, { productoId: c.productoId, cantidad: String(c.cantidad * cantidad) });
      await enviarOrden(tx, u.almacen, o.id);
      return o;
    });
    contar(ctx, 'ordenes_produccion');
    if (azar() < 1 / 6) {
      await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'orden_produccion', orden.id, u.gerencia.id, 'rechazada', { comentario: 'No hay demanda para ese kit esta semana' }));
      contar(ctx, 'ordenes_produccion_rechazadas');
      return;
    }
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'orden_produccion', orden.id, u.gerencia.id, 'aprobada'));
    await como(ctx, u.almacen, (tx) => iniciarOrden(tx, u.almacen, orden.id));
    if ((await faltantesDe(ctx.db, orden.id)).length) {
      await como(ctx, u.almacen, (tx) => anularOrden(tx, u.almacen, orden.id, 'Faltan componentes en el almacén'));
      contar(ctx, 'ordenes_produccion_anuladas');
      return;
    }
    const r = await como(ctx, u.almacen, (tx) => terminarOrden(tx, u.almacen, orden.id));
    contar(ctx, 'ordenes_produccion_terminadas');
    contar(ctx, 'kits_producidos', cantidad);
    // Desde ahora el kit tiene existencia y se puede vender como cualquier producto.
    if (!kit.enVenta) {
      kit.enVenta = true;
      ctx.productos.push({ id: kit.id, codigo: kit.codigo, marcaId: kit.marcaId, costoUsd: Number(r.costoUnitarioUsd), precioBUsd: kit.precioBUsd });
    }
  } catch (e) {
    if (!(e instanceof ErrorMaestro)) throw e;
    avisar(ctx, e.message);
  }
}

/** Conteo cíclico (viernes por la tarde): algunos productos con diferencia (faltantes por daño, sobrantes por error de conteo). */
export async function ajustarInventario(ctx: Ctx): Promise<void> {
  const { azar, u, db } = ctx;
  const { rows: existencias } = await db.query<{ producto_id: string; cantidad: string }>(
    `select e.producto_id, e.cantidad::text from existencia e join producto p on p.id = e.producto_id
      where e.almacen_id = $1 and p.inventariable and p.estado = 'activo' and e.cantidad > 5 order by p.codigo`, [ctx.almacenId]);
  if (existencias.length < 3) return;
  const motivos = new Map((await db.query<{ codigo: string; id: string }>(`select codigo, id from motivo where tipo = 'merma' and activo`)).rows.map((r) => [r.codigo, r.id]));
  const elegidos = azar.barajar(existencias).slice(0, azar.entero(3, 6));
  try {
    const ajuste = await como(ctx, u.almacen, async (tx) => {
      const id = await crearAjuste(tx, u.almacen, { almacenId: ctx.almacenId, observaciones: 'Conteo cíclico semanal', contadoPorId: u.compras.id });
      for (const e of elegidos) {
        const sistema = Number(e.cantidad);
        const r = azar();
        // 25 % sin diferencia, 50 % faltante (daño), 25 % sobrante (diferencia de conteo).
        const contada = r < 0.25 ? sistema : r < 0.75 ? sistema - azar.entero(1, 3) : sistema + azar.entero(1, 2);
        await guardarLineaAjuste(tx, u.almacen, id, {
          productoId: e.producto_id, cantidadContada: String(contada),
          motivoId: contada === sistema ? undefined : motivos.get(contada < sistema ? 'DANO' : 'ERROR_CONTEO'),
        });
      }
      await enviarAjuste(tx, u.almacen, id);
      return id;
    });
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'ajuste_inventario', ajuste, u.gerencia.id, 'aprobada'));
    contar(ctx, 'ajustes_de_inventario');
  } catch (e) {
    if (!(e instanceof ErrorMaestro)) throw e;
    avisar(ctx, e.message);
  }
}

