import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from './terceros';

/**
 * Catálogos de motivos (docs/catalogo_decisiones.md): descuento, devolución, anulación, venta perdida y merma.
 * Los administra Gerencia. Un motivo no se borra: se inactiva. Los que usa el propio sistema (`sistema`) no se desactivan.
 */

export const ROLES_MOTIVOS = ['gerencia', 'administrador'] as const;

export const TIPOS_MOTIVO = ['descuento', 'devolucion', 'anulacion', 'venta_perdida', 'merma'] as const;
export type TipoMotivo = (typeof TIPOS_MOTIVO)[number];

export const NOMBRE_TIPO_MOTIVO: Record<TipoMotivo, string> = {
  descuento: 'Descuentos',
  devolucion: 'Devoluciones',
  anulacion: 'Anulaciones',
  venta_perdida: 'Ventas perdidas',
  merma: 'Mermas y ajustes de inventario',
};

export interface Motivo {
  id: string; tipo: TipoMotivo; codigo: string; nombre: string; activo: boolean; sistema: boolean;
}

export async function listarMotivos(db: Db, opciones: { tipo?: TipoMotivo; soloActivos?: boolean } = {}): Promise<Motivo[]> {
  const { rows } = await db.query<Motivo>(
    `select id, tipo, codigo, nombre, activo, sistema from motivo
      where ($1::text is null or tipo = $1) and (not $2 or activo)
      order by tipo, sistema desc, nombre`, [opciones.tipo ?? null, opciones.soloActivos ?? false]);
  return rows;
}

/** Id de un motivo que usa el propio sistema (por ejemplo, DESCUENTO_CLIENTE). */
export async function motivoSistema(tx: Db, tipo: TipoMotivo, codigo: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>('select id from motivo where tipo = $1 and codigo = $2', [tipo, codigo]);
  if (!rows[0]) throw new ErrorMaestro(`Falta el motivo ${codigo} del catálogo de ${NOMBRE_TIPO_MOTIVO[tipo].toLowerCase()}.`);
  return rows[0].id;
}

export async function crearMotivo(tx: Db, tipo: string, codigo: string, nombre: string): Promise<string> {
  if (!(TIPOS_MOTIVO as readonly string[]).includes(tipo)) throw new ErrorMaestro('Seleccione el tipo de motivo.');
  const c = codigo.trim().toUpperCase().replace(/\s+/g, '_');
  if (!/^[A-Z0-9_]{2,30}$/.test(c)) throw new ErrorMaestro('El código admite de 2 a 30 letras, números o guion bajo.');
  if (nombre.trim().length < 3) throw new ErrorMaestro('Indique el nombre del motivo.');
  const { rows: previo } = await tx.query('select 1 from motivo where tipo = $1 and codigo = $2', [tipo, c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe el motivo ${c} en ese catálogo.`);
  const { rows } = await tx.query<{ id: string }>('insert into motivo (tipo, codigo, nombre) values ($1, $2, $3) returning id', [tipo, c, nombre.trim()]);
  return rows[0].id;
}

export async function cambiarEstadoMotivo(tx: Db, id: string, activo: boolean): Promise<void> {
  const { rows } = await tx.query<{ id: string }>('update motivo set activo = $2 where id = $1 returning id', [id, activo]);
  if (!rows[0]) throw new ErrorMaestro('El motivo no existe.');
}

export interface MotivoDocumento {
  motivoId: string;
  /** Explicación escrita; es obligatoria si el motivo es "Otro". */
  detalle?: string;
}

/**
 * Valida el motivo de una anulación y arma el texto que se guarda en el documento:
 * "Nombre del motivo" o "Nombre del motivo: detalle".
 */
export async function textoDeAnulacion(tx: Db, m: MotivoDocumento): Promise<string> {
  const { rows } = await tx.query<{ nombre: string; codigo: string; tipo: string }>('select nombre, codigo, tipo from motivo where id = $1', [m.motivoId]);
  const mot = rows[0];
  if (!mot || mot.tipo !== 'anulacion') throw new ErrorMaestro('Seleccione el motivo de la anulación.');
  const detalle = (m.detalle ?? '').trim();
  if (mot.codigo === 'OTRO' && detalle.length < 3) throw new ErrorMaestro('Explique el motivo de la anulación.');
  return detalle ? `${mot.nombre}: ${detalle}` : mot.nombre;
}
