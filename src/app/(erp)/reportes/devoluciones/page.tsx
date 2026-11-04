import Link from 'next/link';
import { PanelDevolucionesResumen, TablaDevolucionesCliente, TablaDevolucionesProducto, TablaDevolucionesVendedor, TarjetasDevoluciones } from '@/components/reportes/paneles-devoluciones';
import { Pestanas } from '@/components/reportes/pestanas';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import {
  devolucionesPorCliente, devolucionesPorProducto, devolucionesPorVendedor, resumenDevoluciones, tendenciaDevoluciones,
} from '@/lib/reportes/devoluciones';

type Busqueda = { tab?: string; anios?: string | string[]; incluir?: string };

const TABS = ['resumen', 'cliente', 'vendedor', 'producto'] as const;

export default async function ReporteDevolucionesPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const q = await searchParams;
  const tab = (TABS as readonly string[]).includes(q.tab ?? '') ? q.tab! : 'resumen';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const incluirInactivos = q.incluir === '1';

  // Seguridad por fila (§4.3): quien solo tiene el rol Ventas ve nada más su propia cartera.
  const verTodos = (ROLES_VEN_TODOS as string[]).some((r) => u.roles.includes(r));
  let vendedorId: string | undefined;
  if (!verTodos) {
    const { rows } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [u.id]);
    vendedorId = rows[0]?.id;
  }
  const filtro = { anios, incluirInactivos, vendedorId };

  const sufijo = `${incluirInactivos ? '&incluir=1' : ''}${anios.map((a) => `&anios=${a}`).join('')}`;
  const pestanas = [
    { tab: 'resumen', label: 'Resumen & tendencia mensual', href: `/reportes/devoluciones?tab=resumen${sufijo}` },
    { tab: 'cliente', label: 'Análisis por cliente', href: `/reportes/devoluciones?tab=cliente${sufijo}` },
    { tab: 'vendedor', label: 'Análisis por vendedor', href: `/reportes/devoluciones?tab=vendedor${sufijo}` },
    { tab: 'producto', label: 'Análisis por producto', href: `/reportes/devoluciones?tab=producto${sufijo}` },
  ];

  const [aniosLista, resumen] = await Promise.all([aniosDisponibles(db), resumenDevoluciones(db, filtro)]);

  return (
    <>
      <Encabezado titulo="Devoluciones" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M5)" />
      <Pestanas activa={tab} items={pestanas} />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="tab" value={tab} />
          <label className="block">
            <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
            <select name="anios" multiple size={Math.min(aniosLista.length, 5) || 1} defaultValue={anios.map(String)} className="campo min-w-[8rem]">
              {aniosLista.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" name="incluir" value="1" defaultChecked={incluirInactivos} className="h-4 w-4" />Incluir inactivos
          </label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
          <Link href={`/reportes/devoluciones?tab=${tab}`} className="py-2 text-texto-2 hover:text-texto">Todos los años</Link>
        </form>
      </Panel>
      <TarjetasDevoluciones r={resumen} />
      {tab === 'cliente' ? (
        <Panel><TablaDevolucionesCliente filas={await devolucionesPorCliente(db, filtro)} /></Panel>
      ) : tab === 'vendedor' ? (
        <Panel><TablaDevolucionesVendedor filas={await devolucionesPorVendedor(db, filtro)} /></Panel>
      ) : tab === 'producto' ? (
        <Panel><TablaDevolucionesProducto filas={await devolucionesPorProducto(db, filtro)} /></Panel>
      ) : (
        <PanelDevolucionesResumen serie={await tendenciaDevoluciones(db, filtro)} />
      )}
    </>
  );
}
