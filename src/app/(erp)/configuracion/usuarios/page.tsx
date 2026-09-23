import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { NOMBRE_ROL, ROLES } from '@/lib/auth/constantes';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fechaHora } from '@/lib/formato';
import { actualizarUsuario, crearUsuario, restablecerClave } from '../acciones';

interface Fila {
  id: string; nombre: string; email: string; activo: boolean; debe_cambiar_password: boolean;
  ultimo_acceso: Date | null; roles: string[];
}

function Roles({ marcados = [] }: { marcados?: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
      {ROLES.map((r) => (
        <label key={r} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="roles" value={r} defaultChecked={marcados.includes(r)} /> {NOMBRE_ROL[r]}
        </label>
      ))}
    </div>
  );
}

export default async function UsuariosPage() {
  await exigirRol('administrador');
  const db = await getDb();
  const { rows } = await db.query<Fila>(
    `select u.id, u.nombre, u.email, u.activo, u.debe_cambiar_password, u.ultimo_acceso,
            coalesce(array_agg(ur.rol order by ur.rol) filter (where ur.rol is not null), '{}') as roles
       from usuario u left join usuario_rol ur on ur.usuario_id = u.id
      group by u.id order by u.activo desc, u.nombre`);

  return (
    <>
      <Encabezado titulo="Usuarios y roles" descripcion="Cada persona con su usuario. Los permisos se asignan por rol (§4.3)." />
      <Panel titulo="Nuevo usuario">
        <Formulario accion={crearUsuario} className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Campo etiqueta="Nombre"><input name="nombre" required className="campo" /></Campo>
            <Campo etiqueta="Correo"><input name="email" type="email" required className="campo" /></Campo>
          </div>
          <Roles />
          <p className="text-xs text-texto-2">Segregación de funciones: evite dar a una misma persona roles que se controlan entre sí (p. ej. Compras y Tesorería).</p>
          <BotonEnviar>Crear usuario</BotonEnviar>
        </Formulario>
      </Panel>

      <div className="mt-5 space-y-3">
        {rows.map((f) => (
          <Panel key={f.id}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-semibold">{f.nombre} {!f.activo && <span className="text-sm text-peligro">(inactivo)</span>}</p>
                <p className="text-sm text-texto-2">{f.email} · último acceso: {fechaHora(f.ultimo_acceso)}{f.debe_cambiar_password && ' · clave temporal pendiente de cambio'}</p>
              </div>
              <Formulario accion={restablecerClave}>
                <input type="hidden" name="id" value={f.id} />
                <BotonEnviar variante="secundario">Restablecer clave</BotonEnviar>
              </Formulario>
            </div>
            <Formulario accion={actualizarUsuario} className="space-y-3">
              <input type="hidden" name="id" value={f.id} />
              <Roles marcados={f.roles} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="activo" defaultChecked={f.activo} /> Usuario activo
              </label>
              <BotonEnviar variante="secundario">Guardar cambios</BotonEnviar>
            </Formulario>
          </Panel>
        ))}
      </div>
    </>
  );
}
