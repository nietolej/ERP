import { BuscadorCliente } from '@/components/buscador-cliente';
import { FiltroAnio } from '@/components/reportes/filtro-anio';
import { PanelAnalisisAnio } from '@/components/reportes/panel-analisis-anio';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import { analisisAnio, aniosDisponibles, topItems } from '@/lib/reportes/clientes';
import { buscarClientesAutocompletar } from './acciones';

type Busqueda = { anios?: string | string[]; incluir?: string };

export default async function ReporteClientesPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const q = await searchParams;

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
  const [anios_, analisis, topCantidad, topMonto] = await Promise.all([
    aniosDisponibles(db), analisisAnio(db, filtro), topItems(db, filtro, 'cantidad'), topItems(db, filtro, 'monto'),
  ]);

  return (
    <>
      <Encabezado titulo="Clientes" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M1)">
        <BuscadorCliente buscar={buscarClientesAutocompletar} />
      </Encabezado>
      <Panel className="mb-5">
        <FiltroAnio base="/reportes/clientes" anios={anios_} aniosSeleccionados={anios} incluirInactivos={incluirInactivos} />
      </Panel>
      <PanelAnalisisAnio a={analisis} topCantidad={topCantidad} topMonto={topMonto} />
    </>
  );
}
