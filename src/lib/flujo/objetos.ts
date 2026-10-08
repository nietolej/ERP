import { aprobarAsiento } from '@/lib/contabilidad/manual';
import type { Db } from '@/lib/db/tipos';
import { aprobarFactura, rechazarFactura } from '@/lib/compras/facturas';
import { aprobarOrden, rechazarOrden } from '@/lib/compras/ordenes';
import { aplicarAjuste, rechazarAjuste } from '@/lib/inventario/ajustes';
import { aprobarCliente, type DatosCredito } from '@/lib/maestros/clientes';
import { aprobarLoteMetas, rechazarLoteMetas } from '@/lib/maestros/metas';
import { aprobarCambio, aprobarProveedor, rechazarCambio } from '@/lib/maestros/proveedores';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { aprobarPedidoCredito, rechazarPedidoCredito } from '@/lib/ventas/pedidos';
import { decidirAprobacion, type Decision, type Manejador, type ResultadoDecision } from './flujo';

/**
 * Objetos que pasan por el motor de aprobaciones (§4.5): qué hace cada módulo al aprobar o rechazar,
 * cómo se llama en pantalla y dónde se revisa. Agregar un tipo nuevo = registrarlo aquí, sembrar su
 * definición en `flujo_definicion` y llamar a `solicitarAprobacion` al crear el objeto.
 */

export interface TipoObjeto {
  etiqueta: string;
  /** Pantalla donde se revisa y se decide. */
  ruta(id: string, db?: Db): Promise<string> | string;
  /** Texto corto de cada objeto, para la bandeja (por lote de ids). */
  resumenes(db: Db, ids: string[]): Promise<Map<string, string>>;
  manejador: Manejador<unknown>;
}

async function consulta(db: Db, sql: string, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; texto: string }>(sql, [ids]);
  return new Map(rows.map((r) => [r.id, r.texto]));
}

export const MANEJADOR_CLIENTE: Manejador<void> = {
  alAprobar: (tx, id, aprobador, datos) => aprobarCliente(tx, id, aprobador, datos as unknown as DatosCredito),
};

export const MANEJADOR_PROVEEDOR: Manejador<void> = {
  alAprobar: (tx, id, aprobador, datos) => aprobarProveedor(tx, id, aprobador, String(datos.condicionPagoId ?? '')),
};

export const MANEJADOR_CAMBIO_PROVEEDOR: Manejador<void> = {
  alAprobar: (tx, id, aprobador) => aprobarCambio(tx, id, aprobador),
  alRechazar: (tx, id, usuario, motivo) => rechazarCambio(tx, id, usuario, motivo),
};

export const MANEJADOR_ASIENTO: Manejador<string> = {
  alAprobar: (tx, id, aprobador, datos) => aprobarAsiento(tx, id, aprobador, String(datos.huella ?? '')),
};

export const MANEJADOR_META_LOTE: Manejador<void> = {
  alAprobar: (tx, id, aprobador) => aprobarLoteMetas(tx, id, aprobador),
  alRechazar: (tx, id, usuario, motivo) => rechazarLoteMetas(tx, id, usuario, motivo),
};

export const MANEJADOR_PEDIDO_CREDITO: Manejador<void> = {
  alAprobar: (tx, id, aprobador) => aprobarPedidoCredito(tx, id, aprobador),
  alRechazar: (tx, id, usuario, motivo) => rechazarPedidoCredito(tx, id, usuario, motivo),
};

export const MANEJADOR_AJUSTE_INVENTARIO: Manejador<void> = {
  alAprobar: async (tx, id, aprobador) => { await aplicarAjuste(tx, id, aprobador); },
  alRechazar: (tx, id, usuario, motivo) => rechazarAjuste(tx, id, usuario, motivo),
};

export const MANEJADOR_ORDEN_COMPRA: Manejador<void> = {
  alAprobar: (tx, id, aprobador) => aprobarOrden(tx, id, aprobador),
  alRechazar: (tx, id, usuario, motivo) => rechazarOrden(tx, id, usuario, motivo),
};

export const MANEJADOR_FACTURA_COMPRA: Manejador<void> = {
  alAprobar: (tx, id, aprobador) => aprobarFactura(tx, id, aprobador),
  alRechazar: (tx, id, usuario, motivo) => rechazarFactura(tx, id, usuario, motivo),
};

export const TIPOS_OBJETO: Record<string, TipoObjeto> = {
  cliente: {
    etiqueta: 'Alta de cliente',
    ruta: (id) => `/maestros/clientes/${id}`,
    resumenes: (db, ids) => consulta(db,
      `select c.tercero_id::text as id, c.codigo || ' · ' || t.razon_social as texto
         from cliente c join tercero t on t.id = c.tercero_id where c.tercero_id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_CLIENTE,
  },
  proveedor: {
    etiqueta: 'Alta de proveedor',
    ruta: (id) => `/maestros/proveedores/${id}`,
    resumenes: (db, ids) => consulta(db,
      `select p.tercero_id::text as id, p.codigo || ' · ' || t.razon_social as texto
         from proveedor p join tercero t on t.id = p.tercero_id where p.tercero_id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_PROVEEDOR,
  },
  proveedor_cambio: {
    etiqueta: 'Cambio de datos de proveedor',
    ruta: async (id, db) => {
      const { rows } = await (db as Db).query<{ proveedor_id: string }>('select proveedor_id from proveedor_cambio where id = $1', [id]);
      return rows[0] ? `/maestros/proveedores/${rows[0].proveedor_id}` : '/maestros/proveedores';
    },
    resumenes: (db, ids) => consulta(db,
      `select c.id::text as id, p.codigo || ' · ' || t.razon_social as texto
         from proveedor_cambio c join proveedor p on p.tercero_id = c.proveedor_id join tercero t on t.id = p.tercero_id
        where c.id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_CAMBIO_PROVEEDOR,
  },
  asiento_manual: {
    etiqueta: 'Asiento manual',
    ruta: (id) => `/contabilidad/asientos/${id}`,
    resumenes: (db, ids) => consulta(db, `select id::text as id, descripcion as texto from asiento where id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_ASIENTO,
  },
  pedido_credito: {
    etiqueta: 'Pedido retenido por crédito',
    ruta: (id) => `/ventas/pedidos/${id}`,
    resumenes: (db, ids) => consulta(db,
      `select d.id::text as id, 'Pedido ' || d.numero || ' · ' || c.codigo || ' · US$ ' || d.total_usd as texto
         from documento_venta d join cliente c on c.tercero_id = d.cliente_id where d.id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_PEDIDO_CREDITO,
  },
  ajuste_inventario: {
    etiqueta: 'Ajuste de inventario',
    ruta: (id) => `/inventario/ajustes/${id}`,
    resumenes: (db, ids) => consulta(db,
      `select a.id::text as id, 'Ajuste ' || a.numero || ' · almacén ' || al.codigo as texto
         from ajuste_inventario a join almacen al on al.id = a.almacen_id where a.id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_AJUSTE_INVENTARIO,
  },
  orden_compra: {
    etiqueta: 'Orden de compra',
    ruta: (id) => `/compras/ordenes/${id}`,
    resumenes: (db, ids) => consulta(db,
      `select d.id::text as id, 'Orden ' || d.numero || ' · ' || p.codigo || ' · US$ ' || d.total_usd as texto
         from documento_compra d join proveedor p on p.tercero_id = d.proveedor_id where d.id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_ORDEN_COMPRA,
  },
  factura_compra: {
    etiqueta: 'Factura de compra retenida',
    ruta: (id) => `/compras/facturas/${id}`,
    resumenes: (db, ids) => consulta(db,
      `select f.id::text as id, 'Factura ' || f.numero_factura || ' · ' || p.codigo || ' · US$ ' || f.total_usd as texto
         from factura_compra f join proveedor p on p.tercero_id = f.proveedor_id where f.id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_FACTURA_COMPRA,
  },
  meta_lote: {
    etiqueta: 'Lote de metas de venta',
    ruta: (id) => `/metas/lote/${id}`,
    resumenes: (db, ids) => consulta(db, `select id::text as id, 'Lote v' || version as texto from meta_lote where id = any($1::uuid[])`, ids),
    manejador: MANEJADOR_META_LOTE,
  },
};

export function tipoObjeto(tipo: string): TipoObjeto {
  const t = TIPOS_OBJETO[tipo];
  if (!t) throw new ErrorMaestro(`El tipo de objeto ${tipo} no pasa por el flujo de aprobaciones.`);
  return t;
}

/** Registra la decisión de un usuario sobre un objeto y ejecuta lo que su módulo haga al aprobar o rechazar. */
export function resolverAprobacion(
  tx: Db, tipo: string, objetoId: string, usuarioId: string, decision: Decision,
  extra: { comentario?: string; datos?: Record<string, unknown> } = {},
): Promise<ResultadoDecision<unknown>> {
  return decidirAprobacion(tx, { tipo, objetoId, usuarioId, decision, ...extra }, tipoObjeto(tipo).manejador);
}
