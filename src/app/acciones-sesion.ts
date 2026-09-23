'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { hashClave, problemasDeClave, verificarClave } from '@/lib/auth/clave';
import { COOKIE_SESION } from '@/lib/auth/constantes';
import { exigirSesion } from '@/lib/auth/dal';
import { autenticar, crearSesion, eliminarSesion, eliminarSesionesDeUsuario } from '@/lib/auth/sesiones';
import { conUsuario, getDb } from '@/lib/db';

async function guardarCookie(token: string, expira: Date) {
  (await cookies()).set(COOKIE_SESION, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expira,
  });
}

export async function iniciarSesion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  const email = texto(fd, 'email');
  const clave = typeof fd.get('clave') === 'string' ? (fd.get('clave') as string) : '';
  if (!email || !clave) return { error: 'Ingrese su correo y su clave.' };

  let destino: string;
  try {
    const db = await getDb();
    const u = await autenticar(db, email, clave);
    if (!u) return { error: 'Correo o clave incorrectos.' };
    const { token, expira } = await crearSesion(db, u.id);
    await guardarCookie(token, expira);
    destino = u.debeCambiarPassword ? '/cambiar-clave' : '/';
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  redirect(destino);
}

export async function cerrarSesion(): Promise<void> {
  const almacen = await cookies();
  const token = almacen.get(COOKIE_SESION)?.value;
  if (token) await eliminarSesion(await getDb(), token);
  almacen.delete(COOKIE_SESION);
  redirect('/login');
}

export async function cambiarClave(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  const u = await exigirSesion({ permitirCambioClave: true });
  const actual = String(fd.get('actual') ?? '');
  const nueva = String(fd.get('nueva') ?? '');
  const confirmacion = String(fd.get('confirmacion') ?? '');

  const problemas = problemasDeClave(nueva);
  if (problemas.length) return { error: problemas.join('\n') };
  if (nueva !== confirmacion) return { error: 'La confirmación no coincide con la clave nueva.' };
  if (nueva === actual) return { error: 'La clave nueva debe ser distinta de la actual.' };

  try {
    const db = await getDb();
    const { rows } = await db.query<{ password_hash: string }>('select password_hash from usuario where id = $1', [u.id]);
    if (!rows[0] || !(await verificarClave(actual, rows[0].password_hash))) {
      return { error: 'La clave actual no es correcta.' };
    }
    const hash = await hashClave(nueva);
    await conUsuario(u.id, async (tx) => {
      await tx.query('update usuario set password_hash = $2, debe_cambiar_password = false where id = $1', [u.id, hash]);
      await eliminarSesionesDeUsuario(tx, u.id); // cierra las demás sesiones abiertas
    });
    const { token, expira } = await crearSesion(db, u.id);
    await guardarCookie(token, expira);
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  redirect('/');
}
