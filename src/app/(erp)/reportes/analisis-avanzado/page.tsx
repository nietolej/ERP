import Link from 'next/link';
import { PanelHistogramaPedidos, PanelMorosidad, PanelQuiebres, PanelVelocidadQuiebre } from '@/components/reportes/paneles-analisis';
import { Pestanas } from '@/components/reportes/pestanas';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_DISPONIBILIDAD } from '@/lib/inventario/disponibilidad';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import {
  almacenesDisponibles, aniosConQuiebres, gruposDisponibles, histogramaPedidos, patronesMorosidad, quiebresPorMes, quiebresPorProducto,
  sucursalesDisponibles, velocidadTrasQuiebre, zonasDisponibles, type OrdenMorosidad, type OrdenQuiebres,
} from '@/lib/reportes/analisis';
import { aniosDisponibles } from '@/lib/reportes/clientes';

type Busqueda = {
  tab?: string; anios?: string | string[]; incluir?: string; sucursal?: string; zona?: string; texto?: string; grupo?: string; almacen?: string; orden?: string;
};

const CLASE = 'campo';

export default async function AnalisisAvanzadoPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const q = await searchParams;
  const veInventario = (ROLES_VEN_DISPONIBILIDAD as readonly string[]).some((r) => u.roles.includes(r));
  const tabs = ['pedidos', 'morosidad', ...(veInventario ? ['velocidad', 'quiebres'] : [])];
  const tab = tabs.includes(q.tab ?? '') ? q.tab! : 'pedidos';
  const esComercial = tab === 'pedidos' || tab === 'morosidad';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const incluirInactivos = q.incluir === '1';
  const sucursalId = q.sucursal || undefined;
  const zona = q.zona || undefined;
  const texto = (q.texto ?? '').trim();
  const grupoId = q.grupo || undefined;
  const almacenId = q.almacen || undefined;

  // Seguridad por fila (§4.3): quien solo tiene el rol Ventas ve nada más su propia cartera.
  const verTodos = (ROLES_VEN_TODOS as string[]).some((r) => u.roles.includes(r));
  let vendedorId: string | undefined;
  if (!verTodos) {
    const { rows } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [u.id]);
    vendedorId = rows[0]?.id ?? '00000000-0000-0000-0000-000000000000';
  }

  const filtroComercial = { anios, incluirInactivos, vendedorId, sucursalId, zona, texto };
  const filtroQuiebres = { anios, grupoId, almacenId };
  const sufijo = [
    ...anios.map((a) => `&anios=${a}`), incluirInactivos ? '&incluir=1' : '', sucursalId ? `&sucursal=${sucursalId}` : '', zona ? `&zona=${encodeURIComponent(zona)}` : '',
    texto ? `&texto=${encodeURIComponent(texto)}` : '', grupoId ? `&grupo=${grupoId}` : '', almacenId ? `&almacen=${almacenId}` : '',
  ].join('');
  const pestanas = [
    { tab: 'pedidos', label: 'Histograma de pedidos', href: `/reportes/analisis-avanzado?tab=pedidos${sufijo}` },
    { tab: 'morosidad', label: 'Patrones de morosidad', href: `/reportes/analisis-avanzado?tab=morosidad${sufijo}` },
    ...(veInventario ? [
      { tab: 'velocidad', label: 'Velocidad tras quiebre', href: `/reportes/analisis-avanzado?tab=velocidad${sufijo}` },
      { tab: 'quiebres', label: 'Quiebres de stock', href: `/reportes/analisis-avanzado?tab=quiebres${sufijo}` },
    ] : []),
  ];

  const [aniosLista, sucursales, zonas, grupos, almacenes] = await Promise.all([
    esComercial ? aniosDisponibles(db) : aniosConQuiebres(db),
    esComercial ? sucursalesDisponibles(db) : Promise.resolve([]),
    esComercial ? zonasDisponibles(db) : Promise.resolve([]),
    esComercial ? Promise.resolve([]) : gruposDisponibles(db),
    esComercial ? Promise.resolve([]) : almacenesDisponibles(db),
  ]);

  const ordenMorosidad: OrdenMorosidad = q.orden === 'mora' || q.orden === 'dias' ? q.orden : 'tramo';
  const ordenQuiebres: OrdenQuiebres = q.orden === 'duracion' || q.orden === 'venta_perdida' ? q.orden : 'episodios';

  return (
    <>
      <Encabezado titulo="Análisis avanzado" descripcion="Patrones que cruzan los datos de ventas, cobranzas e inventario (M7). Los umbrales son parámetros de reportes" />
      <Pestanas activa={tab} items={pestanas} />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="tab" value={tab} />
          <label className="block">
            <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
            <select name="anios" multiple size={Math.min(aniosLista.length, 5) || 1} defaultValue={anios.map(String)} className={`${CLASE} min-w-[8rem]`}>
              {aniosLista.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          {esComercial ? (
            <>
              <label className="block"><span className="mb-1 block text-texto-2">Sucursal</span>
                <select name="sucursal" defaultValue={sucursalId ?? ''} className={CLASE}>
                  <option value="">Todas</option>
                  {sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select></label>
              <label className="block"><span className="mb-1 block text-texto-2">Zona</span>
                <select name="zona" defaultValue={zona ?? ''} className={CLASE}>
                  <option value="">Todas</option>
                  {zonas.map((z) => <option key={z} value={z}>{z}</option>)}
                </select></label>
              {tab === 'pedidos' && (
                <label className="block"><span className="mb-1 block text-texto-2">Cliente</span>
                  <input name="texto" defaultValue={texto} placeholder="Código o nombre" className={CLASE} /></label>
              )}
              <label className="flex items-center gap-2 pb-2">
                <input type="checkbox" name="incluir" value="1" defaultChecked={incluirInactivos} className="h-4 w-4" />Incluir inactivos
              </label>
            </>
          ) : (
            <>
              <label className="block"><span className="mb-1 block text-texto-2">Grupo / familia</span>
                <select name="grupo" defaultValue={grupoId ?? ''} className={CLASE}>
                  <option value="">Todos</option>
                  {grupos.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}
                </select></label>
              <label className="block"><span className="mb-1 block text-texto-2">Almacén</span>
                <select name="almacen" defaultValue={almacenId ?? ''} className={CLASE}>
                  <option value="">Todos</option>
                  {almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                </select></label>
            </>
          )}
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
          <Link href={`/reportes/analisis-avanzado?tab=${tab}`} className="py-2 text-texto-2 hover:text-texto">Quitar filtros</Link>
        </form>
      </Panel>
      {tab === 'morosidad' ? (
        <PanelMorosidad m={await patronesMorosidad(db, filtroComercial, ordenMorosidad)} orden={ordenMorosidad}
          rutaBase={`/reportes/analisis-avanzado?tab=morosidad${sufijo}`} />
      ) : tab === 'velocidad' ? (
        <PanelVelocidadQuiebre v={await velocidadTrasQuiebre(db, filtroQuiebres)} />
      ) : tab === 'quiebres' ? (
        <PanelQuiebres filas={await quiebresPorProducto(db, filtroQuiebres, ordenQuiebres)} meses={await quiebresPorMes(db, filtroQuiebres)}
          orden={ordenQuiebres} rutaBase={`/reportes/analisis-avanzado?tab=quiebres${sufijo}`} />
      ) : (
        <PanelHistogramaPedidos h={await histogramaPedidos(db, filtroComercial)} />
      )}
    </>
  );
}
