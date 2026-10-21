import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { servicioImprenta, type ServicioNumeroControl } from '@/lib/fiscal/imprenta';
import { textoDeAnulacion, type MotivoDocumento } from '@/lib/maestros/motivos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { verTodosLosDocumentos, type Usuario } from './pedidos';

/**
 * Factura de venta (§6.1, §6.3, §11.1, migración 0021). Va en bolívares (decisión 14): sale de una o más notas de entrega
 * despachadas de un mismo cliente, con el precio en USD de la nota convertido a la tasa BCV del día de la factura.
 *
 *   notas despachadas → facturar → número correlativo + número de control (imprenta, o contingencia)
 *                     → partida de cuentas por cobrar + asiento (CxC contra ventas e IVA débito fiscal)
 *   anular: asiento inverso, partida anulada y las notas quedan libres para facturarse otra vez
 */

export const ROLES_FACTURAN = ['facturacion', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_FACTURAS = [
  'ventas', 'supervisor_ventas', 'facturacion', 'gerencia', 'cobranzas', 'contabilidad', 'jefe_contabilidad', 'auditor',
] as const satisfies readonly Rol[];

export interface OpcionesFactura {
  /** Servicio de número de control; por defecto, el configurado (hoy, el simulador). */
  servicio?: ServicioNumeroControl;
}

export interface ResultadoFactura {
  facturaId: string;
  numero: string;
  numeroControl: string | null;
  contingencia: boolean;
}

const dosDecimales = (d: Decimal.Value) => new Decimal(d).toFixed(2);

/** Factura una o más notas de entrega despachadas de un mismo cliente. */
export async function facturarNotas(tx: Db, u: Usuario, notaIds: string[], opciones: OpcionesFactura = {}): Promise<ResultadoFactura> {
  const ids = [...new Set(notaIds)];
  if (!ids.length) throw new ErrorMaestro('Seleccione al menos una nota de entrega.');

  const { rows: notas } = await tx.query<{
    id: string; numero: string; estado: string; salida_at: string | null; factura_id: string | null; cliente_id: string;
    sucursal_id: string; almacen_id: string; vendedor_id: string | null;
  }>(
    `select id, numero::text, estado, salida_at::text, factura_id, cliente_id, sucursal_id, almacen_id, vendedor_id
       from documento_venta where id = any($1::uuid[]) and tipo = 'nota_entrega' order by numero for update`, [ids]);
  if (notas.length !== ids.length) throw new ErrorMaestro('Alguna de las notas de entrega no existe.');
  for (const n of notas) {
    if (n.estado !== 'emitido') throw new ErrorMaestro(`La nota de entrega ${n.numero} está anulada.`);
    if (!n.salida_at) throw new ErrorMaestro(`La nota de entrega ${n.numero} todavía no ha salido del almacén: se factura después del despacho.`);
    if (n.factura_id) throw new ErrorMaestro(`La nota de entrega ${n.numero} ya está facturada.`);
  }
  if (new Set(notas.map((n) => n.cliente_id)).size > 1) throw new ErrorMaestro('Solo se facturan juntas las notas de un mismo cliente.');

  const { rows: emp } = await tx.query<{ rif: string }>('select rif from empresa');
  if (!emp[0]) throw new ErrorMaestro('Configure la empresa (RIF, razón social y domicilio fiscal) antes de facturar.');
  const { rows: cli } = await tx.query<{ rif: string; estado: string; dias: number | null }>(
    `select t.rif, c.estado, cp.dias from cliente c join tercero t on t.id = c.tercero_id
       left join condicion_pago cp on cp.id = c.condicion_pago_id where c.tercero_id = $1`, [notas[0].cliente_id]);
  if (cli[0].estado === 'pendiente') throw new ErrorMaestro('El cliente todavía no está aprobado.');

  const { rows: dia } = await tx.query<{ hoy: string; tasa: string }>(
    `select ((now() at time zone 'America/Caracas')::date)::text as hoy,
            fn_tasa('USD', (now() at time zone 'America/Caracas')::date)::text as tasa`);
  const { hoy, tasa } = dia[0];

  const { rows: fac } = await tx.query<{ id: string }>(
    `insert into documento_venta (tipo, sucursal_id, almacen_id, cliente_id, vendedor_id, moneda, fecha_vencimiento, created_by)
     values ('factura', $1, $2, $3, $4, 'VES', ($5::date + $6::int), $7) returning id`,
    [notas[0].sucursal_id, notas[0].almacen_id, notas[0].cliente_id, notas[0].vendedor_id, hoy, cli[0].dias ?? 0, u.id]);
  const facturaId = fac[0].id;

  await tx.query(
    `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, descuento_pct, alicuota_iva_id,
                                        producto_base_id, lista_precio, precio_lista, costo_unitario_usd, linea_origen_id, motivo_descuento_id, promocion_id)
     select $1, (row_number() over (order by n.numero, nl.linea))::int, nl.producto_id, nl.descripcion, nl.cantidad,
            round(nl.precio_unitario * $3::numeric, 4), nl.descuento_pct, nl.alicuota_iva_id, nl.producto_base_id, nl.lista_precio,
            round(nl.precio_lista * $3::numeric, 4), nl.costo_unitario_usd, nl.id, nl.motivo_descuento_id, nl.promocion_id
       from documento_venta_linea nl join documento_venta n on n.id = nl.documento_id
      where n.id = any($2::uuid[])`, [facturaId, ids, tasa]);
  await tx.query('select fn_venta_calcular($1)', [facturaId]);

  const { rows: tot } = await tx.query<{ total: string; total_usd: string; base_imponible: string; exento: string; iva: string }>(
    'select total::text, total_usd::text, base_imponible::text, exento::text, iva::text from documento_venta where id = $1', [facturaId]);
  if (new Decimal(tot[0].total).lte(0)) throw new ErrorMaestro('No se factura un total de cero.');

  // Se emite en contingencia provisional para obtener el número correlativo y pedir con él el número de control.
  const { rows: emitida } = await tx.query<{ numero: string; serie: string; fecha: string }>(
    `update documento_venta set estado = 'emitido', contingencia = true, contingencia_motivo = 'Pendiente del número de control'
      where id = $1 returning numero::text, serie, to_char(fecha_emision at time zone 'America/Caracas', 'YYYY-MM-DD') as fecha`, [facturaId]);
  const { numero, serie, fecha } = emitida[0];

  const control = await pedirControl(tx, opciones.servicio, {
    serie, numero, fechaEmision: fecha, emisorRif: emp[0].rif, receptorRif: cli[0].rif, totalVes: tot[0].total, ivaVes: tot[0].iva,
  });
  if (control.numeroControl) {
    await tx.query(
      `update documento_venta set numero_control = $2, contingencia = false, contingencia_motivo = null, imprenta = $3 where id = $1`,
      [facturaId, control.numeroControl, control.proveedor]);
  } else {
    await tx.query('update documento_venta set contingencia_motivo = $2 where id = $1', [facturaId, control.motivo]);
  }

  await tx.query('update documento_venta set factura_id = $1 where id = any($2::uuid[])', [facturaId, ids]);
  await tx.query(
    `insert into partida_cxc (cliente_id, documento_id, fecha, vencimiento, moneda, tasa, monto_original, monto_usd, saldo)
     select cliente_id, id, $2::date, fecha_vencimiento, 'VES', tasa, total, total_usd, total from documento_venta where id = $1`, [facturaId, hoy]);

  await contabilizar(tx, {
    evento: 'factura_venta', fecha: hoy, descripcion: `Factura de venta ${serie}-${numero}`,
    origen: { tipo: 'factura_venta', id: facturaId }, moneda: 'VES',
    importes: { total: tot[0].total, venta: dosDecimales(new Decimal(tot[0].base_imponible).plus(tot[0].exento)), iva: tot[0].iva },
    terceroId: notas[0].cliente_id, usuarioId: u.id,
  });

  return { facturaId, numero, numeroControl: control.numeroControl, contingencia: !control.numeroControl };
}

/** Pide el número de control; si el servicio falla o no existe, devuelve el motivo de la contingencia. */
async function pedirControl(
  tx: Db, servicio: ServicioNumeroControl | undefined, s: Parameters<ServicioNumeroControl['solicitar']>[1],
): Promise<{ numeroControl: string | null; proveedor?: string; motivo?: string }> {
  try {
    const svc = servicio ?? servicioImprenta();
    const r = await svc.solicitar(tx, s);
    return { numeroControl: r.numeroControl, proveedor: svc.proveedor };
  } catch (e) {
    const detalle = e instanceof Error ? e.message : 'error desconocido';
    return { numeroControl: null, motivo: `Contingencia: ${detalle}`.slice(0, 300) };
  }
}

/** Una factura emitida en contingencia recibe después su número de control. */
export async function asignarControlPendiente(tx: Db, u: Usuario, facturaId: string, opciones: OpcionesFactura = {}): Promise<string> {
  void u;
  const { rows } = await tx.query<{ estado: string; contingencia: boolean; serie: string; numero: string; fecha: string; total: string; iva: string; rif: string }>(
    `select d.estado, d.contingencia, d.serie, d.numero::text, to_char(d.fecha_emision at time zone 'America/Caracas', 'YYYY-MM-DD') as fecha,
            d.total::text, d.iva::text, t.rif
       from documento_venta d join tercero t on t.id = d.cliente_id
      where d.id = $1 and d.tipo = 'factura' for update of d`, [facturaId]);
  const f = rows[0];
  if (!f) throw new ErrorMaestro('La factura no existe.');
  if (f.estado !== 'emitido' || !f.contingencia) throw new ErrorMaestro('Esta factura no está pendiente de número de control.');
  const { rows: emp } = await tx.query<{ rif: string }>('select rif from empresa');
  const control = await pedirControl(tx, opciones.servicio, {
    serie: f.serie, numero: f.numero, fechaEmision: f.fecha, emisorRif: emp[0].rif, receptorRif: f.rif, totalVes: f.total, ivaVes: f.iva,
  });
  if (!control.numeroControl) throw new ErrorMaestro(`No se pudo obtener el número de control. ${control.motivo ?? ''}`.trim());
  await tx.query(
    `update documento_venta set numero_control = $2, contingencia = false, contingencia_motivo = null, imprenta = $3 where id = $1`,
    [facturaId, control.numeroControl, control.proveedor]);
  return control.numeroControl;
}

/**
 * Anula una factura emitida sin cobros aplicados: asiento inverso, partida anulada y las notas de entrega quedan libres.
 * El número de la factura anulada no se reutiliza y sigue en el libro como anulada (§11.4).
 */
export async function anularFactura(tx: Db, u: Usuario, id: string, motivo: MotivoDocumento, opciones: OpcionesFactura = {}): Promise<void> {
  const { rows } = await tx.query<{
    estado: string; serie: string; numero: string; numero_control: string | null; cliente_id: string; total: string; iva: string;
    base_imponible: string; exento: string; fecha: string;
  }>(
    `select estado, serie, numero::text, numero_control, cliente_id, total::text, iva::text, base_imponible::text, exento::text,
            to_char(fecha_emision at time zone 'America/Caracas', 'YYYY-MM-DD') as fecha
       from documento_venta where id = $1 and tipo = 'factura' for update`, [id]);
  const f = rows[0];
  if (!f) throw new ErrorMaestro('La factura no existe.');
  if (f.estado !== 'emitido') throw new ErrorMaestro('Solo se anula una factura emitida.');
  const texto = await textoDeAnulacion(tx, motivo);

  const { rows: p } = await tx.query<{ id: string; saldo: string; monto_original: string }>(
    'select id, saldo::text, monto_original::text from partida_cxc where documento_id = $1 for update', [id]);
  if (!p[0] || !new Decimal(p[0].saldo).equals(p[0].monto_original)) {
    throw new ErrorMaestro('La factura tiene cobros o notas de crédito aplicados: no se anula.');
  }

  await tx.query(`select set_config('app.cxc_interno', '1', true)`);
  await tx.query(`update partida_cxc set estado = 'anulada', saldo = 0 where id = $1`, [p[0].id]);
  await tx.query(`update documento_venta set factura_id = null where factura_id = $1`, [id]);
  await tx.query(
    `update documento_venta set estado = 'anulado', anulado_por = $2, anulado_motivo = $3, anulado_motivo_id = $4 where id = $1`,
    [id, u.id, texto, motivo.motivoId]);

  await contabilizar(tx, {
    evento: 'anulacion_factura', fecha: f.fecha, descripcion: `Anulación de la factura ${f.serie}-${f.numero}`,
    origen: { tipo: 'anulacion_factura', id }, moneda: 'VES',
    importes: { total: f.total, venta: dosDecimales(new Decimal(f.base_imponible).plus(f.exento)), iva: f.iva },
    terceroId: f.cliente_id, usuarioId: u.id,
  });

  if (f.numero_control) {
    try {
      await (opciones.servicio ?? servicioImprenta()).anular(tx, f.numero_control);
    } catch {
      // El aviso al proveedor se reintenta aparte: la anulación en el ERP ya quedó registrada.
    }
  }
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface NotaPorFacturar {
  id: string; numero: string; fecha: string; total_usd: string; pedido: string | null; cliente_id: string; cliente_codigo: string; cliente: string;
}

/** Notas de entrega despachadas y sin factura, de los clientes que el usuario puede ver. */
export async function notasPorFacturar(db: Db, u: Usuario): Promise<NotaPorFacturar[]> {
  if (!u.roles.some((r) => (ROLES_VEN_FACTURAS as readonly string[]).includes(r))) return [];
  const { rows } = await db.query<NotaPorFacturar>(
    `select n.id, n.numero::text, to_char(n.salida_at at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha, n.total_usd::text,
            p.numero::text as pedido, n.cliente_id, c.codigo as cliente_codigo, t.razon_social as cliente
       from documento_venta n
       join cliente c on c.tercero_id = n.cliente_id
       join tercero t on t.id = n.cliente_id
       left join vendedor v on v.id = n.vendedor_id
       left join documento_venta p on p.id = n.documento_origen_id
      where n.tipo = 'nota_entrega' and n.estado = 'emitido' and n.salida_at is not null and n.factura_id is null
        and ($1 or v.usuario_id = $2)
      order by t.razon_social, n.numero`, [verTodosLosDocumentos(u), u.id]);
  return rows;
}

export interface FilaFactura {
  id: string; numero: string; numero_control: string | null; contingencia: boolean; estado: string; fecha: string;
  cliente_codigo: string; cliente: string; total: string; total_usd: string; saldo: string | null; vencimiento: string | null;
}

export async function buscarFacturas(db: Db, u: Usuario, filtro: { estado?: string }, limite = 100): Promise<FilaFactura[]> {
  if (!u.roles.some((r) => (ROLES_VEN_FACTURAS as readonly string[]).includes(r))) return [];
  const { rows } = await db.query<FilaFactura>(
    `select d.id, d.numero::text, d.numero_control, d.contingencia, d.estado,
            to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha,
            c.codigo as cliente_codigo, t.razon_social as cliente, d.total::text, d.total_usd::text,
            p.saldo::text as saldo, to_char(d.fecha_vencimiento, 'DD-MM-YYYY') as vencimiento
       from documento_venta d
       join cliente c on c.tercero_id = d.cliente_id
       join tercero t on t.id = d.cliente_id
       left join vendedor v on v.id = d.vendedor_id
       left join partida_cxc p on p.documento_id = d.id
      where d.tipo = 'factura' and ($1 or v.usuario_id = $2)
        and ($3 = '' or d.estado = $3 or ($3 = 'contingencia' and d.contingencia and d.estado = 'emitido'))
      order by d.created_at desc limit $4`, [verTodosLosDocumentos(u), u.id, filtro.estado ?? '', limite]);
  return rows;
}

export interface LineaFactura {
  id: string; linea: number; codigo: string; descripcion: string; cantidad: string; precio_unitario: string; descuento_pct: string;
  alicuota_pct: string; base: string; iva: string; total: string;
}

export interface DetalleFactura {
  id: string; serie: string; numero: string; numero_control: string | null; contingencia: boolean; contingencia_motivo: string | null;
  imprenta: string | null; estado: string; fecha: string; vencimiento: string | null; tasa: string;
  subtotal: string; descuento: string; base_imponible: string; exento: string; iva: string; igtf: string; total: string; total_usd: string;
  anulado_motivo: string | null; vendedor_usuario: string | null; vendedor: string | null;
  cliente_id: string; cliente_codigo: string; cliente: string; cliente_rif: string; cliente_direccion: string | null; cliente_telefono: string | null;
  condicion_pago: string | null;
  empresa_rif: string | null; empresa_razon: string | null; empresa_domicilio: string | null;
  saldo: string | null; partida_estado: string | null;
  lineas: LineaFactura[];
  notas: { id: string; numero: string }[];
  desglose: { alicuota_pct: string; base: string; iva: string }[];
}

export async function detalleFactura(db: Db, id: string): Promise<DetalleFactura | null> {
  const { rows } = await db.query<Omit<DetalleFactura, 'lineas' | 'notas' | 'desglose'>>(
    `select d.id, d.serie, d.numero::text, d.numero_control, d.contingencia, d.contingencia_motivo, d.imprenta, d.estado,
            to_char(d.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha,
            to_char(d.fecha_vencimiento, 'DD-MM-YYYY') as vencimiento, d.tasa::text,
            d.subtotal::text, d.descuento::text, d.base_imponible::text, d.exento::text, d.iva::text, d.igtf::text, d.total::text, d.total_usd::text,
            d.anulado_motivo, v.usuario_id as vendedor_usuario, v.nombre as vendedor,
            c.tercero_id as cliente_id, c.codigo as cliente_codigo, t.razon_social as cliente, t.rif as cliente_rif,
            t.direccion_fiscal as cliente_direccion, t.telefono as cliente_telefono, cp.nombre as condicion_pago,
            e.rif as empresa_rif, e.razon_social as empresa_razon, e.domicilio_fiscal as empresa_domicilio,
            p.saldo::text as saldo, p.estado as partida_estado
       from documento_venta d
       join cliente c on c.tercero_id = d.cliente_id
       join tercero t on t.id = d.cliente_id
       left join vendedor v on v.id = d.vendedor_id
       left join condicion_pago cp on cp.id = c.condicion_pago_id
       left join empresa e on true
       left join partida_cxc p on p.documento_id = d.id
      where d.id = $1 and d.tipo = 'factura'`, [id]);
  if (!rows[0]) return null;
  const { rows: lineas } = await db.query<LineaFactura>(
    `select l.id, l.linea, p.codigo, l.descripcion, l.cantidad::text, l.precio_unitario::text, l.descuento_pct::text, l.alicuota_pct::text,
            l.base::text, l.iva::text, l.total::text
       from documento_venta_linea l join producto p on p.id = l.producto_id where l.documento_id = $1 order by l.linea`, [id]);
  const { rows: notas } = await db.query<{ id: string; numero: string }>(
    `select distinct n.id, n.numero::text from documento_venta_linea fl
       join documento_venta_linea nl on nl.id = fl.linea_origen_id join documento_venta n on n.id = nl.documento_id
      where fl.documento_id = $1 order by n.numero::text`, [id]);
  const { rows: desglose } = await db.query<{ alicuota_pct: string; base: string; iva: string }>(
    `select alicuota_pct::text, sum(base)::text as base, sum(iva)::text as iva from documento_venta_linea
      where documento_id = $1 group by alicuota_pct order by alicuota_pct desc`, [id]);
  return { ...rows[0], lineas, notas, desglose };
}
