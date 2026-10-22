import { FiltroCatalogoProductos } from '@/components/reportes/filtro-catalogo-productos';
import { TablaCatalogoProductos } from '@/components/reportes/tabla-catalogo-productos';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { catalogoProductos } from '@/lib/reportes/productos';

type Busqueda = { texto?: string; anios?: string | string[]; limite?: string };

export default async function ReporteProductosPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  await exigirRol(...ROLES_VEN_PRODUCTOS);
  const db = await getDb();
  const q = await searchParams;

  const texto = (q.texto ?? '').trim();
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const limite = Number(q.limite);
  const limiteValido = [25, 50, 100, 200, 500].includes(limite) ? limite : 100;

  const [anios_, filas] = await Promise.all([
    aniosDisponibles(db), catalogoProductos(db, { anios, texto, limite: limiteValido }),
  ]);

  return (
    <>
      <Encabezado titulo="Productos" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M2) · Catálogo de artículos" />
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
