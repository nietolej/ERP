import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { type Ventana } from '@/lib/maestros/direcciones';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { confirmarSalida } from './despacho';
import type { Usuario } from './pedidos';
import { exigirAlmacen } from './picking';

/**
 * Transporte y despacho (§6.4, migración 0026).
 *
 *   planificado → cargado → en_ruta → entregado → cerrado        (solo un planificado se anula)
 *
 * Cargar confirma la salida de mercancía de cada nota que aún no salió (despacho.ts). Las horas de salida, llegada y
 * resultado las pone la base de datos. Cada nota tiene una sola parada vigente: no puede estar en dos transportes.
 */

export const ROLES_TRANSPORTE = ['almacen', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_TRANSPORTE = ['almacen', 'gerencia', 'supervisor_ventas', 'facturacion', 'auditor'] as const satisfies readonly Rol[];
/** Constancia de entrega: la sube quien despacha o la recibe en destino. */
export const ROLES_CONSTANCIA = ['almacen', 'gerencia'] as const satisfies readonly Rol[];

export const ESTADOS_TRANSPORTE = ['planificado', 'cargado', 'en_ruta', 'entregado', 'cerrado', 'anulado'] as const;
export type EstadoTransporte = (typeof ESTADOS_TRANSPORTE)[number];
export const NOMBRE_ESTADO_TRANSPORTE: Record<EstadoTransporte, string> = {
  planificado: 'Planificado', cargado: 'Cargado', en_ruta: 'En ruta', entregado: 'Entregado', cerrado: 'Cerrado', anulado: 'Anulado',
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TransporteBase { id: string; estado: EstadoTransporte; almacen_id: string }

async function transporteDe(tx: Db, id: string): Promise<TransporteBase> {
  const { rows } = await tx.query<TransporteBase>('select id, estado, almacen_id from transporte where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El transporte no existe.');
  return rows[0];
}

/** Carga el transporte de una parada, con bloqueo, y verifica el almacén del usuario. */
async function transporteDeParada(tx: Db, u: Usuario, paradaId: string): Promise<{ transporte: TransporteBase; orden: number }> {
  const { rows } = await tx.query<{ transporte_id: string; orden: number }>(
    'select transporte_id, orden from transporte_parada where id = $1', [paradaId]);
  if (!rows[0]) throw new ErrorMaestro('La parada no existe.');
  const transporte = await transporteDe(tx, rows[0].transporte_id);
  await exigirAlmacen(tx, u, transporte.almacen_id);
  return { transporte, orden: rows[0].orden };
}

// ---------------------------------------------------------------------
// Crear y editar
// ---------------------------------------------------------------------

export interface DatosTransporte {
  almacenId: string;
  transportistaId: string;
  vehiculoId?: string;
  chofer?: string;
  fechaProgramada: string;
  observaciones?: string;
}

function validarDatos(d: DatosTransporte): void {
  if (!UUID.test(d.almacenId)) throw new ErrorMaestro('Seleccione el almacén de salida.');
  if (!UUID.test(d.transportistaId)) throw new ErrorMaestro('Seleccione el transportista.');
  if (d.vehiculoId && !UUID.test(d.vehiculoId)) throw new ErrorMaestro('Vehículo inválido.');
  if (!FECHA.test(d.fechaProgramada)) throw new ErrorMaestro('Indique la fecha programada.');
}

export async function crearTransporte(tx: Db, u: Usuario, d: DatosTransporte): Promise<string> {
  validarDatos(d);
  await exigirAlmacen(tx, u, d.almacenId);
  const { rows } = await tx.query<{ id: string }>(
    `insert into transporte (almacen_id, transportista_id, vehiculo_id, chofer, fecha_programada, observaciones, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [d.almacenId, d.transportistaId, d.vehiculoId || null, d.chofer?.trim() || null, d.fechaProgramada, d.observaciones?.trim() || null, u.id]);
  return rows[0].id;
}

/** Cambia los datos de un transporte planificado (la base lo rechaza en otro estado). */
export async function editarTransporte(tx: Db, u: Usuario, id: string, d: Omit<DatosTransporte, 'almacenId'>): Promise<void> {
  validarDatos({ ...d, almacenId: '00000000-0000-0000-0000-000000000000' });
  const t = await transporteDe(tx, id);
  await exigirAlmacen(tx, u, t.almacen_id);
  await tx.query(
    `update transporte set transportista_id = $2, vehiculo_id = $3, chofer = $4, fecha_programada = $5, observaciones = $6 where id = $1`,
    [id, d.transportistaId, d.vehiculoId || null, d.chofer?.trim() || null, d.fechaProgramada, d.observaciones?.trim() || null]);
}

// ---------------------------------------------------------------------
// Paradas
// ---------------------------------------------------------------------

/** Agrega una nota de entrega al final del recorrido. Sin dirección indicada usa la predeterminada del cliente. */
export async function agregarParada(tx: Db, u: Usuario, transporteId: string, d: { notaId: string; direccionId?: string }): Promise<string> {
  const t = await transporteDe(tx, transporteId);
  await exigirAlmacen(tx, u, t.almacen_id);
  if (t.estado !== 'planificado') throw new ErrorMaestro('Solo se agregan paradas a un transporte planificado.');
  const { rows: n } = await tx.query<{ cliente_id: string }>(
    `select cliente_id from documento_venta where id = $1 and tipo = 'nota_entrega'`, [d.notaId]);
  if (!n[0]) throw new ErrorMaestro('La nota de entrega no existe.');

  let direccionId = d.direccionId;
  if (!direccionId) {
    const { rows } = await tx.query<{ id: string }>(
      'select id from cliente_direccion_entrega where cliente_id = $1 and predeterminada and activa', [n[0].cliente_id]);
    if (!rows[0]) throw new ErrorMaestro('El cliente no tiene dirección de entrega: regístrela primero en la ficha del cliente.');
    direccionId = rows[0].id;
  }
  const { rows: o } = await tx.query<{ siguiente: number }>(
    'select coalesce(max(orden), 0)::int + 1 as siguiente from transporte_parada where transporte_id = $1', [transporteId]);
  const { rows } = await tx.query<{ id: string }>(
    `insert into transporte_parada (transporte_id, nota_entrega_id, direccion_entrega_id, orden) values ($1, $2, $3, $4) returning id`,
    [transporteId, d.notaId, direccionId, o[0].siguiente]);
  return rows[0].id;
}

/** Renumera las paradas de 1 a n sin dejar huecos. */
async function renumerar(tx: Db, transporteId: string): Promise<void> {
  await tx.query(
    `update transporte_parada p set orden = r.nuevo
       from (select id, row_number() over (order by orden)::int as nuevo from transporte_parada where transporte_id = $1) r
      where p.id = r.id and p.orden <> r.nuevo`, [transporteId]);
}

export async function quitarParada(tx: Db, u: Usuario, paradaId: string): Promise<void> {
  const { transporte } = await transporteDeParada(tx, u, paradaId);
  if (transporte.estado !== 'planificado') throw new ErrorMaestro('Solo se quitan paradas de un transporte planificado.');
  await tx.query('delete from transporte_parada where id = $1', [paradaId]);
  await renumerar(tx, transporte.id);
}

/** Sube o baja una parada una posición en el recorrido. */
export async function moverParada(tx: Db, u: Usuario, paradaId: string, sentido: 'subir' | 'bajar'): Promise<void> {
  const { transporte, orden } = await transporteDeParada(tx, u, paradaId);
  if (transporte.estado !== 'planificado') throw new ErrorMaestro('Solo se reordenan las paradas de un transporte planificado.');
  const vecino = sentido === 'subir' ? orden - 1 : orden + 1;
  const { rows } = await tx.query<{ id: string }>('select id from transporte_parada where transporte_id = $1 and orden = $2', [transporte.id, vecino]);
  if (!rows[0]) return;
  // La restricción de orden se comprueba al final de la transacción, así que el intercambio no choca.
  await tx.query('update transporte_parada set orden = $2 where id = $1', [paradaId, vecino]);
  await tx.query('update transporte_parada set orden = $2 where id = $1', [rows[0].id, orden]);
}

export async function cambiarDireccionParada(tx: Db, u: Usuario, paradaId: string, direccionId: string): Promise<void> {
  const { transporte } = await transporteDeParada(tx, u, paradaId);
  if (transporte.estado !== 'planificado') throw new ErrorMaestro('La dirección solo se cambia con el transporte planificado.');
  if (!UUID.test(direccionId)) throw new ErrorMaestro('Dirección inválida.');
  await tx.query('update transporte_parada set direccion_entrega_id = $2 where id = $1', [paradaId, direccionId]);
}

// ---------------------------------------------------------------------
// Avance del transporte
// ---------------------------------------------------------------------

/**
 * Carga el transporte: confirma la salida de mercancía de cada nota que aún no salió (con su asiento de costo de ventas) y
 * lo pasa a `cargado`. Todo en la misma transacción: si una nota no puede salir, no se carga nada.
 */
export async function cargarTransporte(tx: Db, u: Usuario, id: string): Promise<{ notasDespachadas: number }> {
  const t = await transporteDe(tx, id);
  await exigirAlmacen(tx, u, t.almacen_id);
  if (t.estado !== 'planificado') throw new ErrorMaestro('Solo se carga un transporte planificado.');
  const { rows } = await tx.query<{ nota_entrega_id: string }>(
    `select p.nota_entrega_id from transporte_parada p join documento_venta d on d.id = p.nota_entrega_id
      where p.transporte_id = $1 and d.salida_at is null order by p.orden`, [id]);
  for (const r of rows) await confirmarSalida(tx, u, r.nota_entrega_id);
  await tx.query(`update transporte set estado = 'cargado' where id = $1`, [id]);
  return { notasDespachadas: rows.length };
}

export async function salirARuta(tx: Db, u: Usuario, id: string): Promise<void> {
  const t = await transporteDe(tx, id);
  await exigirAlmacen(tx, u, t.almacen_id);
  if (t.estado !== 'cargado') throw new ErrorMaestro('Solo sale a ruta un transporte cargado.');
  await tx.query(`update transporte set estado = 'en_ruta' where id = $1`, [id]);
}

/** Con todas las paradas resueltas, el transporte pasa solo a `entregado`. */
async function avanzarSiResuelto(tx: Db, transporteId: string): Promise<void> {
  const { rows } = await tx.query<{ pendientes: number }>(
    'select count(*)::int as pendientes from transporte_parada where transporte_id = $1 and resultado is null', [transporteId]);
  if (rows[0].pendientes === 0) await tx.query(`update transporte set estado = 'entregado' where id = $1 and estado = 'en_ruta'`, [transporteId]);
}

function exigirEnRuta(t: TransporteBase): void {
  if (t.estado !== 'en_ruta') throw new ErrorMaestro('Solo se registran llegadas y resultados con el transporte en ruta.');
}

export async function registrarLlegada(tx: Db, u: Usuario, paradaId: string): Promise<void> {
  const { transporte } = await transporteDeParada(tx, u, paradaId);
  exigirEnRuta(transporte);
  await tx.query('update transporte_parada set llegada_at = now() where id = $1 and llegada_at is null', [paradaId]);
}

export async function registrarEntrega(tx: Db, u: Usuario, paradaId: string, d: { recibidoPor: string; incidencia?: string }): Promise<void> {
  const { transporte } = await transporteDeParada(tx, u, paradaId);
  exigirEnRuta(transporte);
  if (d.recibidoPor.trim().length < 2) throw new ErrorMaestro('Indique quién recibió la mercancía.');
  const { rows } = await tx.query<{ resultado: string | null }>('select resultado from transporte_parada where id = $1', [paradaId]);
  if (rows[0].resultado) throw new ErrorMaestro('Esta parada ya tiene su resultado.');
  await tx.query(
    `update transporte_parada set resultado = 'entregada', recibido_por = $2, incidencia = $3 where id = $1`,
    [paradaId, d.recibidoPor.trim(), d.incidencia?.trim() || null]);
  await avanzarSiResuelto(tx, transporte.id);
}

export async function registrarNoEntrega(tx: Db, u: Usuario, paradaId: string, incidencia: string): Promise<void> {
  const { transporte } = await transporteDeParada(tx, u, paradaId);
  exigirEnRuta(transporte);
  if (incidencia.trim().length < 3) throw new ErrorMaestro('Indique por qué no se pudo entregar.');
  const { rows } = await tx.query<{ resultado: string | null }>('select resultado from transporte_parada where id = $1', [paradaId]);
  if (rows[0].resultado) throw new ErrorMaestro('Esta parada ya tiene su resultado.');
  await tx.query(`update transporte_parada set resultado = 'no_entregada', incidencia = $2 where id = $1`, [paradaId, incidencia.trim()]);
  await avanzarSiResuelto(tx, transporte.id);
}

/** Cierra el transporte con el flete real en USD. Las paradas no entregadas quedan libres para otro transporte. */
export async function cerrarTransporte(tx: Db, u: Usuario, id: string, fleteUsd: string): Promise<void> {
  const t = await transporteDe(tx, id);
  await exigirAlmacen(tx, u, t.almacen_id);
  if (t.estado !== 'entregado') throw new ErrorMaestro('Solo se cierra un transporte con todas sus paradas resueltas.');
  const flete = fleteUsd.trim().replace(',', '.') || '0';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(flete)) throw new ErrorMaestro('El flete debe ser un monto en USD con hasta 2 decimales.');
  await tx.query(`update transporte set flete_usd = $2, estado = 'cerrado' where id = $1`, [id, new Decimal(flete).toFixed(2)]);
}

export async function anularTransporte(tx: Db, u: Usuario, id: string, motivo: string): Promise<void> {
  const t = await transporteDe(tx, id);
  await exigirAlmacen(tx, u, t.almacen_id);
  if (t.estado !== 'planificado') throw new ErrorMaestro('Solo se anula un transporte planificado: con la mercancía cargada ya salió del inventario.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  await tx.query(`update transporte set estado = 'anulado', anulado_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaTransporte {
  id: string; numero: string; estado: EstadoTransporte; fecha_programada: string; almacen: string;
  transportista: string; modalidad: string; paradas: number; entregadas: number;
}

export async function buscarTransportes(db: Db, u: Usuario, filtro: { estado?: string }, limite = 100): Promise<FilaTransporte[]> {
  if (!u.roles.some((r) => (ROLES_VEN_TRANSPORTE as readonly string[]).includes(r))) return [];
  const visibles = await almacenesVisibles(db, u);
  if (!visibles.length) return [];
  const { rows } = await db.query<FilaTransporte>(
    `select t.id, t.serie || '-' || t.numero as numero, t.estado, t.fecha_programada::text, a.codigo as almacen,
            tr.nombre as transportista, tr.modalidad,
            (select count(*)::int from transporte_parada where transporte_id = t.id) as paradas,
            (select count(*)::int from transporte_parada where transporte_id = t.id and resultado = 'entregada') as entregadas
       from transporte t
       join almacen a on a.id = t.almacen_id
       join transportista tr on tr.id = t.transportista_id
      where t.almacen_id = any($1::uuid[]) and ($2 = '' or t.estado = $2)
      order by (t.estado in ('cerrado', 'anulado')), t.fecha_programada desc, t.numero desc
      limit $3`, [visibles, filtro.estado ?? '', limite]);
  return rows;
}

export interface ParadaTransporte {
  id: string; orden: number; vigente: boolean;
  nota_id: string; nota_numero: string; cliente: string; cliente_id: string;
  direccion_id: string; direccion_nombre: string; direccion: string; ciudad: string; entidad_federal: string;
  ubicada: boolean; ventana_tipo: 'blanda' | 'dura'; ventanas: Ventana[];
  llegada: string | null; resultado: 'entregada' | 'no_entregada' | null; resultado_hora: string | null;
  recibido_por: string | null; incidencia: string | null; en_ventana: boolean | null;
  direcciones_cliente: { id: string; nombre: string; ciudad: string }[];
}

export interface DetalleTransporte {
  id: string; numero: string; estado: EstadoTransporte; almacen_id: string; almacen: string;
  transportista_id: string; transportista: string; modalidad: string;
  vehiculo_id: string | null; vehiculo: string | null; capacidad_kg: string | null; capacidad_m3: string | null;
  chofer: string | null; fecha_programada: string; observaciones: string | null;
  cargado: string | null; salida: string | null; cierre: string | null; flete_usd: string;
  anulado_motivo: string | null; creador: string;
  peso_kg: string; volumen_m3: string; lineas_sin_medidas: number;
  excede_peso: boolean; excede_volumen: boolean;
  salio_en_fecha: boolean | null; transito_seg: string | null;
  paradas: ParadaTransporte[];
}

const HORA_LOCAL = `'DD-MM-YYYY HH24:MI'`;

export async function detalleTransporte(db: Db, id: string): Promise<DetalleTransporte | null> {
  const { rows } = await db.query<Omit<DetalleTransporte, 'paradas' | 'excede_peso' | 'excede_volumen'>>(
    `select t.id, t.serie || '-' || t.numero as numero, t.estado, t.almacen_id, a.codigo || ' · ' || a.nombre as almacen,
            t.transportista_id, tr.nombre as transportista, tr.modalidad,
            t.vehiculo_id, v.placa || ' · ' || v.descripcion as vehiculo, v.capacidad_kg::text, v.capacidad_m3::text,
            t.chofer, t.fecha_programada::text, t.observaciones,
            to_char(t.cargado_at at time zone 'America/Caracas', ${HORA_LOCAL}) as cargado,
            to_char(t.salida_at at time zone 'America/Caracas', ${HORA_LOCAL}) as salida,
            to_char(t.cierre_at at time zone 'America/Caracas', ${HORA_LOCAL}) as cierre,
            t.flete_usd::text, t.anulado_motivo, u.nombre as creador,
            coalesce(c.peso_kg, 0)::text as peso_kg, coalesce(c.volumen_m3, 0)::text as volumen_m3,
            coalesce(c.lineas_sin_medidas, 0) as lineas_sin_medidas,
            r.salio_en_fecha, r.transito_seg::text
       from transporte t
       join almacen a on a.id = t.almacen_id
       join transportista tr on tr.id = t.transportista_id
       join usuario u on u.id = t.created_by
       left join vehiculo v on v.id = t.vehiculo_id
       left join vw_transporte_carga c on c.transporte_id = t.id
       left join vw_transporte_resumen r on r.transporte_id = t.id
      where t.id = $1`, [id]);
  const t = rows[0];
  if (!t) return null;

  const { rows: ps } = await db.query<Omit<ParadaTransporte, 'ventanas' | 'direcciones_cliente'>>(
    `select p.id, p.orden, p.vigente, n.id as nota_id, n.serie || '-' || n.numero as nota_numero, te.razon_social as cliente,
            n.cliente_id, d.id as direccion_id, d.nombre as direccion_nombre, d.direccion, d.ciudad, d.entidad_federal,
            (d.latitud is not null) as ubicada, d.ventana_tipo,
            to_char(p.llegada_at at time zone 'America/Caracas', ${HORA_LOCAL}) as llegada, p.resultado,
            to_char(p.resultado_at at time zone 'America/Caracas', ${HORA_LOCAL}) as resultado_hora,
            p.recibido_por, p.incidencia,
            case when p.llegada_at is null then null else fn_en_ventana(d.id, p.llegada_at) end as en_ventana
       from transporte_parada p
       join documento_venta n on n.id = p.nota_entrega_id
       join tercero te on te.id = n.cliente_id
       join cliente_direccion_entrega d on d.id = p.direccion_entrega_id
      where p.transporte_id = $1 order by p.orden`, [id]);

  const direcciones = ps.length ? (await db.query<{ id: string; cliente_id: string; nombre: string; ciudad: string }>(
    `select id, cliente_id, nombre, ciudad from cliente_direccion_entrega where cliente_id = any($1::uuid[]) and activa order by nombre`,
    [[...new Set(ps.map((p) => p.cliente_id))]])).rows : [];
  const ventanas = ps.length ? (await db.query<{ direccion_id: string; dia: number; desde: string; hasta: string }>(
    `select direccion_id, dia_semana as dia, to_char(hora_desde, 'HH24:MI') as desde, to_char(hora_hasta, 'HH24:MI') as hasta
       from cliente_direccion_ventana where direccion_id = any($1::uuid[]) order by dia_semana, hora_desde`,
    [[...new Set(ps.map((p) => p.direccion_id))]])).rows : [];

  const paradas: ParadaTransporte[] = ps.map((p) => ({
    ...p,
    ventanas: ventanas.filter((v) => v.direccion_id === p.direccion_id).map(({ dia, desde, hasta }) => ({ dia, desde, hasta })),
    direcciones_cliente: direcciones.filter((x) => x.cliente_id === p.cliente_id).map(({ id: i, nombre, ciudad }) => ({ id: i, nombre, ciudad })),
  }));
  return {
    ...t,
    paradas,
    excede_peso: t.capacidad_kg !== null && new Decimal(t.peso_kg).gt(t.capacidad_kg),
    excede_volumen: t.capacidad_m3 !== null && new Decimal(t.volumen_m3).gt(t.capacidad_m3),
  };
}

export interface NotaDespachable {
  id: string; numero: string; cliente: string; cliente_id: string; emitida: string; despachada: boolean;
  direcciones: number; ubicadas: number;
}

/** Notas de entrega listas para sumar a un transporte del almacén: emitidas, con picking completo (si lo usa) y sin parada vigente. */
export async function notasDespachables(db: Db, u: Usuario, almacenId: string): Promise<NotaDespachable[]> {
  if (!(await almacenesVisibles(db, u)).includes(almacenId)) return [];
  const { rows } = await db.query<NotaDespachable>(
    `select n.id, n.serie || '-' || n.numero as numero, te.razon_social as cliente, n.cliente_id,
            to_char(n.fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as emitida, (n.salida_at is not null) as despachada,
            (select count(*)::int from cliente_direccion_entrega d where d.cliente_id = n.cliente_id and d.activa) as direcciones,
            (select count(*)::int from cliente_direccion_entrega d where d.cliente_id = n.cliente_id and d.activa and d.latitud is not null) as ubicadas
       from documento_venta n
       join tercero te on te.id = n.cliente_id
       join almacen a on a.id = n.almacen_id
      where n.tipo = 'nota_entrega' and n.estado = 'emitido' and n.almacen_id = $1
        and not exists (select 1 from transporte_parada p where p.nota_entrega_id = n.id and p.vigente)
        and (not a.usa_picking or exists (
              select 1 from orden_picking o where o.nota_entrega_id = n.id and o.estado = 'completa' and o.empacada_at is not null))
      order by n.fecha_emision
      limit 200`, [almacenId]);
  return rows;
}
