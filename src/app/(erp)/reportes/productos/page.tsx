import { FiltroCatalogoProductos } from '@/components/reportes/filtro-catalogo-productos';
import { FiltroGruposProductos } from '@/components/reportes/filtro-grupos-productos';
import { Pestanas } from '@/components/reportes/pestanas';
import { TablaCatalogoProductos } from '@/components/reportes/tabla-catalogo-productos';
import { TablaGruposProductos } from '@/components/reportes/tabla-grupos-productos';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import type { Db } from '@/lib/db/tipos';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { analisisGrupos, catalogoProductos, type Agrupador } from '@/lib/reportes/productos';

type Busqueda = { tab?: string; texto?: string; anios?: string | string[]; limite?: string; agrupar?: string };

export default async function ReporteProductosPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  await exigirRol(...ROLES_VEN_PRODUCTOS);
  const db = await getDb();
  const q = await searchParams;
  const tab = q.tab === 'grupos' ? 'grupos' : 'catalogo';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const pestanas = [
    { tab: 'catalogo', label: 'Catálogo de artículos', href: '/reportes/productos?tab=catalogo' },
    { tab: 'grupos', label: 'Análisis por grupos/familias', href: '/reportes/productos?tab=grupos' },
  ];

  return (
    <>
      <Encabezado titulo="Productos" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M2)" />
      <Pestanas activa={tab} items={pestanas} />
      {tab === 'grupos' ? (
        <TabGrupos db={db} anios={anios} agrupador={q.agrupar === 'codigo_comun' ? 'codigo_comun' : 'categoria'} />
      ) : (
        <TabCatalogo db={db} anios={anios} texto={(q.texto ?? '').trim()} limite={q.limite} />
      )}
    </>
  );
}

async function TabCatalogo({ db, anios, texto, limite }: { db: Db; anios: number[]; texto: string; limite?: string }) {
  const limiteNum = Number(limite);
  const limiteValido = [25, 50, 100, 200, 500].includes(limiteNum) ? limiteNum : 100;
  const [anios_, filas] = await Promise.all([
    aniosDisponibles(db), catalogoProductos(db, { anios, texto, limite: limiteValido }),
  ]);
  return (
    <>
      <Panel className="mb-5">
        <FiltroCatalogoProductos anios={anios_} aniosSeleccionados={anios} texto={texto} limite={limiteValido} />
      </Panel>
      <Panel>
        <TablaCatalogoProductos filas={filas} />
        {filas.length >= limiteValido && <p className="mt-3 text-xs text-texto-2">Se muestran los primeros {limiteValido}; afine la búsqueda o aumente las filas para ver más.</p>}
      </Panel>
    </>
  );
}

async function TabGrupos({ db, anios, agrupador }: { db: Db; anios: number[]; agrupador: Agrupador }) {
  const [anios_, grupos] = await Promise.all([aniosDisponibles(db), analisisGrupos(db, agrupador, { anios })]);
  return (
    <>
      <Panel className="mb-5">
        <FiltroGruposProductos agrupador={agrupador} anios={anios_} aniosSeleccionados={anios} />
      </Panel>
      <Panel>
        <TablaGruposProductos filas={grupos} />
      </Panel>
    </>
  );
}
