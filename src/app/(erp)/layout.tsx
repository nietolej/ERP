import Link from 'next/link';
import { BarraLateral } from '@/components/barra-lateral';
import { exigirSesion } from '@/lib/auth/dal';
import { NOMBRE_ROL, type Rol } from '@/lib/auth/constantes';
import { sinLogin } from '@/lib/auth/modo-desarrollo';
import { getDb } from '@/lib/db';
import { cerrarSesion } from '../acciones-sesion';

export default async function ErpLayout({ children }: LayoutProps<'/'>) {
  const u = await exigirSesion();
  // Una base sembrada con la empresa ficticia (npm run db:sembrar-demo) se marca como demostración: el letrero evita
  // confundir sus cifras con las de una empresa real.
  const { rows: marca } = await (await getDb()).query<{ es_demo: boolean; razon_social: string }>('select es_demo, razon_social from empresa limit 1');
  const esDemo = marca[0]?.es_demo === true;
  const nombreEmpresa = marca[0]?.razon_social ?? 'ERP';
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-64 print:hidden shrink-0 flex-col border-r border-borde bg-slate-950/60 p-4">
        <Link href="/" className="mb-6 block px-3">
          <p className="text-base font-bold leading-tight">{nombreEmpresa}</p>
          <p className="text-xs text-texto-2">ERP · Fase 0</p>
        </Link>
        <div className="flex-1 overflow-y-auto">
          <BarraLateral roles={u.roles} />
        </div>
        <div className="mt-4 border-t border-borde px-3 pt-4 text-sm">
          <p className="font-semibold">{u.nombre}</p>
          <p className="text-xs text-texto-2">
            {u.roles.length ? u.roles.map((r) => NOMBRE_ROL[r as Rol] ?? r).join(' · ') : 'Sin roles asignados'}
          </p>
          {sinLogin() ? (
            <div className="mt-3 space-y-1 rounded-lg border border-advertencia/40 bg-advertencia/10 p-2 text-xs text-amber-200">
              <p className="font-semibold">Modo sin login (desarrollo)</p>
              <Link href="/desarrollo/usuario" className="underline">Cambiar de usuario</Link>
            </div>
          ) : (
            <div className="mt-3 flex gap-3 text-xs">
              <Link href="/cambiar-clave" className="text-texto-2 hover:text-texto">Cambiar clave</Link>
              <form action={cerrarSesion}>
                <button type="submit" className="text-texto-2 hover:text-texto">Cerrar sesión</button>
              </form>
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        {esDemo && (
          <p role="status" className="mb-4 rounded-lg border border-advertencia/40 bg-advertencia/10 px-3 py-2 text-sm text-amber-200 print:hidden">
            <span className="font-semibold">Entorno de demostración.</span> Empresa y datos ficticios, solo para probar el sistema: no son cifras reales.
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
