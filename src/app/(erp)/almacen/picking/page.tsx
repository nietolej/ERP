import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_PICKING, buscarOrdenes } from '@/lib/ventas/picking';
import { etiquetaOrden } from '@/lib/ventas/presentacion';

const FILTROS = [
  { valor: '', texto: 'Todas' },
  { valor: 'pendiente', texto: 'Pendientes' },
  { valor: 'asignada', texto: 'Asignadas' },
  { valor: 'en_proceso', texto: 'En proceso' },
  { valor: 'con_faltante', texto: 'Con faltante' },
  { valor: 'completa', texto: 'Completas' },
  { valor: 'cancelada', texto: 'Canceladas' },
] as const;

export default async function PickingPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PICKING);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const filas = await buscarOrdenes(await getDb(), u, { estado: filtro });

  return (
    <>
      <Encabezado titulo="Picking y empaque"
        descripcion="Órdenes de las notas de entrega, de las más urgentes a las menos. Solo ve los almacenes que tiene asignados." />
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/almacen/picking?estado=${f.valor}` : '/almacen/picking'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Orden', 'Nota de entrega', 'Cliente', 'Almacén', { t: 'Prioridad', derecha: true }, { t: 'Líneas', derecha: true }, 'Asignada a', 'Creada', 'Estado']}
          vacio="No hay órdenes de picking con ese filtro.">
          {filas.map((o) => {
            const e = etiquetaOrden(o.estado);
            return (
              <tr key={o.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/almacen/picking/${o.id}`} className="text-acento hover:underline">{o.numero}</Link></Celda>
                <Celda mono className="text-texto-2">{o.nota_numero}</Celda>
                <Celda>{o.cliente}</Celda>
                <Celda className="text-texto-2">{o.almacen}</Celda>
                <Celda derecha mono>{o.prioridad}</Celda>
                <Celda derecha mono>{o.lineas}</Celda>
                <Celda className="text-texto-2">{o.asignada_a ?? '—'}</Celda>
                <Celda className="text-texto-2">{o.creada}</Celda>
                <Celda><Etiqueta tono={e.tono}>{e.texto}</Etiqueta></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>
    </>
  );
}
