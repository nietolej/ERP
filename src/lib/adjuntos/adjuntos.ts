import { createHash, randomUUID } from 'node:crypto';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { puedeVerCliente, ROLES_VEN_CLIENTES } from '@/lib/maestros/clientes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { ROLES_VEN_PROVEEDORES } from '@/lib/maestros/proveedores';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import { ROLES_COBRAN, ROLES_VEN_COBROS } from '@/lib/ventas/cobros';
import { ROLES_CONSTANCIA, ROLES_VEN_TRANSPORTE } from '@/lib/ventas/transportes';
import type { AlmacenArchivos } from './almacen';

/**
 * Adjuntos (§4.2): soportes en PDF o imagen enlazados a un registro.
 * - El tipo de archivo se reconoce por su contenido, no por la extensión ni por lo que declara el navegador.
 * - Se guarda la huella SHA-256 y se verifica al leer: el soporte no puede cambiar sin que se note.
 * - Un adjunto no se edita ni se borra: se anula con motivo (lo exige la base de datos).
 */

export const TIPOS_ADJUNTABLES = ['cliente', 'proveedor', 'producto', 'transporte_parada', 'cobro'] as const;
export type TipoAdjuntable = (typeof TIPOS_ADJUNTABLES)[number];

export const MAX_BYTES_ADJUNTO = 5 * 1024 * 1024;

/** Quién ve y quién agrega adjuntos en cada tipo de registro. Ver = mismos roles que ven el registro. */
export const PERMISOS_ADJUNTO: Record<TipoAdjuntable, { ver: readonly Rol[]; agregar: readonly Rol[] }> = {
  cliente: { ver: ROLES_VEN_CLIENTES, agregar: ['facturacion', 'cobranzas', 'gerencia', 'supervisor_ventas', 'ventas'] },
  proveedor: { ver: ROLES_VEN_PROVEEDORES, agregar: ['compras', 'gerencia', 'tesoreria'] },
  producto: { ver: ROLES_VEN_PRODUCTOS, agregar: ['almacen', 'gerencia', 'compras'] },
  transporte_parada: { ver: ROLES_VEN_TRANSPORTE, agregar: ROLES_CONSTANCIA },
  cobro: { ver: ROLES_VEN_COBROS, agregar: ROLES_COBRAN },
};

type Usuario = { id: string; roles: readonly string[] };
const tieneAlguno = (u: Usuario, roles: readonly string[]) => u.roles.some((r) => roles.includes(r));

/** ¿Puede ver los adjuntos de este registro? Un vendedor solo ve los de sus propios clientes (seguridad por fila). */
export async function puedeVerAdjuntos(db: Db, u: Usuario, tipo: TipoAdjuntable, entidadId: string): Promise<boolean> {
  if (!tieneAlguno(u, PERMISOS_ADJUNTO[tipo].ver)) return false;
  if (tipo === 'cliente') return puedeVerCliente(db, u, entidadId);
  if (tipo === 'transporte_parada') {
    // La constancia de una entrega la ve quien ve el almacén de salida del transporte.
    const { rows } = await db.query<{ almacen_id: string }>(
      'select t.almacen_id from transporte_parada p join transporte t on t.id = p.transporte_id where p.id = $1', [entidadId]);
    return rows[0] ? (await almacenesVisibles(db, u)).includes(rows[0].almacen_id) : false;
  }
  return true;
}

export async function puedeAgregarAdjuntos(db: Db, u: Usuario, tipo: TipoAdjuntable, entidadId: string): Promise<boolean> {
  return tieneAlguno(u, PERMISOS_ADJUNTO[tipo].agregar) && (await puedeVerAdjuntos(db, u, tipo, entidadId));
}

export type TipoContenido = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';

/** Reconoce PDF, PNG, JPEG y WebP por sus primeros bytes. */
export function tipoDeContenido(b: Uint8Array): TipoContenido | null {
  const empieza = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  if (empieza(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (empieza(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (empieza(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (empieza(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'; // RIFF....WEBP
  return null;
}

/** Nombre para mostrar: sin rutas ni caracteres de control, con un largo razonable. */
export function nombreSeguro(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  const limpio = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim();
  const cortado = limpio.length > 150 ? limpio.slice(-150) : limpio;
  return cortado || 'archivo';
}

export interface Adjunto {
  id: string;
  nombre: string;
  tipo_contenido: TipoContenido;
  tamano_bytes: number;
  descripcion: string | null;
  subido_por: string;
  autor: string;
  created_at: string;
  anulado_at: string | null;
  motivo_anulacion: string | null;
}

export interface DatosAdjunto {
  tipo: TipoAdjuntable;
  entidadId: string;
  nombre: string;
  bytes: Uint8Array;
  descripcion?: string;
}

/**
 * Guarda el archivo y su registro. Si la base rechaza el registro, se retira el archivo.
 * Los permisos los verifica quien llama (la acción de servidor).
 */
export async function guardarAdjunto(tx: Db, almacen: AlmacenArchivos, usuarioId: string, d: DatosAdjunto): Promise<string> {
  if (!(TIPOS_ADJUNTABLES as readonly string[]).includes(d.tipo)) throw new ErrorMaestro('Tipo de registro inválido.');
  if (d.bytes.length === 0) throw new ErrorMaestro('El archivo está vacío.');
  if (d.bytes.length > MAX_BYTES_ADJUNTO) throw new ErrorMaestro(`El archivo no puede pasar de ${MAX_BYTES_ADJUNTO / 1024 / 1024} MB.`);
  const contenido = tipoDeContenido(d.bytes);
  if (!contenido) throw new ErrorMaestro('Solo se admiten archivos PDF, PNG, JPG o WebP.');
  const descripcion = d.descripcion?.trim() || null;
  if (descripcion && descripcion.length > 300) throw new ErrorMaestro('La descripción admite hasta 300 caracteres.');

  const hash = createHash('sha256').update(d.bytes).digest('hex');
  const { rows: repetido } = await tx.query(
    'select 1 from adjunto where entidad_tipo = $1 and entidad_id = $2 and hash_sha256 = $3 and anulado_at is null', [d.tipo, d.entidadId, hash]);
  if (repetido.length) throw new ErrorMaestro('Ese mismo archivo ya está adjunto a este registro.');

  const id = randomUUID();
  await almacen.guardar(id, d.bytes);
  try {
    await tx.query(
      `insert into adjunto (id, entidad_tipo, entidad_id, nombre, tipo_contenido, tamano_bytes, hash_sha256, descripcion, subido_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, d.tipo, d.entidadId, nombreSeguro(d.nombre), contenido, d.bytes.length, hash, descripcion, usuarioId]);
  } catch (e) {
    await almacen.borrar(id);
    throw e;
  }
  return id;
}

export async function anularAdjunto(tx: Db, id: string, usuarioId: string, motivo: string): Promise<void> {
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo de la anulación.');
  const { rows } = await tx.query(
    'update adjunto set anulado_por = $2, motivo_anulacion = $3 where id = $1 and anulado_at is null returning id', [id, usuarioId, motivo.trim()]);
  if (!rows[0]) throw new ErrorMaestro('El adjunto no existe o ya fue anulado.');
}

export async function listarAdjuntos(db: Db, tipo: TipoAdjuntable, entidadId: string, incluirAnulados: boolean): Promise<Adjunto[]> {
  const { rows } = await db.query<Adjunto>(
    `select a.id, a.nombre, a.tipo_contenido, a.tamano_bytes, a.descripcion, a.subido_por, u.nombre as autor,
            a.created_at, a.anulado_at, a.motivo_anulacion
       from adjunto a join usuario u on u.id = a.subido_por
      where a.entidad_tipo = $1 and a.entidad_id = $2 and ($3 or a.anulado_at is null)
      order by a.created_at desc`, [tipo, entidadId, incluirAnulados]);
  return rows;
}

export interface AdjuntoLeido {
  nombre: string; tipo_contenido: TipoContenido; bytes: Buffer;
}

/**
 * Lee un adjunto verificando permisos y huella. Devuelve null si no existe o el usuario no puede verlo
 * (los anulados solo los ven Gerencia y Auditor). Lanza si el archivo no coincide con su huella.
 */
export async function leerAdjunto(db: Db, almacen: AlmacenArchivos, u: Usuario, id: string): Promise<AdjuntoLeido | null> {
  const { rows } = await db.query<{
    entidad_tipo: TipoAdjuntable; entidad_id: string; nombre: string; tipo_contenido: TipoContenido; hash_sha256: string; anulado_at: string | null;
  }>('select entidad_tipo, entidad_id, nombre, tipo_contenido, hash_sha256, anulado_at from adjunto where id = $1', [id]);
  const a = rows[0];
  if (!a) return null;
  if (!(await puedeVerAdjuntos(db, u, a.entidad_tipo, a.entidad_id))) return null;
  if (a.anulado_at && !tieneAlguno(u, ['gerencia', 'auditor'])) return null;
  const bytes = await almacen.leer(id);
  if (createHash('sha256').update(bytes).digest('hex') !== a.hash_sha256) {
    throw new Error(`El archivo del adjunto ${id} no coincide con su huella`);
  }
  return { nombre: a.nombre, tipo_contenido: a.tipo_contenido, bytes };
}
