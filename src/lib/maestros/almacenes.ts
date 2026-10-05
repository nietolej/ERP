import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from './terceros';

/**
 * Almacenes (§5.3) y almacenes visibles por usuario (§4.3). Los administra Gerencia.
 * Un almacén comercial puede vender; los demás (depósito, tránsito) no.
 * Un almacén con movimientos no se borra: se inactiva.
 */

export interface DatosAlmacen {
  nombre: string;
  sucursalId: string;
  esComercial: boolean;
  permiteVenta: boolean;
  /** El picking se activa por almacén: el mostrador puede despachar sin él (§6.4). Por defecto, sí. */
  usaPicking?: boolean;
}

function validar(d: DatosAlmacen): void {
  const errores: string[] = [];
  if (d.nombre.trim().length < 2) errores.push('Indique el nombre del almacén.');
  if (!d.sucursalId) errores.push('Seleccione la sucursal.');
  if (d.permiteVenta && !d.esComercial) errores.push('Solo un almacén comercial puede vender.');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

export async function crearAlmacen(tx: Db, codigo: string, d: DatosAlmacen): Promise<string> {
  const c = codigo.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(c)) throw new ErrorMaestro('El código admite hasta 6 letras o números (p. ej. 01, 06, TRANS).');
  validar(d);
  const { rows: previo } = await tx.query('select 1 from almacen where codigo = $1', [c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe el almacén ${c}.`);
  const { rows } = await tx.query<{ id: string }>(
    'insert into almacen (codigo, nombre, sucursal_id, es_comercial, permite_venta, usa_picking) values ($1, $2, $3, $4, $5, $6) returning id',
    [c, d.nombre.trim(), d.sucursalId, d.esComercial, d.permiteVenta, d.usaPicking ?? true]);
  return rows[0].id;
}

export async function actualizarAlmacen(tx: Db, id: string, d: DatosAlmacen & { activo: boolean }): Promise<void> {
  validar(d);
  const { rows } = await tx.query(
    `update almacen set nombre = $2, sucursal_id = $3, es_comercial = $4, permite_venta = $5, activo = $6,
            usa_picking = coalesce($7::boolean, usa_picking)
      where id = $1 returning id`,
    [id, d.nombre.trim(), d.sucursalId, d.esComercial, d.permiteVenta, d.activo, d.usaPicking ?? null]);
  if (!rows[0]) throw new ErrorMaestro('El almacén no existe.');
}

/** Reemplaza los usuarios que ven el almacén. */
export async function asignarUsuarios(tx: Db, almacenId: string, usuarios: string[]): Promise<void> {
  await tx.query('delete from usuario_almacen where almacen_id = $1', [almacenId]);
  for (const u of new Set(usuarios)) {
    await tx.query('insert into usuario_almacen (usuario_id, almacen_id) values ($1, $2)', [u, almacenId]);
  }
}

/** Almacenes que puede ver un usuario: todos, salvo quien solo tiene el rol Almacén (§4.3). */
export async function almacenesVisibles(db: Db, usuario: { id: string; roles: readonly string[] }): Promise<string[]> {
  const soloAlmacen = usuario.roles.includes('almacen')
    && !usuario.roles.some((r) => ['gerencia', 'compras', 'contabilidad', 'jefe_contabilidad', 'auditor'].includes(r));
  const { rows } = await db.query<{ id: string }>(
    soloAlmacen
      ? 'select almacen_id as id from usuario_almacen where usuario_id = $1'
      : 'select id from almacen where $1::uuid is not null',
    [usuario.id]);
  return rows.map((r) => r.id);
}

/**
 * Horas objetivo de picking por prioridad (1 = más urgente a 5). Un valor vacío quita el objetivo de esa prioridad.
 * Es un parámetro del almacén: el cumplimiento se mide en vw_picking_tiempos.
 */
export async function fijarObjetivosPicking(tx: Db, almacenId: string, horas: string[]): Promise<void> {
  if (horas.length !== 5) throw new ErrorMaestro('Indique el objetivo de cada una de las 5 prioridades (puede dejarlo vacío).');
  const { rows } = await tx.query('select 1 from almacen where id = $1', [almacenId]);
  if (!rows.length) throw new ErrorMaestro('El almacén no existe.');
  for (const [i, h] of horas.entries()) {
    const v = h.trim().replace(',', '.');
    if (v === '') {
      await tx.query('delete from almacen_picking_objetivo where almacen_id = $1 and prioridad = $2', [almacenId, i + 1]);
      continue;
    }
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(v) || Number(v) <= 0) throw new ErrorMaestro(`Prioridad ${i + 1}: las horas objetivo deben ser un número mayor que cero, con hasta 2 decimales.`);
    await tx.query(
      `insert into almacen_picking_objetivo (almacen_id, prioridad, horas) values ($1, $2, $3)
       on conflict (almacen_id, prioridad) do update set horas = excluded.horas`, [almacenId, i + 1, v]);
  }
}
