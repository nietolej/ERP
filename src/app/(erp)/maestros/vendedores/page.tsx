import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_TODOS } from '@/lib/maestros/roles';
import { NOMBRE_TIPO_VENDEDOR, type TipoVendedor } from '@/lib/maestros/vendedores';

export default async function VendedoresPage() {
  const u = await exigirRol(...ROLES_VEN_TODOS);
  const administra = tieneRol(u, ['gerencia', 'supervisor_ventas']);
  const db = await getDb();
  const { rows } = await db.query<{
    id: string; codigo: string; nombre: string; tipo: TipoVendedor; sucursal: string | null;
    usuario: string | null; estado: string; clientes: number;
  }>(
    `select v.id, v.codigo, v.nombre, v.tipo, s.nombre as sucursal, u.nombre as usuario, v.estado,
            (select count(*)::int from cliente c where c.vendedor_id = v.id) as clientes
       from vendedor v
       left join sucursal s on s.id = v.sucursal_id
       left join usuario u on u.id = v.usuario_id
      order by v.estado, v.codigo`);

  return (
    <>
      <Encabezado titulo="Vendedores"
        descripcion="Los vendedores administrativos y de la casa quedan fuera de rankings y comisiones por su tipo.">
        {administra && (
          <Link href="/maestros/vendedores/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Nuevo vendedor
          </Link>
        )}
      </Encabezado>
      <Panel>
        <Tabla columnas={['Código', 'Nombre', 'Tipo', 'Sucursal', 'Usuario del ERP', { t: 'Clientes', derecha: true }, 'Estado']}
          vacio="No hay vendedores registrados.">
          {rows.map((v) => (
            <tr key={v.id} className="hover:bg-white/[0.03]">
              <Celda mono>{administra ? <Link href={`/maestros/vendedores/${v.id}`} className="text-acento hover:underline">{v.codigo}</Link> : v.codigo}</Celda>
              <Celda>{v.nombre}</Celda>
              <Celda className="text-texto-2">{NOMBRE_TIPO_VENDEDOR[v.tipo]}</Celda>
              <Celda className="text-texto-2">{v.sucursal ?? '—'}</Celda>
              <Celda className="text-texto-2">{v.usuario ?? '—'}</Celda>
              <Celda derecha>{v.clientes}</Celda>
              <Celda><Etiqueta tono={v.estado === 'activo' ? 'exito' : 'info'}>{v.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
