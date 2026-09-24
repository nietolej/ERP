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
    'insert into almacen (codigo, nombre, sucursal_id, es_comercial, permite_venta) values ($1, $2, $3, $4, $5) returning id',
    [c, d.nombre.trim(), d.sucursalId, d.esComercial, d.permiteVenta]);
  return rows[0].id;
}

export async function actualizarAlmacen(tx: Db, id: string, d: DatosAlmacen & { activo: boolean }): Promise<void> {
  validar(d);
  const { rows } = await tx.query(
    `update almacen set nombre = $2, sucursal_id = $3, es_comercial = $4, permite_venta = $5, activo = $6
      where id = $1 returning id`,
    [id, d.nombre.trim(), d.sucursalId, d.esComercial, d.permiteVenta, d.activo]);
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
