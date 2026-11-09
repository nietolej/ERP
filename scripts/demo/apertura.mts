/**
 * Arranque de la empresa ficticia (spec §14): fecha de arranque, saldos iniciales como operaciones (bancos, conteo
 * físico de inventario, facturas pendientes de clientes y de proveedores), asiento de apertura del contador contra
 * «Saldos de apertura» y cierre de la apertura. Cada documento lo registra su responsable y lo aprueba Gerencia.
 */
import { cerrarApertura, fijarFechaArranque, registrarBanco, registrarCxc, registrarCxp } from '../../src/lib/apertura/apertura';
import { confirmar } from '../../src/lib/apertura/checklist';
import { crearConteo, enviarConteo, fijarCostos, guardarLineaConteo } from '../../src/lib/apertura/inventario';
import { confirmarVidaUtil, registrarActivoApertura } from '../../src/lib/contabilidad/activos';
import { guardarBorrador, huellaAsiento } from '../../src/lib/contabilidad/manual';
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { como, contar, dinero, sumarDias, type Ctx } from './base.mts';

export interface PartidaApertura { clienteId: string; partidaId: string; vencimiento: string }

export async function sembrarApertura(ctx: Ctx, fecha: string, tasa: number): Promise<PartidaApertura[]> {
  const { db, azar, u } = ctx;
  const aprobar = (tipo: string, id: string) => como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, tipo, id, u.gerencia.id, 'aprobada'));

  await como(ctx, u.gerencia, (tx) => fijarFechaArranque(tx, u.gerencia, fecha));

  // Bancos: el saldo del estado de cuenta del día anterior (Tesorería registra, Gerencia aprueba).
  for (const [cuenta, saldo] of [[ctx.cuentaVesId, '2500000.00'], [ctx.cuentaUsdId, '35000.00']] as const) {
    const b = await como(ctx, u.tesoreria, (tx) => registrarBanco(tx, u.tesoreria, { cuentaBancariaId: cuenta, saldo, referencia: 'Estado de cuenta al cierre anterior' }));
    await aprobar('apertura_banco', b.id);
  }

  // Conteo físico inicial: Almacén cuenta, Contabilidad fija el costo y Gerencia aprueba.
  const conteo = await como(ctx, u.almacen, (tx) => crearConteo(tx, u.almacen, { almacenId: ctx.almacenId, observaciones: 'Toma física del día anterior al arranque' }));
  const contados = azar.barajar(ctx.productos).slice(0, Math.round(ctx.productos.length * 0.75));
  await como(ctx, u.almacen, async (tx) => {
    for (const p of contados) await guardarLineaConteo(tx, u.almacen, conteo.id, { productoId: p.id, cantidad: String(azar.entero(30, 120)) });
  });
  const costoDe = new Map(ctx.productos.map((p) => [p.id, p.costoUsd]));
  const { rows: lineas } = await db.query<{ id: string; producto_id: string }>('select id, producto_id from apertura_inventario_linea where apertura_id = $1', [conteo.id]);
  await como(ctx, u.contabilidad, (tx) => fijarCostos(tx, u.contabilidad, conteo.id, Object.fromEntries(lineas.map((l) => [l.id, dinero(costoDe.get(l.producto_id)!)]))));
  await como(ctx, u.almacen, (tx) => enviarConteo(tx, u.almacen, conteo.id));
  await aprobar('apertura_inventario', conteo.id);

  // Cuentas por cobrar: una factura pendiente por cliente, con su número, fecha y vencimiento originales.
  const partidas: PartidaApertura[] = [];
  const deudores = azar.barajar(ctx.clientes.filter((c) => c.condicionDias > 0)).slice(0, 6);
  for (const [i, c] of deudores.entries()) {
    const original = sumarDias(fecha, -azar.entero(10, 60));
    const vencimiento = sumarDias(original, c.condicionDias);
    const r = await como(ctx, u.cobranzas, (tx) => registrarCxc(tx, u.cobranzas, {
      clienteId: c.id, sucursalId: ctx.sucursalId, numeroOriginal: String(900_001 + i), numeroControl: `00-${String(800_001 + i)}`,
      fechaOriginal: original, vencimiento, saldo: dinero(azar.entero(40, 400) * 1000 + 0.55 * azar.entero(1, 99)), tasa: (tasa * 0.93).toFixed(6),
    }));
    await aprobar('apertura_cxc', r.id);
    const { rows } = await db.query<{ id: string }>(
      `select p.id from apertura_cxc a join partida_cxc p on p.documento_id = a.documento_id where a.id = $1`, [r.id]);
    partidas.push({ clienteId: c.id, partidaId: rows[0].id, vencimiento });
  }

  // Cuentas por pagar: facturas de proveedores que vencen en las primeras semanas.
  for (const [i, p] of ctx.proveedores.slice(0, 2).entries()) {
    const original = sumarDias(fecha, -20);
    const r = await como(ctx, u.compras, (tx) => registrarCxp(tx, u.compras, {
      proveedorId: p.id, numeroDocumento: `APERT-${i + 1}`, numeroControl: `00-${700_001 + i}`, fechaOriginal: original, vencimiento: sumarDias(fecha, 6 + i * 5),
      moneda: 'USD', saldo: dinero(3000 + i * 1800), tasaUsd: (tasa * 0.95).toFixed(6),
    }));
    await aprobar('apertura_cxp', r.id);
  }

  // Activos fijos existentes al arranque: costo, meses ya depreciados y depreciación acumulada. Contabilidad los registra y Gerencia los
  // aprueba; el contador confirma la vida útil de sus categorías (valores de la empresa ficticia).
  for (const [codigo, descripcion, costoUsd, meses] of [
    ['MAQ', 'Montacargas eléctrico de 2 t', 9500, 14], ['MOB', 'Estantería metálica del almacén', 4800, 20], ['COMP', 'Equipos de cómputo de oficina', 2200, 30],
  ] as const) {
    const cat = (await db.query<{ id: string; vida: number }>('select id, vida_util_meses as vida from categoria_activo where codigo = $1', [codigo])).rows[0];
    await como(ctx, u.jefe_contabilidad, (tx) => confirmarVidaUtil(tx, u.jefe_contabilidad, cat.id, cat.vida));
    const tasaHistorica = tasa * 0.85;
    const dep = (valor: number) => dinero((valor * meses) / cat.vida);
    const id = await como(ctx, u.contabilidad, (tx) => registrarActivoApertura(tx, u.contabilidad, {
      descripcion, categoriaId: cat.id, fechaAdquisicion: sumarDias(fecha, -30 * meses), ubicacion: 'Sede principal', responsable: 'Almacén',
      costoUsd: dinero(costoUsd), costoVes: dinero(costoUsd * tasaHistorica), mesesDepreciados: meses, depAperturaUsd: dep(costoUsd), depAperturaVes: dep(costoUsd * tasaHistorica),
    }));
    await aprobar('activo_fijo', id);
    ctx.estado.activoIds.push(id);
  }

  // Asiento de apertura del contador: lo que falta para que «Saldos de apertura» (3.9.01) quede en cero en bolívares
  // se lleva al capital social. Lo registra Contabilidad y lo aprueba el Jefe de contabilidad.
  const { rows: puente } = await db.query<{ ves: string }>(
    `select coalesce(sum(l.debe_ves - l.haber_ves), 0)::text as ves
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01'`);
  const saldo = Number(puente[0].ves);
  if (saldo !== 0) {
    const cuentaId = async (codigo: string) => (await db.query<{ id: string }>('select id from cuenta_contable where codigo = $1', [codigo])).rows[0].id;
    const [puenteId, capitalId] = [await cuentaId('3.9.01'), await cuentaId('3.1.01')];
    const monto = dinero(Math.abs(saldo));
    // Saldo acreedor en 3.9.01 (más activos que pasivos): se debita contra capital; si fuera deudor, al revés.
    const lineas = saldo < 0
      ? [{ cuentaId: puenteId, debe: monto, haber: '' }, { cuentaId: capitalId, debe: '', haber: monto }]
      : [{ cuentaId: puenteId, debe: '', haber: monto }, { cuentaId: capitalId, debe: monto, haber: '' }];
    const asientoId = await como(ctx, u.contabilidad, (tx) => guardarBorrador(tx, u.contabilidad.id, {
      fecha, descripcion: 'Asiento de apertura: patrimonio inicial', moneda: 'VES', tipo: 'apertura', lineas,
    }));
    const huella = await huellaAsiento(db, asientoId);
    await como(ctx, u.jefe_contabilidad, (tx) => resolverAprobacion(tx, 'asiento_manual', asientoId, u.jefe_contabilidad.id, 'aprobada', { datos: { huella } }));
  }

  // Parámetros fiscales: en la empresa ficticia, el contador valida los valores de referencia (solo demostración).
  await como(ctx, u.jefe_contabilidad, (tx) => tx.query('update parametro_fiscal set validado_por_contador = true where not validado_por_contador'));

  await como(ctx, u.gerencia, (tx) => cerrarApertura(tx, u.gerencia));
  // Confirmaciones del checklist que dependen de las comprobaciones hechas arriba. No se confirman el respaldo probado, la
  // capacitación ni las firmas: son hechos del mundo real que esta empresa ficticia no tiene.
  await como(ctx, u.contabilidad, (tx) => confirmar(tx, u.contabilidad, 'configuracion', 'Revisado en la empresa ficticia'));
  await como(ctx, u.tesoreria, (tx) => confirmar(tx, u.tesoreria, 'bancos', 'Cuadrado con los saldos cargados'));
  await como(ctx, u.contabilidad, (tx) => confirmar(tx, u.contabilidad, 'cartera', 'Cuadrada con las facturas pendientes cargadas'));
  contar(ctx, 'documentos_de_apertura', 2 + 1 + deudores.length + 2 + 1 + 3);
  return partidas;
}
