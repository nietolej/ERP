import { notFound } from 'next/navigation';
import { FiltroAnioProducto } from '@/components/reportes/filtro-anio-producto';
import { PanelDetalleProducto } from '@/components/reportes/panel-detalle-producto';
import { Pestanas } from '@/components/reportes/pestanas';
import { TablaStockAlmacen } from '@/components/reportes/tabla-stock-almacen';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { detalleProductoAnio, stockPorAlmacen } from '@/lib/reportes/productos';

type Busqueda = { tab?: string; anios?: string | string[] };

export default async function ReporteProductoPage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  await exigirRol(...ROLES_VEN_PRODUCTOS);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const tab = q.tab === 'almacenes' ? 'almacenes' : 'general';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const base = `/reportes/productos/${codigo}`;

  const [anios_, d] = await Promise.all([aniosDisponibles(db), detalleProductoAnio(db, codigo, anios)]);
  if (!d) notFound();

  const pestanas = [
    { tab: 'general', label: 'Vista general / anual', href: `${base}?tab=general` },
    { tab: 'almacenes', label: 'Stock por almacén', href: `${base}?tab=almacenes` },
  ];

  return (
    <>
      <Encabezado titulo={d.producto.descripcion} descripcion={`${d.producto.codigo} · ${d.producto.grupo ?? '—'} / ${d.producto.marca ?? '—'}`} />
      <Pestanas activa={tab} items={pestanas} />
      {tab === 'almacenes' ? (
        <Panel><TablaStockAlmacen filas={await stockPorAlmacen(db, d.producto.id)} /></Panel>
      ) : (
        <>
          <FiltroAnioProducto anios={anios_} aniosSeleccionados={anios} />
          <PanelDetalleProducto d={d} />
        </>
      )}
    </>
  );
}
