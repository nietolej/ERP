import type { Db } from '@/lib/db/tipos';
import { normalizarRif, problemaDeRif, tipoPersona } from './rif';

/**
 * Terceros (§5.1): un RIF es una sola persona, aunque sea cliente, proveedor o vendedor externo.
 * La base valida el RIF y su unicidad (migración 0007).
 */

export class ErrorMaestro extends Error {}

/** Error que el usuario puede superar confirmando (p. ej. un nombre parecido a otro tercero). */
export class ErrorConfirmable extends ErrorMaestro {}

export interface DatosTercero {
  razonSocial: string;
  nombreComercial?: string;
  domiciliado: boolean;
  contribuyenteEspecial: boolean;
  agenteRetencionIva: boolean;
  direccionFiscal?: string;
  telefono?: string;
  email?: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const vacioANull = (v?: string | null) => (v && v.trim() ? v.trim() : null);

export function validarTercero(d: DatosTercero): void {
  const errores: string[] = [];
  if (d.razonSocial.trim().length < 2) errores.push('Indique la razón social o el nombre.');
  if (d.email?.trim() && !EMAIL.test(d.email.trim())) errores.push('El correo no tiene un formato válido.');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

/** RIF canónico, o ErrorMaestro con el motivo. */
export function rifOError(entrada: string): string {
  const problema = problemaDeRif(entrada);
  if (problema) throw new ErrorMaestro(problema);
  return normalizarRif(entrada)!;
}

/** Terceros con un nombre que, normalizado, coincide con el dado (posibles duplicados). */
export async function posiblesDuplicados(
  db: Db, razonSocial: string, excluirId?: string,
): Promise<{ id: string; rif: string; razon_social: string }[]> {
  const { rows } = await db.query<{ id: string; rif: string; razon_social: string }>(
    `select id, rif, razon_social from tercero
      where fn_nombre_normalizado(razon_social) = fn_nombre_normalizado($1)
        and ($2::uuid is null or id <> $2::uuid)
      order by rif limit 5`,
    [razonSocial, excluirId ?? null]);
  return rows;
}

export async function exigirNombreDistinto(
  db: Db, razonSocial: string, confirmado: boolean | undefined, excluirId?: string,
): Promise<void> {
  const parecidos = await posiblesDuplicados(db, razonSocial, excluirId);
  if (parecidos.length && !confirmado) {
    throw new ErrorConfirmable(
      `Ya existe ${excluirId ? 'otro tercero' : 'un tercero'} con un nombre igual o muy parecido:\n` +
      parecidos.map((p) => `• ${p.rif} · ${p.razon_social}`).join('\n') +
      `\nSi es una persona distinta, marque la confirmación y guarde de nuevo.`);
  }
}

/**
 * Devuelve el tercero del RIF; si no existe, lo crea con `datos`.
 * Un tercero existente se reutiliza sin cambiar sus datos. Debe llamarse dentro de una transacción.
 */
export async function obtenerOCrearTercero(
  tx: Db, usuarioId: string, rif: string, datos: DatosTercero, confirmarNombreParecido?: boolean,
): Promise<{ id: string; existente: boolean }> {
  const { rows: previo } = await tx.query<{ id: string }>('select id from tercero where rif = $1', [rif]);
  if (previo[0]) return { id: previo[0].id, existente: true };

  validarTercero(datos);
  await exigirNombreDistinto(tx, datos.razonSocial, confirmarNombreParecido);
  const { rows } = await tx.query<{ id: string }>(
    `insert into tercero (rif, razon_social, nombre_comercial, tipo_persona, domiciliado, contribuyente_especial,
                          agente_retencion_iva, direccion_fiscal, telefono, email, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [rif, datos.razonSocial.trim(), vacioANull(datos.nombreComercial), tipoPersona(rif), datos.domiciliado,
     datos.contribuyenteEspecial, datos.agenteRetencionIva, vacioANull(datos.direccionFiscal), vacioANull(datos.telefono),
     vacioANull(datos.email)?.toLowerCase() ?? null, usuarioId]);
  return { id: rows[0].id, existente: false };
}
