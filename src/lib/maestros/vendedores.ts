import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro, obtenerOCrearTercero, rifOError } from './terceros';

/**
 * Vendedores (§5.2). Los administran Gerencia y Supervisor de ventas.
 * - El código (V001…) lo asigna el numerador (migración 0008).
 * - El tipo es explícito: 'administrativo' y 'casa' se excluyen de rankings y comisiones
 *   con un filtro por tipo, nunca con listas de códigos en el programa.
 * - Un vendedor externo es un tercero con RIF (retención de ISLR sobre sus comisiones).
 * - El usuario del ERP enlazado define su cartera (seguridad por fila de clientes).
 */

export const TIPOS_VENDEDOR = ['interno', 'externo', 'administrativo', 'casa'] as const;
export type TipoVendedor = (typeof TIPOS_VENDEDOR)[number];

export const NOMBRE_TIPO_VENDEDOR: Record<TipoVendedor, string> = {
  interno: 'Interno',
  externo: 'Externo (comisionista)',
  administrativo: 'Administrativo',
  casa: 'Casa / mostrador',
};

/** Roles con los que un usuario puede enlazarse a un vendedor. */
const ROLES_DE_VENDEDOR = ['ventas', 'supervisor_ventas'];

export interface DatosVendedor {
  nombre: string;
  tipo: TipoVendedor;
  sucursalId?: string | null;
  usuarioId?: string | null;
  /** Obligatorio si el tipo es externo. */
  rif?: string;
  confirmarNombreParecido?: boolean;
}

async function validar(tx: Db, d: DatosVendedor, id?: string): Promise<string | null> {
  const errores: string[] = [];
  if (d.nombre.trim().length < 2) errores.push('Indique el nombre del vendedor.');
  if (!TIPOS_VENDEDOR.includes(d.tipo)) errores.push('Seleccione el tipo de vendedor.');
  if (d.tipo === 'externo' && !d.rif?.trim()) errores.push('Un vendedor externo necesita su RIF (retención de ISLR sobre comisiones).');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));

  if (d.usuarioId) {
    const { rows } = await tx.query<{ ok: boolean; otro: string | null }>(
      `select exists (select 1 from usuario_rol ur join usuario u on u.id = ur.usuario_id
                       where ur.usuario_id = $1 and u.activo and ur.rol = any($2)) as ok,
              (select codigo from vendedor where usuario_id = $1 and ($3::uuid is null or id <> $3::uuid)) as otro`,
      [d.usuarioId, ROLES_DE_VENDEDOR, id ?? null]);
    if (!rows[0].ok) throw new ErrorMaestro('El usuario enlazado debe estar activo y tener el rol Ventas o Supervisor de ventas.');
    if (rows[0].otro) throw new ErrorMaestro(`Ese usuario ya está enlazado al vendedor ${rows[0].otro}.`);
  }
  return d.tipo === 'externo' ? rifOError(d.rif!) : null;
}

async function terceroDeExterno(tx: Db, usuarioId: string, d: DatosVendedor, rif: string | null): Promise<string | null> {
  if (!rif) return null;
  // Un RIF es una sola persona: si ya es cliente o proveedor, se reutiliza ese tercero.
  const t = await obtenerOCrearTercero(tx, usuarioId, rif, {
    razonSocial: d.nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false,
  }, d.confirmarNombreParecido);
  return t.id;
}

export async function crearVendedor(tx: Db, usuarioId: string, d: DatosVendedor): Promise<{ id: string; codigo: string }> {
  const rif = await validar(tx, d);
  const terceroId = await terceroDeExterno(tx, usuarioId, d, rif);
  const { rows } = await tx.query<{ id: string; codigo: string }>(
    `insert into vendedor (nombre, tipo, sucursal_id, usuario_id, tercero_id) values ($1, $2, $3, $4, $5)
     returning id, codigo`,
    [d.nombre.trim(), d.tipo, d.sucursalId || null, d.usuarioId || null, terceroId]);
  return rows[0];
}

export async function actualizarVendedor(tx: Db, usuarioId: string, id: string, d: DatosVendedor): Promise<void> {
  const { rows } = await tx.query<{ id: string }>('select id from vendedor where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El vendedor no existe.');
  const rif = await validar(tx, d, id);
  const terceroId = await terceroDeExterno(tx, usuarioId, d, rif);
  await tx.query(
    `update vendedor set nombre = $2, tipo = $3, sucursal_id = $4, usuario_id = $5, tercero_id = $6 where id = $1`,
    [id, d.nombre.trim(), d.tipo, d.sucursalId || null, d.usuarioId || null, terceroId]);
}

/** Un vendedor no se borra: se inactiva. Sus clientes conservan la asignación hasta que se reasignen. */
export async function cambiarEstadoVendedor(tx: Db, id: string, estado: 'activo' | 'inactivo'): Promise<void> {
  if (estado !== 'activo' && estado !== 'inactivo') throw new ErrorMaestro('Estado inválido.');
  const { rows } = await tx.query<{ id: string }>('update vendedor set estado = $2 where id = $1 returning id', [id, estado]);
  if (!rows[0]) throw new ErrorMaestro('El vendedor no existe.');
}
