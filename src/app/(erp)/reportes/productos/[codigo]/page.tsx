import { notFound } from 'next/navigation';
import { FiltroAnioProducto } from '@/components/reportes/filtro-anio-producto';
import { FiltroComparativaProducto } from '@/components/reportes/filtro-comparativa-producto';
import { PanelComparativaProducto } from '@/components/reportes/panel-comparativa-producto';
import { PanelDetalleProducto } from '@/components/reportes/panel-detalle-producto';
import { Pestanas } from '@/components/reportes/pestanas';
import { TablaKardex } from '@/components/reportes/tabla-kardex';
import { TablaStockAlmacen } from '@/components/reportes/tabla-stock-almacen';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas } from '@/lib/formato';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { comparativaMultianual, detalleProductoAnio, kardexProducto, stockPorAlmacen } from '@/lib/reportes/productos';

type Busqueda = { tab?: string; anios?: string | string[]; anioA?: string; anioB?: string };

export default async function ReporteProductoPage({ params, searchParams }: {
  params: Promise<{ codigo: string }>; searchParams: Promise<Busqueda>;
}) {
  await exigirRol(...ROLES_VEN_PRODUCTOS);
  const db = await getDb();
  const { codigo } = await params;
  const q = await searchParams;
  const tab = q.tab === 'almacenes' ? 'almacenes' : q.tab === 'movimientos' ? 'movimientos' : q.tab === 'comparativa' ? 'comparativa' : 'general';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const base = `/reportes/productos/${codigo}`;

  const [anios_, d] = await Promise.all([aniosDisponibles(db), detalleProductoAnio(db, codigo, anios)]);
  if (!d) notFound();

  const anioActual = Number(hoyCaracas().slice(0, 4));
  const anioMasReciente = anios_[0] ?? anioActual;
  const anioB = Number.isInteger(Number(q.anioB)) && anios_.includes(Number(q.anioB)) ? Number(q.anioB) : anioMasReciente;
  const anioA = Number.isInteger(Number(q.anioA)) && anios_.includes(Number(q.anioA)) ? Number(q.anioA) : anioB - 1;
  const aniosParaComparar = anios_.includes(anioA) || anios_.includes(anioB) ? anios_ : [...anios_, anioA, anioB].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => b - a);

  const pestanas = [
    { tab: 'general', label: 'Vista general / anual', href: `${base}?tab=general` },
    { tab: 'almacenes', label: 'Stock por almacén', href: `${base}?tab=almacenes` },
    { tab: 'movimientos', label: 'Movimientos (kardex)', href: `${base}?tab=movimientos` },
    { tab: 'comparativa', label: 'Comparativa multianual', href: `${base}?tab=comparativa` },
  ];

  return (
    <>
      <Encabezado titulo={d.producto.descripcion} descripcion={`${d.producto.codigo} · ${d.producto.grupo ?? '—'} / ${d.producto.marca ?? '—'}`} />
      <Pestanas activa={tab} items={pestanas} />
      {tab === 'almacenes' ? (
        <Panel><TablaStockAlmacen filas={await stockPorAlmacen(db, d.producto.id)} /></Panel>
      ) : tab === 'movimientos' ? (
        <Panel><TablaKardex filas={await kardexProducto(db, d.producto.id)} /></Panel>
      ) : tab === 'comparativa' ? (
        <>
          <FiltroComparativaProducto anios={aniosParaComparar} anioA={anioA} anioB={anioB} />
          <PanelComparativaProducto c={await comparativaMultianual(db, d.producto.id, anioA, anioB)} />
        </>
      ) : (
        <>
          <FiltroAnioProducto anios={anios_} aniosSeleccionados={anios} />
          <PanelDetalleProducto d={d} />
        </>
      )}
    </>
  );
}
