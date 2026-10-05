import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Ajuste de inventario (§4.3, §8.3): conteo contra el sistema, con aprobación. Migración 0020.
 *
 *   borrador (Almacén cuenta y agrega líneas) → enviar → pendiente → Gerencia aprueba o rechaza
 *   al aprobar: movimientos de inventario por la diferencia de cada línea + asiento de faltantes y sobrantes
 *
 * Nunca aprueba quien creó el ajuste ni quien hizo el conteo. La diferencia se calcula contra lo que decía el sistema
 * cuando se contó (no contra el saldo del día de la aprobación), así los movimientos intermedios no se pierden.
 */

export const ROLES_AJUSTAN = ['almacen', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_AJUSTES = ['almacen', 'gerencia', 'compras', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

export type Usuario = { id: string; roles: readonly string[] };

const CANTIDAD = /^\d{1,10}(\.\d{1,4})?$/;
const COSTO = /^\d{1,12}(\.\d{1,4})?$/;

interface Ajuste { id: string; estado: string; almacen_id: string; created_by: string; contado_por: string }

async function ajuste(tx: Db, id: string, bloquear = true): Promise<Ajuste> {
  const { rows } = await tx.query<Ajuste>(
    `select id, estado, almacen_id, created_by, contado_por from ajuste_inventario where id = $1 ${bloquear ? 'for update' : ''}`, [id]);
  if (!rows[0]) throw new ErrorMaestro('El ajuste de inventario no existe.');
  return rows[0];
}

async function exigirAlmacen(tx: Db, u: Usuario, almacenId: string): Promise<void> {
  if (!(await almacenesVisibles(tx, u)).includes(almacenId)) throw new ErrorMaestro('Ese almacén no está entre los suyos.');
}

async function exigirBorrador(tx: Db, u: Usuario, id: string): Promise<Ajuste> {
  const a = await ajuste(tx, id);
  await exigirAlmacen(tx, u, a.almacen_id);
  if (a.estado !== 'borrador') throw new ErrorMaestro('Solo se edita un ajuste en borrador.');
  return a;
}

export async function crearAjuste(
  tx: Db, u: Usuario, d: { almacenId: string; observaciones?: string; contadoPorId?: string },
): Promise<string> {
  await exigirAlmacen(tx, u, d.almacenId);
  const contado = d.contadoPorId || u.id;
  const { rows: usr } = await tx.query('select 1 from usuario where id = $1 and activo', [contado]);
  if (!usr.length) throw new ErrorMaestro('Seleccione quién hizo el conteo.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into ajuste_inventario (almacen_id, observaciones, contado_por, created_by) values ($1, $2, $3, $4) returning id`,
    [d.almacenId, d.observaciones?.trim() || null, contado, u.id]);
  return rows[0].id;
}

/**
 * Agrega (o reemplaza) lo contado de un producto. Toma lo que dice el sistema en este momento como referencia.
 * Una diferencia exige motivo; un sobrante de un producto sin costo exige el costo unitario.
 */
export async function guardarLinea(
  tx: Db, u: Usuario, ajusteId: string,
  d: { productoId: string; cantidadContada: string; motivoId?: string; costoUnitario?: string },
): Promise<void> {
  const a = await exigirBorrador(tx, u, ajusteId);
  const contada = d.cantidadContada.trim();
  if (!CANTIDAD.test(contada)) throw new ErrorMaestro('La cantidad contada debe ser un número (0 o más) con hasta 4 decimales.');
  const { rows: prod } = await tx.query<{ estado: string; inventariable: boolean; sistema: string; costo: string }>(
    `select p.estado, p.inventariable,
            coalesce((select e.cantidad from existencia e where e.producto_id = p.id and e.almacen_id = $2), 0)::text as sistema,
            coalesce((select c.costo_promedio_usd from producto_costo c where c.producto_id = p.id), 0)::text as costo
       from producto p where p.id = $1`, [d.productoId, a.almacen_id]);
  const p = prod[0];
  if (!p) throw new ErrorMaestro('El producto no existe.');
  if (!p.inventariable) throw new ErrorMaestro('Ese producto no maneja inventario.');
  if (p.estado !== 'activo') throw new ErrorMaestro('El producto está inactivo.');

  const diferencia = new Decimal(contada).minus(p.sistema);
  if (!diferencia.isZero() && !d.motivoId) throw new ErrorMaestro('Indique el motivo de la diferencia.');
  let costo: string | null = null;
  if (diferencia.gt(0) && new Decimal(p.costo).isZero()) {
    const c = d.costoUnitario?.trim() ?? '';
    if (!COSTO.test(c) || new Decimal(c).lte(0)) {
      throw new ErrorMaestro('El producto todavía no tiene costo: indique el costo unitario en USD del sobrante.');
    }
    costo = c;
  }
  await tx.query('delete from ajuste_inventario_linea where ajuste_id = $1 and producto_id = $2', [ajusteId, d.productoId]);
  await tx.query(
    `insert into ajuste_inventario_linea (ajuste_id, linea, producto_id, cantidad_sistema, cantidad_contada, costo_unitario_usd, motivo_id)
     values ($1, (select coalesce(max(linea), 0) + 1 from ajuste_inventario_linea where ajuste_id = $1), $2, $3, $4, $5, $6)`,
    [ajusteId, d.productoId, p.sistema, contada, costo, diferencia.isZero() ? null : d.motivoId]);
}

export async function quitarLinea(tx: Db, u: Usuario, ajusteId: string, lineaId: string): Promise<void> {
  await exigirBorrador(tx, u, ajusteId);
  await tx.query('delete from ajuste_inventario_linea where id = $2 and ajuste_id = $1', [ajusteId, lineaId]);
}

export async function eliminarBorrador(tx: Db, u: Usuario, ajusteId: string): Promise<void> {
  await exigirBorrador(tx, u, ajusteId);
  await tx.query('delete from ajuste_inventario where id = $1', [ajusteId]);
}

/** Envía el ajuste a aprobación: queda con su número y ya no se edita. */
export async function enviarAjuste(tx: Db, u: Usuario, id: string): Promise<void> {
  await exigirBorrador(tx, u, id);
  const { rows } = await tx.query<{ valor: string }>(
    `select coalesce(sum(abs(l.diferencia) * coalesce(l.costo_unitario_usd, c.costo_promedio_usd, 0)), 0)::numeric(16,2)::text as valor
       from ajuste_inventario_linea l left join producto_costo c on c.producto_id = l.producto_id where l.ajuste_id = $1`, [id]);
  await tx.query(`update ajuste_inventario set estado = 'pendiente' where id = $1`, [id]);
  await solicitarAprobacion(tx, { tipo: 'ajuste_inventario', objetoId: id, solicitanteId: u.id, contexto: { valor_usd: Number(rows[0].valor) } });
}

/** Lo llama el motor de flujo cuando Gerencia aprueba: aplica las diferencias y contabiliza. */
export async function aplicarAjuste(tx: Db, id: string, aprobador: string): Promise<{ faltanteUsd: string; sobranteUsd: string }> {
  const a = await ajuste(tx, id);
  if (a.estado !== 'pendiente') throw new ErrorMaestro('El ajuste no está pendiente de aprobación.');
  // La base valida el rol y que no sea quien lo creó ni quien contó.
  await tx.query(`update ajuste_inventario set estado = 'aprobado', aprobado_por = $2 where id = $1`, [id, aprobador]);

  const { rows: lineas } = await tx.query<{ producto_id: string; diferencia: string; costo_unitario_usd: string | null; costo_promedio: string }>(
    `select l.producto_id, l.diferencia::text, l.costo_unitario_usd::text,
            coalesce((select c.costo_promedio_usd from producto_costo c where c.producto_id = l.producto_id), 0)::text as costo_promedio
       from ajuste_inventario_linea l where l.ajuste_id = $1 and l.diferencia <> 0 order by l.linea`, [id]);

  let faltante = new Decimal(0);
  let sobrante = new Decimal(0);
  for (const l of lineas) {
    const dif = new Decimal(l.diferencia);
    if (dif.lt(0)) {
      const { rows } = await tx.query<{ costo_total_usd: string }>(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
         values ('ajuste_negativo', $1, $2, $3, 0, 'ajuste_inventario', $4, $5) returning costo_total_usd::text`,
        [l.producto_id, a.almacen_id, dif.toString(), id, aprobador]);
      faltante = faltante.plus(new Decimal(rows[0].costo_total_usd).abs());
    } else {
      const costo = l.costo_unitario_usd ?? l.costo_promedio;
      const { rows } = await tx.query<{ costo_total_usd: string }>(
        `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id, created_by)
         values ('ajuste_positivo', $1, $2, $3, $4, 'ajuste_inventario', $5, $6) returning costo_total_usd::text`,
        [l.producto_id, a.almacen_id, dif.toString(), costo, id, aprobador]);
      sobrante = sobrante.plus(rows[0].costo_total_usd);
    }
  }

  const { rows: dia } = await tx.query<{ hoy: string; numero: string }>(
    `select ((now() at time zone 'America/Caracas')::date)::text as hoy, numero::text from ajuste_inventario where id = $1`, [id]);
  for (const [evento, monto, glosa] of [['ajuste_faltante', faltante, 'Faltantes'], ['ajuste_sobrante', sobrante, 'Sobrantes']] as const) {
    if (monto.gt(0)) {
      await contabilizar(tx, {
        evento, fecha: dia[0].hoy, descripcion: `${glosa} de inventario · ajuste ${dia[0].numero}`,
        origen: { tipo: evento, id }, moneda: 'USD', importes: { costo: monto.toFixed(2) }, usuarioId: aprobador,
      });
    }
  }
  return { faltanteUsd: faltante.toFixed(2), sobranteUsd: sobrante.toFixed(2) };
}

/** Lo llama el motor de flujo cuando Gerencia rechaza. */
export async function rechazarAjuste(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const a = await ajuste(tx, id);
  if (a.estado !== 'pendiente') throw new ErrorMaestro('El ajuste no está pendiente de aprobación.');
  await tx.query(`update ajuste_inventario set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaAjuste {
  id: string; numero: string | null; estado: string; almacen: string; creado_por: string; fecha: string; lineas: number;
}

/** Ajustes de los almacenes que el usuario ve. */
export async function buscarAjustes(db: Db, u: Usuario, filtro: { estado?: string }, limite = 100): Promise<FilaAjuste[]> {
  if (!u.roles.some((r) => (ROLES_VEN_AJUSTES as readonly string[]).includes(r))) return [];
  const visibles = await almacenesVisibles(db, u);
  if (!visibles.length) return [];
  const { rows } = await db.query<FilaAjuste>(
    `select a.id, a.numero::text, a.estado, al.codigo as almacen, us.nombre as creado_por,
            to_char(a.created_at at time zone 'America/Caracas', 'DD-MM-YYYY') as fecha,
            (select count(*)::int from ajuste_inventario_linea where ajuste_id = a.id) as lineas
       from ajuste_inventario a join almacen al on al.id = a.almacen_id join usuario us on us.id = a.created_by
      where a.almacen_id = any($1::uuid[]) and ($2 = '' or a.estado = $2)
      order by a.created_at desc limit $3`, [visibles, filtro.estado ?? '', limite]);
  return rows;
}

export interface LineaAjuste {
  id: string; linea: number; producto_id: string; codigo: string; descripcion: string; sistema: string; contada: string; diferencia: string;
  costo_unitario: string | null; costo_promedio: string; motivo: string | null;
}

export interface DetalleAjuste {
  id: string; numero: string | null; estado: string; almacen_id: string; almacen: string; observaciones: string | null;
  creado_por_id: string; creado_por: string; contado_por_id: string; contado_por: string; fecha: string; aprobado_por: string | null;
  aprobado_at: string | null; rechazo_motivo: string | null; lineas: LineaAjuste[]; valor_usd: string;
}

export async function detalleAjuste(db: Db, id: string): Promise<DetalleAjuste | null> {
  const { rows } = await db.query<Omit<DetalleAjuste, 'lineas' | 'valor_usd'>>(
    `select a.id, a.numero::text, a.estado, a.almacen_id, al.codigo || ' · ' || al.nombre as almacen, a.observaciones,
            a.created_by as creado_por_id, cr.nombre as creado_por, a.contado_por as contado_por_id, co.nombre as contado_por,
            to_char(a.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as fecha, ap.nombre as aprobado_por,
            to_char(a.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado_at, a.rechazo_motivo
       from ajuste_inventario a
       join almacen al on al.id = a.almacen_id
       join usuario cr on cr.id = a.created_by
       join usuario co on co.id = a.contado_por
       left join usuario ap on ap.id = a.aprobado_por
      where a.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: lineas } = await db.query<LineaAjuste>(
    `select l.id, l.linea, l.producto_id, p.codigo, p.descripcion, l.cantidad_sistema::text as sistema, l.cantidad_contada::text as contada,
            l.diferencia::text, l.costo_unitario_usd::text as costo_unitario,
            coalesce((select c.costo_promedio_usd from producto_costo c where c.producto_id = l.producto_id), 0)::text as costo_promedio,
            m.nombre as motivo
       from ajuste_inventario_linea l join producto p on p.id = l.producto_id left join motivo m on m.id = l.motivo_id
      where l.ajuste_id = $1 order by l.linea`, [id]);
  const valor = lineas.reduce(
    (s, l) => s.plus(new Decimal(l.diferencia).abs().times(l.costo_unitario ?? l.costo_promedio)), new Decimal(0));
  return { ...rows[0], lineas, valor_usd: valor.toFixed(2) };
}

export interface FilaExistencia {
  producto_id: string; codigo: string; descripcion: string; cantidad: string; reservado: string; disponible: string;
  costo_promedio: string; valor_usd: string;
}

/** Existencia de un almacén con su valor al costo promedio. Solo almacenes visibles para el usuario. */
export async function listarExistencias(db: Db, u: Usuario, almacenId: string, limite = 500): Promise<FilaExistencia[]> {
  if (!u.roles.some((r) => (ROLES_VEN_EXISTENCIAS as readonly string[]).includes(r))) return [];
  if (!(await almacenesVisibles(db, u)).includes(almacenId)) return [];
  const { rows } = await db.query<FilaExistencia>(
    `select e.producto_id, p.codigo, p.descripcion, e.cantidad::text, e.reservado::text, (e.cantidad - e.reservado)::text as disponible,
            coalesce(c.costo_promedio_usd, 0)::text as costo_promedio, round(e.cantidad * coalesce(c.costo_promedio_usd, 0), 2)::text as valor_usd
       from existencia e join producto p on p.id = e.producto_id left join producto_costo c on c.producto_id = e.producto_id
      where e.almacen_id = $1 and (e.cantidad <> 0 or e.reservado <> 0) order by p.codigo limit $2`, [almacenId, limite]);
  return rows;
}

export const ROLES_VEN_EXISTENCIAS = [
  'almacen', 'gerencia', 'ventas', 'supervisor_ventas', 'facturacion', 'compras', 'contabilidad', 'jefe_contabilidad', 'auditor',
] as const satisfies readonly Rol[];
