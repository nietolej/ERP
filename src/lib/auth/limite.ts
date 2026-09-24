import { createHash } from 'node:crypto';
import type { Db } from '@/lib/db/tipos';

/**
 * Límite de intentos de inicio de sesión (protección contra fuerza bruta, §4.3).
 *
 * - Por correo: 5 intentos fallidos en 15 minutos bloquean ese correo hasta que venza la ventana.
 *   Se aplica igual a correos que no existen, para no revelar cuáles están registrados.
 * - Por dirección IP: 30 intentos fallidos en 15 minutos, contra quien prueba muchos correos.
 * - Un inicio de sesión correcto borra los fallos de ese correo (no los de la IP).
 * - Mientras hay bloqueo no se verifica la clave ni se cuentan más intentos.
 */
export const VENTANA_MINUTOS = 15;
export const MAX_FALLOS_CORREO = 5;
export const MAX_FALLOS_IP = 30;
/** Los fallos más viejos que esto se borran; solo sirven dentro de la ventana. */
const RETENCION_HORAS = 24;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export const claveCorreo = (email: string) => hash(`email:${email.trim().toLowerCase()}`);
export const claveIp = (ip: string) => hash(`ip:${ip.trim()}`);

interface Limite {
  clave: string;
  maximo: number;
}

function limites(email: string, ip: string | null): Limite[] {
  const l = [{ clave: claveCorreo(email), maximo: MAX_FALLOS_CORREO }];
  if (ip) l.push({ clave: claveIp(ip), maximo: MAX_FALLOS_IP });
  return l;
}

/** ¿Algún límite (correo o IP) alcanzó su máximo de fallos dentro de la ventana? */
export async function estaBloqueado(db: Db, email: string, ip: string | null): Promise<boolean> {
  for (const { clave, maximo } of limites(email, ip)) {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from intento_fallido
        where clave = $1 and created_at > now() - make_interval(mins => $2)`,
      [clave, VENTANA_MINUTOS],
    );
    if (rows[0].n >= maximo) return true;
  }
  return false;
}

/**
 * Registra un intento fallido. Si con él el correo queda bloqueado y pertenece a un usuario,
 * deja constancia en la auditoría.
 */
export async function registrarFallo(db: Db, email: string, ip: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `delete from intento_fallido where created_at < now() - make_interval(hours => $1)`,
      [RETENCION_HORAS],
    );
    for (const { clave } of limites(email, ip)) {
      await tx.query('insert into intento_fallido (clave) values ($1)', [clave]);
    }
    const { rows } = await tx.query<{ n: number }>(
      `select count(*)::int as n from intento_fallido
        where clave = $1 and created_at > now() - make_interval(mins => $2)`,
      [claveCorreo(email), VENTANA_MINUTOS],
    );
    if (rows[0].n === MAX_FALLOS_CORREO) {
      await tx.query(
        `insert into audit_log (accion, entidad, entidad_id, despues)
         select 'BLOQUEO_ACCESO', 'usuario', id::text, jsonb_build_object('minutos', $2::int, 'fallos', $3::int)
           from usuario where email = $1`,
        [email.trim().toLowerCase(), VENTANA_MINUTOS, MAX_FALLOS_CORREO],
      );
    }
  });
}

/** Tras un inicio de sesión correcto, el contador del correo vuelve a cero. */
export async function limpiarFallos(db: Db, email: string): Promise<void> {
  await db.query('delete from intento_fallido where clave = $1', [claveCorreo(email)]);
}
