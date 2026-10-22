import { notFound } from 'next/navigation';
import { BuscadorCliente } from '@/components/buscador-cliente';
import { FiltroAnio } from '@/components/reportes/filtro-anio';
import { FiltroComparacion } from '@/components/reportes/filtro-comparacion';
import { FiltroIncluir } from '@/components/reportes/filtro-incluir';
import { PanelAnalisisAnio } from '@/components/reportes/panel-analisis-anio';
import { PanelComparacion } from '@/components/reportes/panel-comparacion';
import { PanelHistorico } from '@/components/reportes/panel-historico';
import { Pestanas } from '@/components/reportes/pestanas';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import type { Db } from '@/lib/db/tipos';
import { fecha, hoyCaracas } from '@/lib/formato';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS, puedeVerCliente } from '@/lib/maestros/clientes';
import {
  analisisAnio, analisisHistorico, aniosDisponibles, comparacionPeriodos, partidasAbiertas, periodosPorDefecto, topItems,
  type FiltroClientes,
} from '@/lib/reportes/clientes';
import { buscarClientesAutocompletar } from '../acciones';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

type Busqueda = {
  tab?: string; anios?: string | string[]; incluir?: string; a_desde?: string; a_hasta?: string; b_desde?: string; b_hasta?: string;
};

export default async function ReporteClientePage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const tab = q.tab === 'historico' ? 'historico' : q.tab === 'comparacion' ? 'comparacion' : 'anio';

  const { rows } = await db.query<{
    id: string; codigo: string; rif: string; razon_social: string; vendedor: string | null; direccion_fiscal: string | null;
    ultima_compra: string | null;
  }>(
    `select c.tercero_id as id, c.codigo, t.rif, t.razon_social, v.nombre as vendedor, t.direccion_fiscal,
            (select max(fecha)::text from vw_venta_documento where cliente_id = c.tercero_id) as ultima_compra
       from cliente c join tercero t on t.id = c.tercero_id left join vendedor v on v.id = c.vendedor_id
      where c.codigo = $1`, [codigo]);
  const cliente = rows[0];
  if (!cliente) notFound();
  if (!(await puedeVerCliente(db, u, cliente.id))) return <Aviso tono="peligro">No tiene permiso para ver este cliente.</Aviso>;

  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const incluirInactivos = q.incluir === '1';
  const verTodos = (ROLES_VEN_TODOS as string[]).some((r) => u.roles.includes(r));
  let vendedorId: string | undefined;
  if (!verTodos) {
    const { rows: v } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [u.id]);
    vendedorId = v[0]?.id;
  }

  const filtro = { clienteId: cliente.id, anios, incluirInactivos, vendedorId };
  const base = `/reportes/clientes/${codigo}`;
  const hoy = hoyCaracas();
  const anioActual = Number(hoy.slice(0, 4));
  const porDefecto = periodosPorDefecto(hoy);
  const periodoA = {
    desde: FECHA.test(q.a_desde ?? '') ? q.a_desde! : porDefecto.periodoA.desde,
    hasta: FECHA.test(q.a_hasta ?? '') ? q.a_hasta! : porDefecto.periodoA.hasta,
  };
  const periodoB = {
    desde: FECHA.test(q.b_desde ?? '') ? q.b_desde! : porDefecto.periodoB.desde,
    hasta: FECHA.test(q.b_hasta ?? '') ? q.b_hasta! : porDefecto.periodoB.hasta,
  };
  const pestanas = [
    { tab: 'anio', label: 'Análisis por año', href: `${base}?tab=anio${incluirInactivos ? '&incluir=1' : ''}` },
    { tab: 'historico', label: 'Análisis total (histórico)', href: `${base}?tab=historico${incluirInactivos ? '&incluir=1' : ''}` },
    { tab: 'comparacion', label: 'Comparación de periodos', href: `${base}?tab=comparacion${incluirInactivos ? '&incluir=1' : ''}` },
  ];

  return (
    <>
      <Encabezado
        titulo={cliente.razon_social}
        descripcion={`${cliente.codigo} · ${cliente.rif} · Vendedor: ${cliente.vendedor ?? '—'} · Última compra: ${cliente.ultima_compra ? fecha(cliente.ultima_compra) : '—'}${cliente.direccion_fiscal ? ` · ${cliente.direccion_fiscal}` : ''}`}>
        <BuscadorCliente buscar={buscarClientesAutocompletar} />
      </Encabezado>
      <Pestanas activa={tab} items={pestanas} />
      {tab === 'historico' ? (
        <TabHistorico db={db} filtro={{ clienteId: cliente.id, incluirInactivos, vendedorId }} anioActual={anioActual} />
      ) : tab === 'comparacion' ? (
        <TabComparacion db={db} filtro={{ clienteId: cliente.id, incluirInactivos, vendedorId }} periodoA={periodoA} periodoB={periodoB} />
      ) : (
        <TabAnio db={db} filtro={filtro} anios={anios} incluirInactivos={incluirInactivos} base={base} />
      )}
    </>
  );
}

async function TabAnio({ db, filtro, anios, incluirInactivos, base }: {
  db: Db; filtro: FiltroClientes; anios: number[]; incluirInactivos: boolean; base: string;
}) {
  const [anios_, analisis, topCantidad, topMonto] = await Promise.all([
    aniosDisponibles(db), analisisAnio(db, filtro), topItems(db, filtro, 'cantidad'), topItems(db, filtro, 'monto'),
  ]);
  return (
    <>
      <Panel className="mb-5">
        <FiltroAnio base={base} anios={anios_} aniosSeleccionados={anios} incluirInactivos={incluirInactivos} />
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

async function TabComparacion({ db, filtro, periodoA, periodoB }: {
  db: Db; filtro: Omit<FiltroClientes, 'anios'>; periodoA: { desde: string; hasta: string }; periodoB: { desde: string; hasta: string };
}) {
  const c = await comparacionPeriodos(db, { ...filtro, periodoA, periodoB });
  return (
    <>
      <FiltroComparacion periodoA={periodoA} periodoB={periodoB} incluirInactivos={Boolean(filtro.incluirInactivos)} />
      <PanelComparacion c={c} />
    </>
  );
}
