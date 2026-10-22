import { notFound } from 'next/navigation';
import { Aviso, Encabezado, Panel } from '@/components/ui';
import { exigirSesion } from '@/lib/auth/dal';

/** Módulos de reportes (spec_reportes): se habilitan cuando existen los datos que los alimentan. */
const MODULOS: Record<string, { titulo: string; fase: number; contenido: string[] }> = {
  productos: {
    titulo: 'Productos (M2)', fase: 2,
    contenido: ['Catálogo de artículos', 'Análisis por grupos', 'Detalle anual con rotación', 'Comparativa multianual', 'Stock por almacén y kardex (Fase 3)'],
  },
  vendedores: {
    titulo: 'Vendedores (M3)', fase: 2,
    contenido: ['Catálogo con cobertura y concentración', 'Vista anual vs meta', 'Analítica estratégica y cartera dormida', 'Comparativa multianual', 'Cartera activa y productos vendidos'],
  },
  cobranzas: {
    titulo: 'Cobranzas (M4)', fase: 2,
    contenido: ['Resumen y velocidad de cobro', 'Antigüedad de saldos', 'Promedio por vendedor', 'Promedio por cliente', 'Bancos y canales'],
  },
  devoluciones: {
    titulo: 'Devoluciones (M5)', fase: 2,
    contenido: ['Resumen y tendencia mensual', 'Por cliente con nivel de riesgo', 'Por vendedor', 'Por producto con alerta de defecto'],
  },
  inventario: {
    titulo: 'Inventario (M6)', fase: 3,
    contenido: ['Velocidad ajustada y salud de stock', 'Sugerido de órdenes de compra', 'Salud por grupo', 'Valorización mensual'],
  },
};

export default async function ReporteModuloPage({ params }: { params: Promise<{ modulo: string }> }) {
  await exigirSesion();
  const { modulo } = await params;
  const m = MODULOS[modulo];
  if (!m) notFound();

  return (
    <>
      <Encabezado titulo={m.titulo} descripcion="Réplica del dashboard de ventas con los datos del ERP" />
      <Panel>
        <Aviso tono="info">
          Este módulo se habilita en la <strong>Fase {m.fase}</strong>, cuando el ERP tenga registradas las operaciones que lo alimentan.
          No se muestran cifras de ejemplo.
        </Aviso>
        <p className="mt-5 mb-2 text-sm font-semibold">Contenido previsto (docs/spec_reportes.md):</p>
        <ul className="list-inside list-disc space-y-1 text-sm text-texto-2">
          {m.contenido.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </Panel>
    </>
  );
}
