import { BuscadorCliente } from '@/components/buscador-cliente';
import { FiltroAnio } from '@/components/reportes/filtro-anio';
import { FiltroIncluir } from '@/components/reportes/filtro-incluir';
import { PanelAnalisisAnio } from '@/components/reportes/panel-analisis-anio';
import { PanelHistorico } from '@/components/reportes/panel-historico';
import { Pestanas } from '@/components/reportes/pestanas';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import type { Db } from '@/lib/db/tipos';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import {
  analisisAnio, analisisHistorico, aniosDisponibles, partidasAbiertas, topItems, type FiltroClientes,
} from '@/lib/reportes/clientes';
import { buscarClientesAutocompletar } from './acciones';

type Busqueda = { tab?: string; anios?: string | string[]; incluir?: string };

export default async function ReporteClientesPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const q = await searchParams;
  const tab = q.tab === 'historico' ? 'historico' : 'anio';

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
  const anioActual = new Date().getUTCFullYear();
  const pestanas = [
    { tab: 'anio', label: 'Análisis por año', href: `/reportes/clientes?tab=anio${incluirInactivos ? '&incluir=1' : ''}` },
    { tab: 'historico', label: 'Análisis total (histórico)', href: `/reportes/clientes?tab=historico${incluirInactivos ? '&incluir=1' : ''}` },
  ];

  return (
    <>
      <Encabezado titulo="Clientes" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M1)">
        <BuscadorCliente buscar={buscarClientesAutocompletar} />
      </Encabezado>
      <Pestanas activa={tab} items={pestanas} />
      {tab === 'historico' ? (
        <TabHistorico db={db} filtro={{ incluirInactivos, vendedorId }} anioActual={anioActual} />
      ) : (
        <TabAnio db={db} filtro={filtro} anios={anios} incluirInactivos={incluirInactivos} />
      )}
    </>
  );
}

async function TabAnio({ db, filtro, anios, incluirInactivos }: {
  db: Db; filtro: FiltroClientes; anios: number[]; incluirInactivos: boolean;
}) {
  const [anios_, analisis, topCantidad, topMonto] = await Promise.all([
    aniosDisponibles(db), analisisAnio(db, filtro), topItems(db, filtro, 'cantidad'), topItems(db, filtro, 'monto'),
  ]);
  return (
    <>
      <Panel className="mb-5">
        <FiltroAnio base="/reportes/clientes" anios={anios_} aniosSeleccionados={anios} incluirInactivos={incluirInactivos} />
      </Panel>
      <PanelAnalisisAnio a={analisis} topCantidad={topCantidad} topMonto={topMonto} />
    </>
  );
}

async function TabHistorico({ db, filtro, anioActual }: { db: Db; filtro: Omit<FiltroClientes, 'anios'>; anioActual: number }) {
  const [h, partidas] = await Promise.all([analisisHistorico(db, filtro), partidasAbiertas(db, filtro)]);
  return (
    <>
      <FiltroIncluir incluirInactivos={Boolean(filtro.incluirInactivos)} tab="historico" />
      <PanelHistorico h={h} partidas={partidas} anioActual={anioActual} />
    </>
  );
}
