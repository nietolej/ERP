import { redirect } from 'next/navigation';
import type { Db } from '@/lib/db/tipos';
import { ROLES_VEN_TODOS } from '@/lib/maestros/roles';

/** Solo los roles con acceso global pueden consultar sin filtro de vendedor. */
export async function vendedorDeCartera(db: Db, usuario: { id: string; roles: readonly string[] }): Promise<string | undefined> {
  if (ROLES_VEN_TODOS.some((rol) => usuario.roles.includes(rol))) return undefined;
  const { rows } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [usuario.id]);
  if (!rows[0]) redirect('/sin-permiso');
  return rows[0].id;
}
