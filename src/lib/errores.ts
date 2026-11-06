/**
 * Errores de negocio compartidos por todos los módulos del ERP.
 *
 * Viven aquí, y no en un módulo de dominio, para que ningún módulo dependa de
 * otro solo para lanzar o reconocer un error.
 */

/** Error de negocio con un mensaje que se puede mostrar tal cual al usuario. */
export class ErrorMaestro extends Error {}

/** Error que el usuario puede superar confirmando (p. ej. un nombre parecido a otro tercero). */
export class ErrorConfirmable extends ErrorMaestro {}
