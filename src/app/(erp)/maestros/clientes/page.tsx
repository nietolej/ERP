import Link from 'next/link';
import { ListaClientes } from '@/components/lista-clientes';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS, buscarClientes } from '@/lib/maestros/clientes';
import { buscarClientesAccion } from './acciones';

const LIMITE = 100;

export default async function ClientesPage() {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const [filas, pendientes] = await Promise.all([
    buscarClientes(db, u, {}, LIMITE),
    tieneRol(u, ['gerencia'])
      ? db.query<{ n: number }>(`select count(*)::int as n from cliente where estado = 'pendiente'`).then((r) => r.rows[0].n)
      : Promise.resolve(0),
  ]);
  const soloCartera = !tieneRol(u, ROLES_VEN_TODOS);

  return (
    <>
      <Encabezado titulo="Clientes"
        descripcion={soloCartera ? 'Su cartera de clientes.' : 'Un RIF es un solo tercero. Los clientes nuevos quedan pendientes hasta que Gerencia los aprueba.'}>
        {tieneRol(u, ['facturacion']) && (
          <Link href="/maestros/clientes/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Nuevo cliente
          </Link>
        )}
      </Encabezado>
      {pendientes > 0 && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            {pendientes === 1 ? 'Hay 1 cliente pendiente' : `Hay ${pendientes} clientes pendientes`} de aprobación: ábralo para asignarle condición de pago y límite de crédito.
          </Aviso>
        </div>
      )}
      <Panel>
        <ListaClientes iniciales={filas} buscar={buscarClientesAccion} limite={LIMITE} />
      </Panel>
    </>
  );
}
