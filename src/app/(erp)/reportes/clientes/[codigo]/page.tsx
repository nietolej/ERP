import { notFound } from 'next/navigation';
import { BuscadorCliente } from '@/components/buscador-cliente';
import { FiltroAnio } from '@/components/reportes/filtro-anio';
import { PanelAnalisisAnio } from '@/components/reportes/panel-analisis-anio';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha } from '@/lib/formato';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS, puedeVerCliente } from '@/lib/maestros/clientes';
import { analisisAnio, aniosDisponibles, topItems } from '@/lib/reportes/clientes';
import { buscarClientesAutocompletar } from '../acciones';

type Busqueda = { anios?: string | string[]; incluir?: string };

export default async function ReporteClientePage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;

  const { rows } = await db.query<{
    id: string; codigo: string; rif: string; razon_social: string; vendedor: string | null; direccion_fiscal: string | null;
  }>(
    `select c.tercero_id as id, c.codigo, t.rif, t.razon_social, v.nombre as vendedor, t.direccion_fiscal
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
  const [anios_, analisis, topCantidad, topMonto] = await Promise.all([
    aniosDisponibles(db), analisisAnio(db, filtro), topItems(db, filtro, 'cantidad'), topItems(db, filtro, 'monto'),
  ]);

  return (
    <>
      <Encabezado
        titulo={cliente.razon_social}
        descripcion={`${cliente.codigo} · ${cliente.rif} · Vendedor: ${cliente.vendedor ?? '—'} · Última compra: ${analisis.volumenOperaciones.ultimaCompra ? fecha(analisis.volumenOperaciones.ultimaCompra) : '—'}${cliente.direccion_fiscal ? ` · ${cliente.direccion_fiscal}` : ''}`}>
        <BuscadorCliente buscar={buscarClientesAutocompletar} />
      </Encabezado>
      <Panel className="mb-5">
        <FiltroAnio base={base} anios={anios_} aniosSeleccionados={anios} incluirInactivos={incluirInactivos} />
      </Panel>
      <PanelAnalisisAnio a={analisis} topCantidad={topCantidad} topMonto={topMonto} />
    </>
  );
}
