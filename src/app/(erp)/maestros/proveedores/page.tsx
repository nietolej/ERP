import Link from 'next/link';
import { ListaProveedores } from '@/components/lista-proveedores';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_TIPO_PROVEEDOR, ROLES_VEN_PROVEEDORES, buscarProveedores } from '@/lib/maestros/proveedores';
import { buscarProveedoresAccion } from './acciones';

const LIMITE = 100;

export default async function ProveedoresPage() {
  const u = await exigirRol(...ROLES_VEN_PROVEEDORES);
  const db = await getDb();
  const filas = await buscarProveedores(db, {}, LIMITE);
  const { rows } = await db.query<{ altas: number; cambios: number }>(
    `select (select count(*)::int from proveedor where estado = 'pendiente') as altas,
            (select count(*)::int from proveedor_cambio where estado = 'pendiente') as cambios`);
  const { altas, cambios } = rows[0];

  return (
    <>
      <Encabezado titulo="Proveedores"
        descripcion="Compras registra y Gerencia aprueba. Los cambios de datos sensibles de un proveedor aprobado también pasan por Gerencia.">
        {tieneRol(u, ['compras']) && (
          <Link href="/maestros/proveedores/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Nuevo proveedor
          </Link>
        )}
      </Encabezado>
      {tieneRol(u, ['gerencia']) && (altas > 0 || cambios > 0) && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Por aprobar: {altas} proveedor(es) nuevo(s) y {cambios} solicitud(es) de cambio. Aparecen primero en la lista.
          </Aviso>
        </div>
      )}
      <Panel>
        <ListaProveedores iniciales={filas} buscar={buscarProveedoresAccion} limite={LIMITE} tipos={NOMBRE_TIPO_PROVEEDOR} />
      </Panel>
    </>
  );
}
