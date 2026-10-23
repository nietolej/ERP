import { notFound } from 'next/navigation';
import { FiltroAnioProducto } from '@/components/reportes/filtro-anio-producto';
import { PanelAnaliticaEstrategicaVendedor } from '@/components/reportes/panel-analitica-estrategica-vendedor';
import { PanelVistaGeneralVendedor } from '@/components/reportes/panel-vista-general-vendedor';
import { Pestanas } from '@/components/reportes/pestanas';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import { analiticaEstrategicaVendedor, vendedorPorCodigo, vistaGeneralVendedor } from '@/lib/reportes/vendedores';

type Busqueda = { tab?: string; anios?: string | string[] };

export default async function ReporteVendedorPage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const tab = q.tab === 'estrategica' ? 'estrategica' : 'general';
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

  const pestanas = [
    { tab: 'general', label: 'Vista general / anual', href: `${base}?tab=general` },
    { tab: 'estrategica', label: 'Analítica estratégica & cartera dormida', href: `${base}?tab=estrategica` },
  ];

  return (
    <>
      <Encabezado titulo={vendedor.nombre} descripcion={`${vendedor.codigo} · ${vendedor.contacto ?? '—'}`} />
      <Pestanas activa={tab} items={pestanas} />
      <Panel className="mb-5">
        <FiltroAnioProducto anios={anios_} aniosSeleccionados={anios} />
      </Panel>
      {tab === 'estrategica' ? (
        <PanelAnaliticaEstrategicaVendedor a={await analiticaEstrategicaVendedor(db, vendedor.id, anios)} />
      ) : (
        <PanelVistaGeneralVendedor v={await vistaGeneralVendedor(db, vendedor.id, anios)} />
      )}
    </>
  );
}
