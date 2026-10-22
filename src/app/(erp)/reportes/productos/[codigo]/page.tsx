import { notFound } from 'next/navigation';
import { FiltroAnioProducto } from '@/components/reportes/filtro-anio-producto';
import { PanelDetalleProducto } from '@/components/reportes/panel-detalle-producto';
import { Encabezado } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { detalleProductoAnio } from '@/lib/reportes/productos';

type Busqueda = { anios?: string | string[] };

export default async function ReporteProductoPage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  await exigirRol(...ROLES_VEN_PRODUCTOS);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));

  const [anios_, d] = await Promise.all([aniosDisponibles(db), detalleProductoAnio(db, codigo, anios)]);
  if (!d) notFound();

  return (
    <>
      <Encabezado titulo={d.producto.descripcion} descripcion={`${d.producto.codigo} · ${d.producto.grupo ?? '—'} / ${d.producto.marca ?? '—'}`} />
      <FiltroAnioProducto anios={anios_} aniosSeleccionados={anios} />
      <PanelDetalleProducto d={d} />
    </>
  );
}
