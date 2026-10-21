import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import type { ServicioNumeroControl } from '@/lib/fiscal/imprenta';
import { cancelarSolicitud, solicitarAprobacion } from '@/lib/flujo/flujo';
import { motivoSistema } from '@/lib/maestros/motivos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_VEN_FACTURAS, pedirControl } from './facturas';
import { verTodosLosDocumentos, type Usuario } from './pedidos';

/**
 * Notas de crédito y de débito (§6.1, §6.2 regla 7, migración 0029). Siempre referencian la factura de origen y van en bolívares,
 * con los precios y las alícuotas de la factura.
 *
 *   borrador (se arma) → enviar → pendiente de aprobación → el Supervisor de ventas (distinto del creador) aprueba o rechaza
 *   → Facturación la emite: número, número de control, asiento y efecto en la cuenta por cobrar (y el inventario, si es devolución)
 *
 * Clases de nota de crédito: devolución (reingresa la mercancía al costo original), pronto pago, descuento comercial y ajuste de
 * precio (no mueven inventario). La nota de débito abre su propia partida. Una nota emitida no se anula: se corrige con otra nota.
 */

export const ROLES_CREAN_NOTAS = ['ventas', 'supervisor_ventas', 'facturacion', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_EMITEN_NOTAS = ['facturacion', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_NOTAS = ROLES_VEN_FACTURAS;

export const CLASES_NC = ['devolucion', 'pronto_pago', 'descuento_comercial', 'ajuste_precio'] as const;
export type ClaseNC = (typeof CLASES_NC)[number];
export const NOMBRE_CLASE_NC: Record<ClaseNC, string> = {
  devolucion: 'Devolución de mercancía', pronto_pago: 'Descuento por pronto pago', descuento_comercial: 'Descuento comercial', ajuste_precio: 'Ajuste de precio',
};
export const CLASES_ND = ['ajuste_precio', 'intereses', 'otro'] as const;
export type ClaseND = (typeof CLASES_ND)[number];
export const NOMBRE_CLASE_ND: Record<ClaseND, string> = { ajuste_precio: 'Ajuste de precio', intereses: 'Intereses por mora', otro: 'Otro cargo' };

const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;
const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const PRECIO = /^\d{1,12}(\.\d{1,4})?$/;
const dos = (d: Decimal.Value) => new Decimal(d).toFixed(2);

interface FacturaOrigen {
  id: string; estado: string; sucursal_id: string; almacen_id: string; cliente_id: string; vendedor_id: string | null; vendedor_usuario: string | null;
  serie: string; numero: string;
}

async function facturaDe(tx: Db, u: Usuario, id: string): Promise<FacturaOrigen> {
  const { rows } = await tx.query<FacturaOrigen>(
    `select d.id, d.estado, d.sucursal_id, d.almacen_id, d.cliente_id, d.vendedor_id, v.usuario_id as vendedor_usuario, d.serie, d.numero::text
       from documento_venta d left join vendedor v on v.id = d.vendedor_id where d.id = $1 and d.tipo = 'factura'`, [id]);
  const f = rows[0];
  if (!f) throw new ErrorMaestro('La factura no existe.');
  if (f.estado !== 'emitido') throw new ErrorMaestro('Solo se hacen notas sobre una factura emitida.');
  if (!verTodosLosDocumentos(u) && f.vendedor_usuario !== u.id) throw new ErrorMaestro('Esa factura no es de su cartera.');
  return f;
}

async function insertarEncabezado(
  tx: Db, u: Usuario, f: FacturaOrigen, d: { tipo: 'nota_credito' | 'nota_debito'; motivo: string; motivoId?: string | null; observaciones?: string; vencimiento?: string },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, vendedor_id, documento_origen_id, moneda, motivo_nc, motivo_nc_id,
                                  observaciones, fecha_vencimiento, created_by)
     values ($1, $2, $3, $4, $5, $6, 'VES', $7, $8, $9, $10::date, $11) returning id`,
    [d.tipo, f.sucursal_id, f.almacen_id, f.cliente_id, f.vendedor_id, f.id, d.motivo, d.motivoId ?? null, d.observaciones?.trim() || null, d.vencimiento || null, u.id]);
  return rows[0].id;
}

// ---------------------------------------------------------------------
// Armar la nota
// ---------------------------------------------------------------------

export interface DatosNotaCredito {
  facturaId: string;
  clase: ClaseNC;
  /** Motivo del catálogo: de devoluciones para una devolución, de descuentos para las demás (el pronto pago usa el suyo). */
  motivoId?: string;
  observaciones?: string;
  /** Devolución: qué líneas de la factura y cuánto de cada una. */
  lineas?: { lineaId: string; cantidad: string }[];
  /** Pronto pago, descuento comercial y ajuste de precio: porcentaje sobre el precio neto de las líneas elegidas (por omisión, todas). */
  porcentaje?: string;
  lineaIds?: string[];
}

export async function crearNotaCredito(tx: Db, u: Usuario, d: DatosNotaCredito): Promise<string> {
  if (!CLASES_NC.includes(d.clase)) throw new ErrorMaestro('Seleccione la clase de nota de crédito.');
  const f = await facturaDe(tx, u, d.facturaId);

  let motivoId = d.motivoId ?? null;
  if (d.clase === 'pronto_pago') motivoId = motivoId ?? (await motivoSistema(tx, 'descuento', 'PRONTO_PAGO'));
  if (!motivoId) throw new ErrorMaestro(d.clase === 'devolucion' ? 'Indique el motivo de la devolución.' : 'Indique el motivo del descuento.');
  const { rows: m } = await tx.query<{ tipo: string; activo: boolean }>('select tipo, activo from motivo where id = $1', [motivoId]);
  if (!m[0] || !m[0].activo || m[0].tipo !== (d.clase === 'devolucion' ? 'devolucion' : 'descuento')) {
    throw new ErrorMaestro(d.clase === 'devolucion' ? 'Seleccione un motivo de devolución del catálogo.' : 'Seleccione un motivo de descuento del catálogo.');
  }

  const columnas = `producto_id, descripcion, alicuota_iva_id, alicuota_pct, producto_base_id`;
  let lineas = 0;
  const id = await insertarEncabezado(tx, u, f, { tipo: 'nota_credito', motivo: d.clase, motivoId, observaciones: d.observaciones });

  if (d.clase === 'devolucion') {
    if (!d.lineas?.length) throw new ErrorMaestro('Seleccione qué líneas se devuelven y cuánto.');
    const vistas = new Set<string>();
    for (const l of d.lineas) {
      if (vistas.has(l.lineaId)) throw new ErrorMaestro('Una línea no puede aparecer dos veces en la misma nota.');
      vistas.add(l.lineaId);
      const cantidad = l.cantidad.trim().replace(',', '.');
      if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad devuelta debe ser mayor que cero, con hasta 4 decimales.');
      lineas += 1;
      const { rows: ins } = await insertarLineaDevolucion(tx, id, lineas, d.facturaId, l.lineaId, cantidad);
      if (!ins.length) throw new ErrorMaestro('Una de las líneas no pertenece a la factura.');
    }
  } else {
    const pct = (d.porcentaje ?? '').trim().replace(',', '.');
    if (!PORCENTAJE.test(pct) || new Decimal(pct).lte(0) || new Decimal(pct).gt(100)) throw new ErrorMaestro('El porcentaje debe ir de 0,01 a 100.');
    const { rows: fl } = await tx.query<{ id: string }>(
      `select id from documento_venta_linea where documento_id = $1 and ($2::uuid[] is null or id = any($2::uuid[])) order by linea`,
      [d.facturaId, d.lineaIds?.length ? d.lineaIds : null]);
    if (!fl.length || (d.lineaIds?.length && fl.length !== d.lineaIds.length)) throw new ErrorMaestro('Alguna de las líneas no pertenece a la factura.');
    for (const l of fl) {
      lineas += 1;
      // El descuento por unidad: porcentaje del precio neto de la factura (ya con su descuento de línea). Mismas cantidades y alícuota.
      await tx.query(
        `insert into documento_venta_linea (documento_id, linea, ${columnas}, cantidad, precio_unitario, descuento_pct, linea_origen_id)
         select $1, $2, ${columnas}, cantidad, round(precio_unitario * (100 - descuento_pct) / 100 * $3::numeric / 100, 4), 0, id
           from documento_venta_linea where id = $4`, [id, lineas, pct, l.id]);
    }
  }
  await tx.query('select fn_venta_calcular($1)', [id]);
  const { rows: t } = await tx.query<{ total: string }>('select total::text from documento_venta where id = $1', [id]);
  if (new Decimal(t[0].total).lte(0)) throw new ErrorMaestro('La nota no tiene un monto mayor que cero.');
  return id;
}

function insertarLineaDevolucion(tx: Db, notaId: string, linea: number, facturaId: string, lineaId: string, cantidad: string) {
  return tx.query(
    `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, descuento_pct, alicuota_iva_id,
                                        alicuota_pct, producto_base_id, lista_precio, precio_lista, costo_unitario_usd, linea_origen_id, motivo_descuento_id)
     select $1, $2, producto_id, descripcion, $3::numeric, precio_unitario, descuento_pct, alicuota_iva_id, alicuota_pct, producto_base_id,
            lista_precio, precio_lista, costo_unitario_usd, id, motivo_descuento_id
       from documento_venta_linea where id = $4 and documento_id = $5 returning id`, [notaId, linea, cantidad, lineaId, facturaId]);
}

export interface DatosNotaDebito {
  facturaId: string;
  motivo: ClaseND;
  observaciones?: string;
  /** Vencimiento de la deuda; por omisión, el plazo de la condición de pago del cliente. */
  vencimiento?: string;
  /** Cada concepto es un producto del maestro (conviene uno no inventariable, como «Intereses por mora») con su precio en bolívares. */
  lineas: { productoId: string; descripcion?: string; cantidad: string; precio: string }[];
}

export async function crearNotaDebito(tx: Db, u: Usuario, d: DatosNotaDebito): Promise<string> {
  if (!CLASES_ND.includes(d.motivo)) throw new ErrorMaestro('Seleccione el motivo de la nota de débito.');
  if (!d.lineas.length) throw new ErrorMaestro('Agregue al menos un concepto a la nota de débito.');
  const f = await facturaDe(tx, u, d.facturaId);
  const id = await insertarEncabezado(tx, u, f, { tipo: 'nota_debito', motivo: d.motivo, observaciones: d.observaciones, vencimiento: d.vencimiento });
  let n = 0;
  for (const l of d.lineas) {
    const cantidad = l.cantidad.trim().replace(',', '.');
    const precio = l.precio.trim().replace(',', '.');
    if (!CANTIDAD.test(cantidad) || new Decimal(cantidad).lte(0)) throw new ErrorMaestro('La cantidad debe ser mayor que cero, con hasta 4 decimales.');
    if (!PRECIO.test(precio) || new Decimal(precio).lte(0)) throw new ErrorMaestro('El precio debe ser un monto en bolívares mayor que cero.');
    n += 1;
    const { rows: ins } = await tx.query(
      `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, descuento_pct, alicuota_iva_id)
       select $1, $2, p.id, coalesce(nullif(trim($3), ''), p.descripcion), $4::numeric, $5::numeric, 0, p.alicuota_iva_id from producto p
        where p.id = $6 and p.estado = 'activo' returning id`, [id, n, l.descripcion ?? '', cantidad, precio, l.productoId]);
    if (!ins.length) throw new ErrorMaestro('Uno de los productos no existe o está inactivo.');
  }
  await tx.query('select fn_venta_calcular($1)', [id]);
  return id;
}

// ---------------------------------------------------------------------
// Aprobación
// ---------------------------------------------------------------------

interface NotaBase { id: string; tipo: 'nota_credito' | 'nota_debito'; estado: string; situacion: string | null; created_by: string; total: string }

async function notaDe(tx: Db, id: string): Promise<NotaBase> {
  const { rows } = await tx.query<NotaBase>(
    `select id, tipo, estado, situacion, created_by, total::text from documento_venta where id = $1 and tipo in ('nota_credito', 'nota_debito') for update`, [id]);
  if (!rows[0]) throw new ErrorMaestro('La nota no existe.');
  return rows[0];
}

/** Envía la nota al Supervisor de ventas (motor de flujo). Desde ahí sus líneas no se editan. */
export async function enviarAprobacion(tx: Db, u: Usuario, id: string): Promise<void> {
  const n = await notaDe(tx, id);
  if (n.estado !== 'borrador' || n.situacion !== null) throw new ErrorMaestro('Solo se envía a aprobación una nota en borrador.');
  if (n.created_by !== u.id && !u.roles.some((r) => ['gerencia', 'supervisor_ventas', 'facturacion'].includes(r))) throw new ErrorMaestro('Esa nota la creó otra persona.');
  await tx.query('select fn_venta_calcular($1)', [id]);
  await tx.query(`update documento_venta set situacion = 'pendiente_aprobacion' where id = $1`, [id]);
  await solicitarAprobacion(tx, { tipo: n.tipo, objetoId: id, solicitanteId: u.id, contexto: { total_ves: Number(n.total) } });
}

/** Lo llama el motor de flujo cuando el Supervisor de ventas aprueba (la base exige el rol y que no sea quien la creó). */
export async function aprobarNota(tx: Db, id: string, aprobador: string): Promise<void> {
  const n = await notaDe(tx, id);
  if (n.situacion !== 'pendiente_aprobacion') throw new ErrorMaestro('La nota no está pendiente de aprobación.');
  await tx.query(`update documento_venta set situacion = 'aprobada', aprobado_por = $2 where id = $1`, [id, aprobador]);
}

export async function rechazarNota(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const n = await notaDe(tx, id);
  if (n.situacion !== 'pendiente_aprobacion') throw new ErrorMaestro('La nota no está pendiente de aprobación.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo del rechazo.');
  await tx.query(`update documento_venta set situacion = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

/** Elimina una nota que aún no se emitió y no está en aprobación (borrador o rechazada). */
export async function eliminarNota(tx: Db, u: Usuario, id: string): Promise<void> {
  const n = await notaDe(tx, id);
  if (n.estado !== 'borrador') throw new ErrorMaestro('Una nota emitida no se elimina: se corrige con otra nota.');
  if (n.situacion === 'pendiente_aprobacion' || n.situacion === 'aprobada') throw new ErrorMaestro('La nota está en aprobación o aprobada: se emite o se rechaza.');
  if (n.created_by !== u.id && !u.roles.includes('gerencia')) throw new ErrorMaestro('Esa nota la creó otra persona.');
  await cancelarSolicitud(tx, n.tipo, id);
  await tx.query('delete from documento_venta where id = $1', [id]);
}

// ---------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------

export interface ResultadoNota { id: string; numero: string; numeroControl: string | null; contingencia: boolean; asiento: string; asientoInventario: string | null }

/** Emite una nota aprobada: número, número de control (o contingencia), efecto en la cuenta por cobrar, inventario y asientos. */
export async function emitirNota(tx: Db, u: Usuario, id: string, opciones: { servicio?: ServicioNumeroControl } = {}): Promise<ResultadoNota> {
  const { rows } = await tx.query<{
    tipo: 'nota_credito' | 'nota_debito'; estado: string; situacion: string | null; motivo_nc: string; cliente_id: string; origen: string; almacen_id: string;
    total: string; base_imponible: string; exento: string; iva: string; fecha_vencimiento: string | null; rif: string; dias: number | null; hoy: string; fecha_factura: string;
  }>(
    `select d.tipo, d.estado, d.situacion, d.motivo_nc, d.cliente_id, d.documento_origen_id as origen, d.almacen_id, d.total::text, d.base_imponible::text,
            d.exento::text, d.iva::text, d.fecha_vencimiento::text, t.rif, cp.dias, ((now() at time zone 'America/Caracas')::date)::text as hoy,
            ((select fecha_emision from documento_venta where id = d.documento_origen_id) at time zone 'America/Caracas')::date::text as fecha_factura
       from documento_venta d
       join cliente c on c.tercero_id = d.cliente_id join tercero t on t.id = d.cliente_id
       left join condicion_pago cp on cp.id = c.condicion_pago_id
      where d.id = $1 and d.tipo in ('nota_credito', 'nota_debito') for update of d`, [id]);
  const n = rows[0];
  if (!n) throw new ErrorMaestro('La nota no existe.');
  if (n.estado !== 'borrador') throw new ErrorMaestro('La nota ya está emitida.');
  if (n.situacion !== 'aprobada') throw new ErrorMaestro('Solo se emite una nota aprobada por el Supervisor de ventas.');
  const { rows: emp } = await tx.query<{ rif: string }>('select rif from empresa');
  if (!emp[0]) throw new ErrorMaestro('Configure la empresa (RIF, razón social y domicilio fiscal) antes de emitir.');

  let partidaFactura: { id: string; saldo: string } | undefined;
  if (n.tipo === 'nota_credito') {
    const { rows: p } = await tx.query<{ id: string; saldo: string; estado: string }>(
      'select id, saldo::text, estado from partida_cxc where documento_id = $1 for update', [n.origen]);
    if (!p[0] || p[0].estado !== 'abierta') {
      throw new ErrorMaestro('La factura ya no tiene saldo por cobrar: no se puede reducir con una nota de crédito. Registre la devolución del dinero (pendiente) o corrija el cobro.');
    }
    if (new Decimal(n.total).gt(p[0].saldo)) {
      throw new ErrorMaestro(`La nota de crédito (Bs. ${n.total}) supera el saldo de la factura (Bs. ${p[0].saldo}).`);
    }
    partidaFactura = p[0];
  }

  const { rows: e } = await tx.query<{ numero: string; serie: string; fecha: string }>(
    `update documento_venta set estado = 'emitido', contingencia = true, contingencia_motivo = 'Pendiente del número de control' where id = $1
     returning numero::text, serie, to_char(fecha_emision at time zone 'America/Caracas', 'YYYY-MM-DD') as fecha`, [id]);
  const control = await pedirControl(tx, opciones.servicio, {
    serie: e[0].serie, numero: e[0].numero, fechaEmision: e[0].fecha, emisorRif: emp[0].rif, receptorRif: n.rif, totalVes: n.total, ivaVes: n.iva,
  });
  if (control.numeroControl) {
    await tx.query(`update documento_venta set numero_control = $2, contingencia = false, contingencia_motivo = null, imprenta = $3 where id = $1`,
      [id, control.numeroControl, control.proveedor]);
  } else {
    await tx.query('update documento_venta set contingencia_motivo = $2 where id = $1', [id, control.motivo]);
  }

  const etiqueta = n.tipo === 'nota_credito' ? 'Nota de crédito' : 'Nota de débito';
  const venta = dos(new Decimal(n.base_imponible).plus(n.exento));
  let asiento: string;
  let asientoInventario: string | null = null;

  if (n.tipo === 'nota_credito') {
    // Reduce la partida de la factura; el trigger calcula el valor en USD que deja de deberse (a la tasa de la factura).
    const { rows: ap } = await tx.query<{ usd: string }>(
      'insert into aplicacion_nota_credito (nota_id, partida_id, monto) values ($1, $2, $3) returning usd::text', [id, partidaFactura!.id, n.total]);
    const usdTotal = new Decimal(ap[0].usd);
    const ivaUsd = new Decimal(n.total).isZero() ? new Decimal(0) : usdTotal.times(n.iva).div(n.total).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const r = await contabilizar(tx, {
      evento: n.motivo_nc === 'devolucion' ? 'nota_credito_devolucion' : 'nota_credito_descuento', fecha: n.hoy,
      descripcion: `${etiqueta} ${e[0].serie}-${e[0].numero}`, origen: { tipo: 'nota_credito', id }, moneda: 'VES', importes: {},
      importesDobles: {
        venta: { ves: venta, usd: dos(usdTotal.minus(ivaUsd)) }, iva: { ves: n.iva, usd: dos(ivaUsd) }, total: { ves: n.total, usd: dos(usdTotal) },
      },
      terceroId: n.cliente_id, usuarioId: u.id,
    });
    asiento = r.numero;

    if (n.motivo_nc === 'devolucion') {
      const { rows: lineas } = await tx.query<{ producto_id: string; cantidad: string; costo: string | null; inventariable: boolean }>(
        `select l.producto_id, l.cantidad::text, l.costo_unitario_usd::text as costo, p.inventariable
           from documento_venta_linea l join producto p on p.id = l.producto_id where l.documento_id = $1 order by l.linea`, [id]);
      let costo = new Decimal(0);
      for (const l of lineas) {
        if (!l.inventariable) continue;
        if (l.costo === null) throw new ErrorMaestro('Una línea de la factura no guardó su costo: no se puede reingresar al inventario.');
        const { rows: mov } = await tx.query<{ costo_total_usd: string }>(
          `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
           values ('devolucion_cliente', $1, $2, $3, $4, 'nota_credito', $5, $6) returning costo_total_usd::text`,
          [l.producto_id, n.almacen_id, l.cantidad, l.costo, id, u.id]);
        costo = costo.plus(mov[0].costo_total_usd);
      }
      if (costo.gt(0)) {
        const ri = await contabilizar(tx, {
          evento: 'reingreso_devolucion', fecha: n.hoy, descripcion: `Reingreso al inventario · ${etiqueta} ${e[0].serie}-${e[0].numero}`,
          origen: { tipo: 'reingreso_devolucion', id }, moneda: 'USD', importes: { costo: costo.toFixed(2) }, terceroId: n.cliente_id, usuarioId: u.id,
        });
        asientoInventario = ri.numero;
      }
    }
  } else {
    // La nota de débito abre su propia deuda.
    await tx.query(
      `insert into partida_cxc (cliente_id, documento_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
       select cliente_id, id, $2::date, coalesce(fecha_vencimiento, $2::date + $3::int), 'VES', tasa, total, total_usd, total from documento_venta where id = $1`,
      [id, n.hoy, n.dias ?? 0]);
    const r = await contabilizar(tx, {
      evento: n.motivo_nc === 'ajuste_precio' ? 'nota_debito_ajuste' : 'nota_debito_otros', fecha: n.hoy,
      descripcion: `${etiqueta} ${e[0].serie}-${e[0].numero}`, origen: { tipo: 'nota_debito', id }, moneda: 'VES',
      importes: { total: n.total, venta, iva: n.iva }, terceroId: n.cliente_id, usuarioId: u.id,
    });
    asiento = r.numero;
  }
  return { id, numero: `${e[0].serie}-${e[0].numero}`, numeroControl: control.numeroControl, contingencia: !control.numeroControl, asiento, asientoInventario };
}

/** Una nota emitida en contingencia recibe después su número de control. */
export async function asignarControlNota(tx: Db, id: string, opciones: { servicio?: ServicioNumeroControl } = {}): Promise<string> {
  const { rows } = await tx.query<{ estado: string; contingencia: boolean; serie: string; numero: string; fecha: string; total: string; iva: string; rif: string }>(
    `select d.estado, d.contingencia, d.serie, d.numero::text, to_char(d.fecha_emision at time zone 'America/Caracas', 'YYYY-MM-DD') as fecha,
            d.total::text, d.iva::text, t.rif
       from documento_venta d join tercero t on t.id = d.cliente_id
      where d.id = $1 and d.tipo in ('nota_credito', 'nota_debito') for update of d`, [id]);
  const n = rows[0];
  if (!n) throw new ErrorMaestro('La nota no existe.');
  if (n.estado !== 'emitido' || !n.contingencia) throw new ErrorMaestro('Esta nota no está pendiente de número de control.');
  const { rows: emp } = await tx.query<{ rif: string }>('select rif from empresa');
  const control = await pedirControl(tx, opciones.servicio, {
    serie: n.serie, numero: n.numero, fechaEmision: n.fecha, emisorRif: emp[0].rif, receptorRif: n.rif, totalVes: n.total, ivaVes: n.iva,
  });
  if (!control.numeroControl) throw new ErrorMaestro(`No se pudo obtener el número de control. ${control.motivo ?? ''}`.trim());
  await tx.query(`update documento_venta set numero_control = $2, contingencia = false, contingencia_motivo = null, imprenta = $3 where id = $1`,
    [id, control.numeroControl, control.proveedor]);
  return control.numeroControl;
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaNota {
  id: string; tipo: 'nota_credito' | 'nota_debito'; numero: string | null; estado: string; situacion: string | null; motivo_nc: string; factura: string;
  cliente_codigo: string; cliente: string; total: string; fecha: string | null; contingencia: boolean;
}

export async function buscarNotas(db: Db, u: Usuario, filtro: { tipo?: string; estado?: string; texto?: string } = {}, limite = 100): Promise<FilaNota[]> {
  if (!u.roles.some((r) => (ROLES_VEN_NOTAS as readonly string[]).includes(r))) return [];
  const verTodos = verTodosLosDocumentos(u);
  const { rows } = await db.query<FilaNota>(
    `select d.id, d.tipo, case when d.numero is null then null else d.serie || '-' || d.numero end as numero, d.estado, d.situacion, d.motivo_nc,
            f.serie || '-' || f.numero as factura, c.codigo as cliente_codigo, t.razon_social as cliente, d.total::text,
            to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, d.contingencia
       from documento_venta d
       join documento_venta f on f.id = d.documento_origen_id
       join cliente c on c.tercero_id = d.cliente_id
       join tercero t on t.id = d.cliente_id
       left join vendedor v on v.id = d.vendedor_id
      where d.tipo in ('nota_credito', 'nota_debito')
        and ($1 = '' or d.tipo = $1)
        and ($2 = '' or (case when d.estado = 'emitido' then 'emitida' when d.situacion = 'pendiente_aprobacion' then 'pendiente' when d.situacion = 'aprobada' then 'aprobada'
                              when d.situacion = 'rechazada' then 'rechazada' else 'borrador' end) = $2)
        and ($3 = '' or d.numero::text = $3 or f.numero::text = $3 or c.codigo ilike '%' || $3 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($3) || '%')
        and ($4 or v.usuario_id = $5)
      order by (d.estado = 'emitido'), coalesce(d.fecha_emision, d.created_at) desc
      limit $6`, [filtro.tipo ?? '', filtro.estado ?? '', (filtro.texto ?? '').trim(), verTodos, u.id, limite]);
  return rows;
}

export interface LineaNota {
  id: string; linea: number; codigo: string; descripcion: string; cantidad: string; precio_unitario: string; descuento_pct: string; alicuota_pct: string;
  base: string; iva: string; total: string;
}

export interface DetalleNota {
  id: string; tipo: 'nota_credito' | 'nota_debito'; numero: string | null; numero_control: string | null; contingencia: boolean; contingencia_motivo: string | null;
  imprenta: string | null; estado: string; situacion: string | null; motivo_nc: string; motivo: string | null; observaciones: string | null; rechazo_motivo: string | null;
  fecha: string | null; vencimiento: string | null; subtotal: string; base_imponible: string; exento: string; iva: string; total: string;
  factura_id: string; factura: string; cliente_id: string; cliente_codigo: string; cliente: string; cliente_rif: string; vendedor_usuario: string | null;
  creador: string; creador_id: string; aprobador: string | null; usd_aplicado: string | null; saldo_nd: string | null;
  asientos: { id: string; numero: string; evento: string }[]; lineas: LineaNota[];
}

export async function detalleNota(db: Db, id: string): Promise<DetalleNota | null> {
  const { rows } = await db.query<Omit<DetalleNota, 'lineas' | 'asientos'>>(
    `select d.id, d.tipo, case when d.numero is null then null else d.serie || '-' || d.numero end as numero, d.numero_control, d.contingencia, d.contingencia_motivo,
            d.imprenta, d.estado, d.situacion, d.motivo_nc, m.nombre as motivo, d.observaciones, d.rechazo_motivo,
            to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha, to_char(d.fecha_vencimiento, 'DD-MM-YYYY') as vencimiento,
            d.subtotal::text, d.base_imponible::text, d.exento::text, d.iva::text, d.total::text,
            f.id as factura_id, f.serie || '-' || f.numero as factura, c.tercero_id as cliente_id, c.codigo as cliente_codigo, t.razon_social as cliente, t.rif as cliente_rif,
            v.usuario_id as vendedor_usuario, uc.nombre as creador, d.created_by as creador_id, ua.nombre as aprobador,
            (select usd::text from aplicacion_nota_credito where nota_id = d.id) as usd_aplicado,
            (select saldo::text from partida_cxc where documento_id = d.id) as saldo_nd
       from documento_venta d
       join documento_venta f on f.id = d.documento_origen_id
       join cliente c on c.tercero_id = d.cliente_id
       join tercero t on t.id = d.cliente_id
       join usuario uc on uc.id = d.created_by
       left join usuario ua on ua.id = d.aprobado_por
       left join vendedor v on v.id = d.vendedor_id
       left join motivo m on m.id = d.motivo_nc_id
      where d.id = $1 and d.tipo in ('nota_credito', 'nota_debito')`, [id]);
  if (!rows[0]) return null;
  const [lineas, asientos] = await Promise.all([
    db.query<LineaNota>(
      `select l.id, l.linea, p.codigo, l.descripcion, l.cantidad::text, l.precio_unitario::text, l.descuento_pct::text, l.alicuota_pct::text, l.base::text, l.iva::text, l.total::text
         from documento_venta_linea l join producto p on p.id = l.producto_id where l.documento_id = $1 order by l.linea`, [id]),
    db.query<{ id: string; numero: string; evento: string }>(
      `select id, numero::text, origen_tipo as evento from asiento where origen_id = $1 and origen_tipo in ('nota_credito', 'nota_debito', 'reingreso_devolucion') order by numero`, [id]),
  ]);
  return { ...rows[0], lineas: lineas.rows, asientos: asientos.rows };
}

export interface LineaFacturable {
  id: string; linea: number; codigo: string; descripcion: string; cantidad: string; devuelta: string; disponible: string;
  precio_unitario: string; descuento_pct: string; alicuota_pct: string; inventariable: boolean;
}

/** Líneas de una factura con lo ya devuelto por otras notas vigentes: de ahí sale lo que todavía se puede devolver. */
export async function lineasFacturables(db: Db, facturaId: string): Promise<LineaFacturable[]> {
  const { rows } = await db.query<LineaFacturable>(
    `select l.id, l.linea, p.codigo, l.descripcion, l.cantidad::text, coalesce(x.cant, 0)::text as devuelta, (l.cantidad - coalesce(x.cant, 0))::text as disponible,
            l.precio_unitario::text, l.descuento_pct::text, l.alicuota_pct::text, p.inventariable
       from documento_venta_linea l
       join producto p on p.id = l.producto_id
       left join lateral (select sum(nl.cantidad) as cant from documento_venta_linea nl join documento_venta n on n.id = nl.documento_id
                           where nl.linea_origen_id = l.id and n.tipo = 'nota_credito' and n.motivo_nc = 'devolucion' and n.estado <> 'anulado'
                             and n.situacion is distinct from 'rechazada') x on true
      where l.documento_id = $1 order by l.linea`, [facturaId]);
  return rows;
}

export interface NotaDeFactura { id: string; tipo: string; numero: string | null; estado: string; situacion: string | null; motivo_nc: string; total: string }

export async function notasDeFactura(db: Db, facturaId: string): Promise<NotaDeFactura[]> {
  const { rows } = await db.query<NotaDeFactura>(
    `select id, tipo, case when numero is null then null else serie || '-' || numero end as numero, estado, situacion, motivo_nc, total::text
       from documento_venta where documento_origen_id = $1 and tipo in ('nota_credito', 'nota_debito') order by created_at`, [facturaId]);
  return rows;
}

export interface FacturaParaNota { id: string; numero: string; fecha: string; cliente_codigo: string; cliente: string; total: string; saldo: string | null }

export async function buscarFacturasParaNota(db: Db, u: Usuario, texto: string, limite = 15): Promise<FacturaParaNota[]> {
  if (!texto.trim()) return [];
  const { rows } = await db.query<FacturaParaNota>(
    `select f.id, f.serie || '-' || f.numero as numero, to_char(f.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, c.codigo as cliente_codigo,
            t.razon_social as cliente, f.total::text, p.saldo::text as saldo
       from documento_venta f
       join cliente c on c.tercero_id = f.cliente_id join tercero t on t.id = f.cliente_id
       left join vendedor v on v.id = f.vendedor_id
       left join partida_cxc p on p.documento_id = f.id
      where f.tipo = 'factura' and f.estado = 'emitido' and ($2 or v.usuario_id = $3)
        and (f.numero::text = $1 or f.serie || '-' || f.numero = upper($1) or c.codigo ilike '%' || $1 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($1) || '%')
      order by f.fecha_emision desc limit $4`, [texto.trim(), verTodosLosDocumentos(u), u.id, limite]);
  return rows;
}
