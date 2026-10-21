import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { cancelarSolicitud, solicitarAprobacion } from '@/lib/flujo/flujo';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import type { Usuario } from './pedidos';

/**
 * Promociones (§6.1, migración 0027).
 *
 *   borrador (se arma con su alcance) → enviar → pendiente → Gerencia aprueba o rechaza → aprobada → vence por fecha o se anula
 *
 * Una promoción aprobada no se edita. El pedido la aplica solo (la mejor para la línea) y cada línea guarda cuál aplicó.
 */

export const ROLES_CREAN_PROMOCIONES = ['gerencia', 'supervisor_ventas'] as const satisfies readonly Rol[];
export const ROLES_VEN_PROMOCIONES = ['gerencia', 'supervisor_ventas', 'ventas', 'facturacion', 'auditor'] as const satisfies readonly Rol[];

export const TIPOS_PROMOCION = ['descuento_pct', 'precio_especial'] as const;
export type TipoPromocion = (typeof TIPOS_PROMOCION)[number];
export const NOMBRE_TIPO_PROMOCION: Record<TipoPromocion, string> = { descuento_pct: 'Descuento porcentual', precio_especial: 'Precio especial' };

export const TIPOS_ALCANCE = ['producto', 'codigo_comun', 'categoria', 'marca', 'cliente'] as const;
export type TipoAlcance = (typeof TIPOS_ALCANCE)[number];
export const NOMBRE_TIPO_ALCANCE: Record<TipoAlcance, string> = {
  producto: 'Producto', codigo_comun: 'Código común', categoria: 'Categoría (y subcategorías)', marca: 'Marca', cliente: 'Cliente',
};

export const ESTADOS_PROMOCION = ['borrador', 'pendiente', 'aprobada', 'rechazada', 'anulada'] as const;
export type EstadoPromocion = (typeof ESTADOS_PROMOCION)[number];

export const TONO_PROMOCION: Record<EstadoPromocion, 'info' | 'advertencia' | 'exito' | 'peligro'> = {
  borrador: 'info', pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro', anulada: 'peligro',
};
export const TEXTO_PROMOCION: Record<EstadoPromocion, string> = {
  borrador: 'Borrador', pendiente: 'Pendiente de aprobación', aprobada: 'Aprobada', rechazada: 'Rechazada', anulada: 'Anulada',
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;
const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const PRECIO = /^\d{1,12}(\.\d{1,2})?$/;

export interface DatosPromocion {
  nombre: string;
  descripcion?: string;
  tipo: TipoPromocion;
  /** Solo para el descuento porcentual. */
  descuentoPct?: string;
  /** Compra mínima por línea; vacío = sin mínimo. */
  cantidadMinima?: string;
  vigenteDesde: string;
  vigenteHasta: string;
}

function validar(d: DatosPromocion): { descuento: string | null; minima: string | null } {
  const errores: string[] = [];
  if (d.nombre.trim().length < 3) errores.push('Indique el nombre de la promoción.');
  if (!TIPOS_PROMOCION.includes(d.tipo)) errores.push('Seleccione el tipo de promoción.');
  if (!FECHA.test(d.vigenteDesde) || !FECHA.test(d.vigenteHasta)) errores.push('Indique desde y hasta cuándo rige la promoción.');
  else if (d.vigenteHasta < d.vigenteDesde) errores.push('La promoción no puede terminar antes de empezar.');
  let descuento: string | null = null;
  if (d.tipo === 'descuento_pct') {
    const v = (d.descuentoPct ?? '').trim().replace(',', '.');
    if (!PORCENTAJE.test(v) || new Decimal(v).lte(0) || new Decimal(v).gt(100)) errores.push('El descuento debe ser un porcentaje mayor que 0 y hasta 100.');
    else descuento = new Decimal(v).toFixed(2);
  }
  let minima: string | null = null;
  const m = (d.cantidadMinima ?? '').trim().replace(',', '.');
  if (m) {
    if (!CANTIDAD.test(m) || new Decimal(m).lte(0)) errores.push('La compra mínima debe ser un número mayor que cero.');
    else minima = m;
  }
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
  return { descuento, minima };
}

async function promocion(tx: Db, id: string): Promise<{ id: string; estado: EstadoPromocion; tipo: TipoPromocion; created_by: string }> {
  const { rows } = await tx.query<{ id: string; estado: EstadoPromocion; tipo: TipoPromocion; created_by: string }>(
    'select id, estado, tipo, created_by from promocion where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('La promoción no existe.');
  return rows[0];
}

export async function crearPromocion(tx: Db, u: Usuario, d: DatosPromocion): Promise<{ id: string; codigo: string }> {
  const { descuento, minima } = validar(d);
  const { rows } = await tx.query<{ id: string; codigo: string }>(
    `insert into promocion (nombre, descripcion, tipo, descuento_pct, cantidad_minima, vigente_desde, vigente_hasta, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, codigo`,
    [d.nombre.trim(), d.descripcion?.trim() || null, d.tipo, descuento, minima, d.vigenteDesde, d.vigenteHasta, u.id]);
  return rows[0];
}

/** Cambia los datos de una promoción en borrador (la base lo rechaza en otro estado). */
export async function editarPromocion(tx: Db, id: string, d: DatosPromocion): Promise<void> {
  const { descuento, minima } = validar(d);
  await promocion(tx, id);
  await tx.query(
    `update promocion set nombre = $2, descripcion = $3, tipo = $4, descuento_pct = $5, cantidad_minima = $6, vigente_desde = $7, vigente_hasta = $8
      where id = $1`,
    [id, d.nombre.trim(), d.descripcion?.trim() || null, d.tipo, descuento, minima, d.vigenteDesde, d.vigenteHasta]);
}

// ---------------------------------------------------------------------
// Alcance
// ---------------------------------------------------------------------

export interface DatosAlcance {
  tipo: TipoAlcance;
  entidadId: string;
  /** Solo para una promoción de precio especial, por producto. */
  precioEspecialUsd?: string;
}

export async function agregarAlcance(tx: Db, id: string, d: DatosAlcance): Promise<string> {
  if (!TIPOS_ALCANCE.includes(d.tipo)) throw new ErrorMaestro('Seleccione a qué aplica la promoción.');
  const p = await promocion(tx, id);
  if (p.estado !== 'borrador') throw new ErrorMaestro('El alcance solo se cambia mientras la promoción está en borrador.');
  let precio: string | null = null;
  if (d.precioEspecialUsd?.trim()) {
    const v = d.precioEspecialUsd.trim().replace(',', '.');
    if (!PRECIO.test(v) || new Decimal(v).lte(0)) throw new ErrorMaestro('El precio especial debe ser un monto en USD mayor que cero.');
    precio = new Decimal(v).toFixed(2);
  }
  const { rows: previo } = await tx.query('select 1 from promocion_alcance where promocion_id = $1 and tipo = $2 and entidad_id = $3', [id, d.tipo, d.entidadId]);
  if (previo.length) throw new ErrorMaestro('Ese elemento ya está en el alcance de la promoción.');
  const { rows } = await tx.query<{ id: string }>(
    'insert into promocion_alcance (promocion_id, tipo, entidad_id, precio_especial_usd) values ($1, $2, $3, $4) returning id',
    [id, d.tipo, d.entidadId, precio]);
  return rows[0].id;
}

/** Igual que agregarAlcance, pero identifica el elemento por su código visible (producto, código común, categoría, marca o cliente). */
export async function agregarAlcancePorCodigo(tx: Db, id: string, d: { tipo: TipoAlcance; codigo: string; precioEspecialUsd?: string }): Promise<string> {
  const codigo = d.codigo.trim();
  if (!codigo) throw new ErrorMaestro('Indique el código.');
  const consulta: Record<TipoAlcance, string> = {
    producto: 'select id from producto where upper(codigo) = upper($1)',
    codigo_comun: 'select id from producto_base where upper(codigo) = upper($1)',
    categoria: 'select id from categoria_producto where upper(codigo) = upper($1)',
    marca: 'select id from marca where upper(codigo) = upper($1)',
    cliente: 'select tercero_id as id from cliente where upper(codigo) = upper($1)',
  };
  if (!consulta[d.tipo]) throw new ErrorMaestro('Seleccione a qué aplica la promoción.');
  const { rows } = await tx.query<{ id: string }>(consulta[d.tipo], [codigo]);
  if (!rows[0]) throw new ErrorMaestro(`No existe ${NOMBRE_TIPO_ALCANCE[d.tipo].toLowerCase()} con el código ${codigo}.`);
  return agregarAlcance(tx, id, { tipo: d.tipo, entidadId: rows[0].id, precioEspecialUsd: d.precioEspecialUsd });
}

export async function quitarAlcance(tx: Db, alcanceId: string): Promise<void> {
  const { rows } = await tx.query<{ promocion_id: string }>('select promocion_id from promocion_alcance where id = $1', [alcanceId]);
  if (!rows[0]) throw new ErrorMaestro('El elemento no existe.');
  const p = await promocion(tx, rows[0].promocion_id);
  if (p.estado !== 'borrador') throw new ErrorMaestro('El alcance solo se cambia mientras la promoción está en borrador.');
  await tx.query('delete from promocion_alcance where id = $1', [alcanceId]);
}

// ---------------------------------------------------------------------
// Aprobación y anulación
// ---------------------------------------------------------------------

/** Envía la promoción a Gerencia (motor de flujo). La base exige que tenga alcance y, si es de precio especial, sus precios. */
export async function enviarAprobacion(tx: Db, u: Usuario, id: string): Promise<void> {
  const p = await promocion(tx, id);
  if (p.estado !== 'borrador') throw new ErrorMaestro('Solo se envía a aprobación una promoción en borrador.');
  await tx.query(`update promocion set estado = 'pendiente' where id = $1`, [id]);
  await solicitarAprobacion(tx, { tipo: 'promocion', objetoId: id, solicitanteId: u.id });
}

/** Lo llama el motor de flujo cuando Gerencia aprueba (la base exige que no sea quien la creó). */
export async function aprobarPromocion(tx: Db, id: string, aprobador: string): Promise<void> {
  const p = await promocion(tx, id);
  if (p.estado !== 'pendiente') throw new ErrorMaestro('La promoción no está pendiente de aprobación.');
  await tx.query(`update promocion set estado = 'aprobada', aprobado_por = $2 where id = $1`, [id, aprobador]);
}

export async function rechazarPromocion(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const p = await promocion(tx, id);
  if (p.estado !== 'pendiente') throw new ErrorMaestro('La promoción no está pendiente de aprobación.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo del rechazo.');
  await tx.query(`update promocion set estado = 'rechazada', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

/** Anula una promoción que aún no es definitiva. Lo ya vendido conserva su vínculo con ella. */
export async function anularPromocion(tx: Db, id: string, motivo: string): Promise<void> {
  const p = await promocion(tx, id);
  if (!['borrador', 'pendiente', 'aprobada'].includes(p.estado)) throw new ErrorMaestro('Esa promoción ya no se puede anular.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  await tx.query(`update promocion set estado = 'anulada', anulado_motivo = $2 where id = $1`, [id, motivo.trim()]);
  if (p.estado === 'pendiente') await cancelarSolicitud(tx, 'promocion', id);
}

// ---------------------------------------------------------------------
// Aplicación a una línea de venta
// ---------------------------------------------------------------------

export interface PromocionDeLinea {
  promocionId: string;
  precioUnitario: string;
  descuentoPct: string;
  precioNeto: string;
}

/** La mejor promoción vigente para el producto, el cliente y la cantidad (la decide la base). Null si ninguna mejora el precio de lista. */
export async function promocionParaLinea(
  tx: Db, d: { productoId: string; clienteId: string; fecha: string; cantidad: string; precioLista: string },
): Promise<PromocionDeLinea | null> {
  const { rows } = await tx.query<{ promocion_id: string; precio_unitario: string; descuento_pct: string; precio_neto: string }>(
    'select promocion_id, precio_unitario::text, descuento_pct::text, precio_neto::text from fn_promocion_para_linea($1, $2, $3::date, $4::numeric, $5::numeric)',
    [d.productoId, d.clienteId, d.fecha, d.cantidad, d.precioLista]);
  return rows[0]
    ? { promocionId: rows[0].promocion_id, precioUnitario: rows[0].precio_unitario, descuentoPct: rows[0].descuento_pct, precioNeto: rows[0].precio_neto }
    : null;
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaPromocion {
  id: string; codigo: string; nombre: string; tipo: TipoPromocion; estado: EstadoPromocion;
  descuento_pct: string | null; vigente_desde: string; vigente_hasta: string; vigente_hoy: boolean;
  lineas: number; unidades: string; descuento_usd: string;
}

export async function buscarPromociones(db: Db, filtro: { estado?: string } = {}, limite = 100): Promise<FilaPromocion[]> {
  const estado = (ESTADOS_PROMOCION as readonly string[]).includes(filtro.estado ?? '') ? filtro.estado! : '';
  const { rows } = await db.query<FilaPromocion>(
    `select p.id, p.codigo, p.nombre, p.tipo, p.estado, p.descuento_pct::text, p.vigente_desde::text, p.vigente_hasta::text,
            (p.estado = 'aprobada' and ((now() at time zone 'America/Caracas')::date) between p.vigente_desde and p.vigente_hasta) as vigente_hoy,
            a.lineas, a.unidades::text, a.descuento_usd::text
       from promocion p join vw_promocion_aplicada a on a.promocion_id = p.id
      where ($1 = '' or p.estado = $1)
      order by (p.estado in ('rechazada', 'anulada')), p.vigente_hasta desc, p.codigo desc
      limit $2`, [estado, limite]);
  return rows;
}

export interface DetallePromocion {
  id: string; codigo: string; nombre: string; descripcion: string | null; tipo: TipoPromocion; estado: EstadoPromocion;
  descuento_pct: string | null; cantidad_minima: string | null; vigente_desde: string; vigente_hasta: string;
  creador: string; creador_id: string; aprobador: string | null; rechazo_motivo: string | null; anulado_motivo: string | null;
  alcance: { id: string; tipo: TipoAlcance; codigo: string; nombre: string; precio_especial_usd: string | null }[];
  aplicada: { lineas: number; notas: number; unidades: string; venta_lista_usd: string; venta_cobrada_usd: string; descuento_usd: string };
}

export async function detallePromocion(db: Db, id: string): Promise<DetallePromocion | null> {
  const { rows } = await db.query<Omit<DetallePromocion, 'alcance' | 'aplicada'>>(
    `select p.id, p.codigo, p.nombre, p.descripcion, p.tipo, p.estado, p.descuento_pct::text, p.cantidad_minima::text,
            p.vigente_desde::text, p.vigente_hasta::text, u.nombre as creador, p.created_by as creador_id, ua.nombre as aprobador,
            p.rechazo_motivo, p.anulado_motivo
       from promocion p join usuario u on u.id = p.created_by left join usuario ua on ua.id = p.aprobado_por
      where p.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: alcance } = await db.query<DetallePromocion['alcance'][number]>(
    `select a.id, a.tipo, a.precio_especial_usd::text,
            case a.tipo when 'producto' then p.codigo when 'codigo_comun' then pb.codigo when 'categoria' then c.codigo
                        when 'marca' then m.codigo when 'cliente' then cl.codigo end as codigo,
            case a.tipo when 'producto' then p.descripcion when 'codigo_comun' then pb.descripcion when 'categoria' then c.nombre
                        when 'marca' then m.nombre when 'cliente' then t.razon_social end as nombre
       from promocion_alcance a
       left join producto p on a.tipo = 'producto' and p.id = a.entidad_id
       left join producto_base pb on a.tipo = 'codigo_comun' and pb.id = a.entidad_id
       left join categoria_producto c on a.tipo = 'categoria' and c.id = a.entidad_id
       left join marca m on a.tipo = 'marca' and m.id = a.entidad_id
       left join cliente cl on a.tipo = 'cliente' and cl.tercero_id = a.entidad_id
       left join tercero t on t.id = cl.tercero_id
      where a.promocion_id = $1 order by (a.tipo = 'cliente'), a.tipo, codigo`, [id]);
  const { rows: ap } = await db.query<DetallePromocion['aplicada']>(
    `select lineas, notas, unidades::text, venta_lista_usd::text, venta_cobrada_usd::text, descuento_usd::text from vw_promocion_aplicada where promocion_id = $1`, [id]);
  return { ...rows[0], alcance, aplicada: ap[0] };
}
