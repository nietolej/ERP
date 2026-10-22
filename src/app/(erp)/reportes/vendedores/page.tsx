import { FiltroCatalogoVendedores } from '@/components/reportes/filtro-catalogo-vendedores';
import { TablaCatalogoVendedores } from '@/components/reportes/tabla-catalogo-vendedores';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import { catalogoVendedores, type OrdenVendedores } from '@/lib/reportes/vendedores';

type Busqueda = { texto?: string; anios?: string | string[]; orden?: string; incluir?: string };

const ORDENES: OrdenVendedores[] = ['venta', 'facturas', 'clientes'];

export default async function ReporteVendedoresPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const q = await searchParams;

  const texto = (q.texto ?? '').trim();
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const orden = (ORDENES as string[]).includes(q.orden ?? '') ? (q.orden as OrdenVendedores) : 'venta';
  const incluirAdministrativos = q.incluir === '1';

  // Seguridad por fila (§4.3): quien solo tiene el rol Ventas ve nada más su propia fila.
  const verTodos = (ROLES_VEN_TODOS as string[]).some((r) => u.roles.includes(r));
  let filas = await catalogoVendedores(db, { anios, texto, orden, incluirAdministrativos });
  if (!verTodos) {
    const { rows } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [u.id]);
    filas = filas.filter((f) => f.id === rows[0]?.id);
  }

  const anios_ = await aniosDisponibles(db);

  return (
    <>
      <Encabezado titulo="Vendedores" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M3) · Catálogo" />
      <Panel className="mb-5">
        <FiltroCatalogoVendedores anios={anios_} aniosSeleccionados={anios} texto={texto} orden={orden} incluirAdministrativos={incluirAdministrativos} />
      </Panel>
      <Panel>
        <TablaCatalogoVendedores filas={filas} />
      </Panel>
    </>
  );
}
