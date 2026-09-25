'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MODULOS } from '@/lib/modulos';

export function BarraLateral({ roles }: { roles: string[] }) {
  const ruta = usePathname();
  const activo = (href: string) => (href === '/' ? ruta === '/' : ruta.startsWith(href));
  return (
    <nav className="flex flex-col gap-5">
      {MODULOS.map((m) => {
        const visibles = m.items.filter((i) => !i.roles || i.roles.some((r) => roles.includes(r)));
        if (visibles.length === 0) return null;
        return (
          <div key={m.codigo}>
            <p className="mb-1.5 px-3 text-[0.7rem] font-semibold uppercase tracking-wider text-texto-2" title={m.descripcion}>
              {m.codigo} · {m.nombre}
            </p>
            <ul className="space-y-0.5">
              {visibles.map((i) => (
                <li key={i.texto}>
                  {i.href ? (
                    <Link
                      href={i.href}
                      className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                        activo(i.href) ? 'bg-acento/20 font-semibold text-white' : 'text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      {i.texto}
                    </Link>
                  ) : (
                    <span className="flex justify-between rounded-lg px-3 py-1.5 text-sm text-slate-500" title={`Se entrega en la Fase ${i.fase}`}>
                      {i.texto}
                      <span className="text-[0.65rem]">F{i.fase}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
