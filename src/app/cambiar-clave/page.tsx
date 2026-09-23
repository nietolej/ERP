import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo } from '@/components/ui';
import { exigirSesion } from '@/lib/auth/dal';
import { cambiarClave } from '../acciones-sesion';

export default async function CambiarClavePage() {
  const u = await exigirSesion({ permitirCambioClave: true });
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="panel w-full max-w-md p-7">
        <h1 className="mb-2 text-2xl font-bold">Cambiar clave</h1>
        <p className="mb-5 text-sm text-texto-2">{u.nombre} · {u.email}</p>
        {u.debeCambiarPassword && (
          <div className="mb-5">
            <Aviso tono="advertencia">Está usando una clave temporal. Debe cambiarla para continuar.</Aviso>
          </div>
        )}
        <Formulario accion={cambiarClave} className="space-y-4">
          <Campo etiqueta="Clave actual">
            <input name="actual" type="password" autoComplete="current-password" required className="campo" />
          </Campo>
          <Campo etiqueta="Clave nueva" ayuda="Mínimo 10 caracteres, con letras y números.">
            <input name="nueva" type="password" autoComplete="new-password" required minLength={10} className="campo" />
          </Campo>
          <Campo etiqueta="Confirmar clave nueva">
            <input name="confirmacion" type="password" autoComplete="new-password" required className="campo" />
          </Campo>
          <BotonEnviar>Guardar clave</BotonEnviar>
        </Formulario>
      </div>
    </main>
  );
}
