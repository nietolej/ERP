import Link from 'next/link';
import { Aviso, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { ROLES_VEN_EXISTENCIAS, listarExistencias } from '@/lib/inventario/ajustes';
import { almacenesVisibles } from '@/lib/maestros/almacenes';

const LIMITE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ExistenciasPage({ searchParams }: { searchParams: Promise<{ almacen?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_EXISTENCIAS);
  const db = await getDb();
  const visibles = await almacenesVisibles(db, u);
  const { rows: almacenes } = await db.query<{ id: string; codigo: string; nombre: string }>(
    `select id, codigo, nombre from almacen where id = any($1::uuid[]) order by codigo`, [visibles]);
  const { almacen = '' } = await searchParams;
  const elegido = almacenes.find((a) => UUID.test(almacen) && a.id === almacen) ?? almacenes[0];
  const filas = elegido ? await listarExistencias(db, u, elegido.id, LIMITE) : [];
  const total = filas.reduce((s, f) => s + Number(f.valor_usd), 0);

  return (
    <>
      <Encabezado titulo="Existencias"
        descripcion="Cantidad, reservado y disponible por producto, con su valor al costo promedio de la empresa (USD). Solo los almacenes que usted ve." />
      {almacenes.length === 0 ? (
        <Aviso tono="advertencia">No tiene almacenes asignados.</Aviso>
      ) : (
        <Panel>
          <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Almacén">
            {almacenes.map((a) => (
              <Link key={a.id} href={`/inventario/existencias?almacen=${a.id}`}
                className={`rounded-full border px-3 py-1 ${elegido?.id === a.id ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
                {a.codigo} · {a.nombre}
              </Link>
            ))}
          </nav>
          <Tabla columnas={['Código', 'Descripción', { t: 'Cantidad', derecha: true }, { t: 'Reservado', derecha: true }, { t: 'Disponible', derecha: true },
            { t: 'Costo US$', derecha: true }, { t: 'Valor US$', derecha: true }]} vacio="Este almacén no tiene existencias registradas.">
            {filas.map((f) => (
              <tr key={f.producto_id}>
                <Celda mono>{f.codigo}</Celda>
                <Celda>{f.descripcion}</Celda>
                <Celda derecha mono>{Number(f.cantidad)}</Celda>
                <Celda derecha mono className="text-texto-2">{Number(f.reservado)}</Celda>
                <Celda derecha mono>{Number(f.disponible)}</Celda>
                <Celda derecha mono className="text-texto-2">{monto(f.costo_promedio)}</Celda>
                <Celda derecha mono>{monto(f.valor_usd)}</Celda>
              </tr>
            ))}
          </Tabla>
          {filas.length > 0 && (
            <p className="mt-3 text-right text-sm text-texto-2">
              {filas.length === LIMITE ? `Primeros ${LIMITE} productos · ` : ''}Valor mostrado: <span className="font-mono text-texto">{monto(total, 'US$ ')}</span>
            </p>
          )}
        </Panel>
      )}
    </>
  );
}
