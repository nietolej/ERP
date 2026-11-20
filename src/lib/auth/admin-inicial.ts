import type { Db } from '@/lib/db/tipos';
import { EMAIL_USUARIO_DEV } from './constantes';

export async function hayAdministradorActivo(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ existe: boolean }>(
    `select exists (select 1 from usuario u join usuario_rol r on r.usuario_id = u.id
                     where r.rol = 'administrador' and u.activo and lower(u.email) <> $1) as existe`,
    [EMAIL_USUARIO_DEV],
  );
  return rows[0].existe;
}
