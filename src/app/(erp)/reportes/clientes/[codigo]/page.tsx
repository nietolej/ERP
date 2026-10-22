import { notFound } from 'next/navigation';
import { BuscadorCliente } from '@/components/buscador-cliente';
import { FiltroAnio } from '@/components/reportes/filtro-anio';
import { FiltroIncluir } from '@/components/reportes/filtro-incluir';
import { PanelAnalisisAnio } from '@/components/reportes/panel-analisis-anio';
import { PanelHistorico } from '@/components/reportes/panel-historico';
import { Pestanas } from '@/components/reportes/pestanas';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import type { Db } from '@/lib/db/tipos';
import { fecha } from '@/lib/formato';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS, puedeVerCliente } from '@/lib/maestros/clientes';
import {
  analisisAnio, analisisHistorico, aniosDisponibles, partidasAbiertas, topItems, type FiltroClientes,
} from '@/lib/reportes/clientes';
import { buscarClientesAutocompletar } from '../acciones';

type Busqueda = { tab?: string; anios?: string | string[]; incluir?: string };

export default async function ReporteClientePage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const tab = q.tab === 'historico' ? 'historico' : 'anio';

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
  const anioActual = new Date().getUTCFullYear();
  const pestanas = [
    { tab: 'anio', label: 'Análisis por año', href: `${base}?tab=anio${incluirInactivos ? '&incluir=1' : ''}` },
    { tab: 'historico', label: 'Análisis total (histórico)', href: `${base}?tab=historico${incluirInactivos ? '&incluir=1' : ''}` },
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
