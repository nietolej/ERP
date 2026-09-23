'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Rol } from '@/lib/auth/constantes';

interface Item {
  href: string;
  texto: string;
  roles?: Rol[]; // si se indica, solo se muestra a esos roles
}

/** Menú del dashboard de ventas (spec_reportes §1.1) + grupo "Operación" del ERP. */
const GRUPOS: { titulo: string; items: Item[] }[] = [
  {
    titulo: 'Reportes',
    items: [
      { href: '/', texto: 'Inicio' },
      { href: '/reportes/clientes', texto: 'Clientes (M1)' },
      { href: '/reportes/productos', texto: 'Productos (M2)' },
      { href: '/reportes/vendedores', texto: 'Vendedores (M3)' },
      { href: '/reportes/cobranzas', texto: 'Cobranzas (M4)' },
      { href: '/reportes/devoluciones', texto: 'Devoluciones (M5)' },
      { href: '/reportes/inventario', texto: 'Inventario (M6)' },
      { href: '/metas', texto: 'Configuración de Metas' },
    ],
  },
  {
    titulo: 'Contabilidad',
    items: [
      { href: '/contabilidad/balance', texto: 'Balance de comprobación', roles: ['contabilidad', 'gerencia', 'auditor'] },
      { href: '/contabilidad/periodos', texto: 'Periodos contables', roles: ['contabilidad', 'gerencia', 'auditor'] },
      { href: '/contabilidad/plan-de-cuentas', texto: 'Plan de cuentas', roles: ['contabilidad', 'gerencia', 'auditor'] },
    ],
  },
  {
    titulo: 'Configuración',
    items: [
      { href: '/configuracion/tasas', texto: 'Tasas de cambio', roles: ['tesoreria', 'contabilidad', 'gerencia', 'auditor'] },
      { href: '/configuracion/parametros-fiscales', texto: 'Parámetros fiscales', roles: ['contabilidad', 'gerencia', 'auditor'] },
      { href: '/configuracion/empresa', texto: 'Empresa y sucursales', roles: ['administrador'] },
      { href: '/configuracion/usuarios', texto: 'Usuarios y roles', roles: ['administrador'] },
    ],
  },
];

export function BarraLateral({ roles }: { roles: string[] }) {
  const ruta = usePathname();
  const activo = (href: string) => (href === '/' ? ruta === '/' : ruta.startsWith(href));
  return (
    <nav className="flex flex-col gap-5">
      {GRUPOS.map((g) => {
        const visibles = g.items.filter((i) => !i.roles || i.roles.some((r) => roles.includes(r)));
        if (visibles.length === 0) return null;
        return (
          <div key={g.titulo}>
            <p className="mb-1.5 px-3 text-[0.7rem] font-semibold uppercase tracking-wider text-texto-2">{g.titulo}</p>
            <ul className="space-y-0.5">
              {visibles.map((i) => (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                      activo(i.href) ? 'bg-acento/20 font-semibold text-white' : 'text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    {i.texto}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
