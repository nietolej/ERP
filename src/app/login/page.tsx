import { redirect } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo } from '@/components/ui';
import { obtenerUsuario } from '@/lib/auth/dal';
import { iniciarSesion } from '../acciones-sesion';

export default async function LoginPage() {
  if (await obtenerUsuario()) redirect('/');
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="panel w-full max-w-sm p-7">
        <p className="text-xs font-semibold uppercase tracking-wider text-acento">Distribuciones Hanei Motors</p>
        <h1 className="mt-1 mb-6 text-2xl font-bold">ERP · Iniciar sesión</h1>
        <Formulario accion={iniciarSesion} className="space-y-4">
          <Campo etiqueta="Correo">
            <input name="email" type="email" autoComplete="username" required className="campo" />
          </Campo>
          <Campo etiqueta="Clave">
            <input name="clave" type="password" autoComplete="current-password" required className="campo" />
          </Campo>
          <BotonEnviar>Entrar</BotonEnviar>
        </Formulario>
      </div>
    </main>
  );
}
