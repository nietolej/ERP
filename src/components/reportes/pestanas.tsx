import Link from 'next/link';

/** Pestañas de M1 Clientes, iguales en la vista global y en la de un cliente (spec_reportes §4). */
export function Pestanas({ activa, items }: { activa: string; items: { tab: string; label: string; href: string }[] }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-borde">
      {items.map((it) => (
        <Link key={it.tab} href={it.href}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${activa === it.tab ? 'border-acento text-texto' : 'border-transparent text-texto-2 hover:text-texto'}`}>
          {it.label}
        </Link>
      ))}
    </div>
  );
}
