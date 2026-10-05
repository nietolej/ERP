import { notFound } from 'next/navigation';
import { BotonEnviar } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Panel } from '@/components/ui';
import { NOMBRE_ROL, sinLogin, type Rol } from '@/lib/auth/constantes';
import { exigirSesion } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { elegirUsuarioDesarrolloAccion } from './acciones';

export default async function UsuarioDesarrolloPage() {
  if (!sinLogin()) notFound();
  const actual = await exigirSesion();
  const { rows } = await (await getDb()).query<{ id: string; nombre: string; email: string; roles: string[] | null }>(
    `select u.id, u.nombre, u.email, array_remove(array_agg(r.rol order by r.rol), null) as roles
       from usuario u left join usuario_rol r on r.usuario_id = u.id where u.activo group by u.id order by u.nombre`);

  return (
    <>
      <Encabezado titulo="Cambiar de usuario (modo sin login)"
        descripcion="Solo desarrollo. Útil para probar permisos y aprobaciones, que exigen personas distintas (quien crea no aprueba)." />
      <div className="mb-5">
        <Aviso tono="advertencia">
          El ERP está sin inicio de sesión porque ERP_SIN_LOGIN=1 en .env.local. Para activarlo de nuevo, borre esa línea y reinicie el ERP.
        </Aviso>
      </div>
      <Panel titulo={`Trabajando como: ${actual.nombre}`}>
        <form action={elegirUsuarioDesarrolloAccion} className="flex flex-wrap items-end gap-3">
          <Campo etiqueta="Usuario">
            <select name="usuario_id" defaultValue={actual.id} className="campo w-96">
              {rows.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre} · {u.roles?.length ? u.roles.map((r) => NOMBRE_ROL[r as Rol] ?? r).join(', ') : 'sin roles'}
                </option>
              ))}
            </select>
          </Campo>
          <BotonEnviar>Cambiar</BotonEnviar>
        </form>
      </Panel>
    </>
  );
}
