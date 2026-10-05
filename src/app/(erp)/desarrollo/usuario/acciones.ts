'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { texto } from '@/lib/acciones';
import { COOKIE_USUARIO_DEV, sinLogin } from '@/lib/auth/constantes';
import { getDb } from '@/lib/db';
import { cargarUsuario } from '@/lib/auth/sesiones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Elige con qué usuario se trabaja en el modo sin login. Solo existe en desarrollo (ERP_SIN_LOGIN=1). */
export async function elegirUsuarioDesarrolloAccion(fd: FormData): Promise<void> {
  if (!sinLogin()) redirect('/login');
  const id = texto(fd, 'usuario_id');
  const jar = await cookies();
  if (id && UUID.test(id) && (await cargarUsuario(await getDb(), id))) {
    jar.set(COOKIE_USUARIO_DEV, id, { httpOnly: true, sameSite: 'lax', path: '/' });
  } else {
    jar.delete(COOKIE_USUARIO_DEV);
  }
  redirect('/');
}
