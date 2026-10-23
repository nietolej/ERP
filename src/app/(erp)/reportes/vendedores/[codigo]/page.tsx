import { notFound } from 'next/navigation';
import { FiltroAnioProducto } from '@/components/reportes/filtro-anio-producto';
import { FiltroComparativaProducto } from '@/components/reportes/filtro-comparativa-producto';
import { PanelAnaliticaEstrategicaVendedor } from '@/components/reportes/panel-analitica-estrategica-vendedor';
import { PanelComparativaVendedor } from '@/components/reportes/panel-comparativa-vendedor';
import { PanelVistaGeneralVendedor } from '@/components/reportes/panel-vista-general-vendedor';
import { Pestanas } from '@/components/reportes/pestanas';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import { analiticaEstrategicaVendedor, comparativaMultianualVendedor, vendedorPorCodigo, vistaGeneralVendedor } from '@/lib/reportes/vendedores';

type Busqueda = { tab?: string; anios?: string | string[]; anioA?: string; anioB?: string };

export default async function ReporteVendedorPage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const tab = q.tab === 'estrategica' ? 'estrategica' : q.tab === 'comparativa' ? 'comparativa' : 'general';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const base = `/reportes/vendedores/${codigo}`;

  const vendedor = await vendedorPorCodigo(db, codigo);
  if (!vendedor) notFound();

  // Seguridad por fila (§4.3): quien solo tiene el rol Ventas ve nada más su propia ficha.
  const verTodos = (ROLES_VEN_TODOS as string[]).some((r) => u.roles.includes(r));
  if (!verTodos) {
    const { rows } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [u.id]);
    if (rows[0]?.id !== vendedor.id) notFound();
  }

  const anios_ = await aniosDisponibles(db);

  const anioActual = Number(hoyCaracas().slice(0, 4));
  const anioMasReciente = anios_[0] ?? anioActual;
  const anioB = Number.isInteger(Number(q.anioB)) && anios_.includes(Number(q.anioB)) ? Number(q.anioB) : anioMasReciente;
  const anioA = Number.isInteger(Number(q.anioA)) && anios_.includes(Number(q.anioA)) ? Number(q.anioA) : anioB - 1;
  const aniosParaComparar = anios_.includes(anioA) || anios_.includes(anioB) ? anios_ : [...anios_, anioA, anioB].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => b - a);

  const pestanas = [
    { tab: 'general', label: 'Vista general / anual', href: `${base}?tab=general` },
    { tab: 'estrategica', label: 'Analítica estratégica & cartera dormida', href: `${base}?tab=estrategica` },
    { tab: 'comparativa', label: 'Comparativa multianual', href: `${base}?tab=comparativa` },
  ];

  return (
    <>
      <Encabezado titulo={vendedor.nombre} descripcion={`${vendedor.codigo} · ${vendedor.contacto ?? '—'}`} />
      <Pestanas activa={tab} items={pestanas} />
      {tab === 'comparativa' ? (
        <>
          <FiltroComparativaProducto anios={aniosParaComparar} anioA={anioA} anioB={anioB} />
          <PanelComparativaVendedor c={await comparativaMultianualVendedor(db, vendedor.id, anioA, anioB)} />
        </>
      ) : (
        <>
          <Panel className="mb-5">
            <FiltroAnioProducto anios={anios_} aniosSeleccionados={anios} />
          </Panel>
          {tab === 'estrategica' ? (
            <PanelAnaliticaEstrategicaVendedor a={await analiticaEstrategicaVendedor(db, vendedor.id, anios)} />
          ) : (
            <PanelVistaGeneralVendedor v={await vistaGeneralVendedor(db, vendedor.id, anios)} />
          )}
        </>
      )}
    </>
  );
}
