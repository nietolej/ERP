import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_IMPUESTO, ROLES_VEN_COMPROBANTES, detalleComprobante } from '@/lib/fiscal/comprobantes';
import { monto } from '@/lib/formato';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ComprobantePage({ params }: { params: Promise<{ id: string }> }) {
  await exigirRol(...ROLES_VEN_COMPROBANTES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const c = await detalleComprobante(await getDb(), id);
  if (!c) notFound();
  const iva = c.impuesto === 'iva';
  const aaaa = c.periodo.slice(0, 4);
  const mm = c.periodo.slice(4);

  return (
    <>
      <Encabezado titulo={`Comprobante de retención de ${NOMBRE_IMPUESTO[c.impuesto]} N° ${c.numero}`} descripcion={`Periodo fiscal ${mm}/${aaaa}`}>
        <Link href={`/fiscal/comprobantes?periodo=${aaaa}-${mm}`} className="text-sm text-texto-2 hover:text-texto print:hidden">← Comprobantes</Link>
      </Encabezado>
      <Panel titulo="Agente de retención">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Razón social</dt><dd>{c.agente_razon}</dd></div>
          <div><dt className="text-texto-2">RIF</dt><dd className="font-mono">{c.agente_rif}</dd></div>
          <div><dt className="text-texto-2">Domicilio fiscal</dt><dd>{c.agente_domicilio ?? '—'}</dd></div>
        </dl>
      </Panel>
      <Panel titulo="Sujeto retenido" className="mt-5">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Razón social</dt><dd>{c.proveedor}</dd></div>
          <div><dt className="text-texto-2">RIF</dt><dd className="font-mono">{c.rif}</dd></div>
          <div><dt className="text-texto-2">Domicilio fiscal</dt><dd>{c.sujeto_direccion ?? '—'}</dd></div>
        </dl>
      </Panel>
      <Panel titulo="Operación retenida" className="mt-5">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">N° de comprobante</dt><dd className="font-mono">{c.numero}</dd></div>
          <div><dt className="text-texto-2">Fecha de emisión</dt><dd>{c.fecha_emision}</dd></div>
          <div><dt className="text-texto-2">Fecha de la retención</dt><dd>{c.fecha_retencion}</dd></div>
          <div><dt className="text-texto-2">Factura</dt><dd className="font-mono">{c.documento}</dd></div>
          <div><dt className="text-texto-2">N° de control</dt><dd className="font-mono">{c.numero_control ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Fecha de la factura</dt><dd>{c.fecha_documento}</dd></div>
          {!iva && <div className="md:col-span-3"><dt className="text-texto-2">Concepto de ISLR</dt><dd>{c.concepto ?? '—'}</dd></div>}
        </dl>
        <dl className="mt-4 ml-auto grid max-w-sm grid-cols-2 gap-y-1 text-sm">
          {iva && <><dt className="text-texto-2">IVA de la factura</dt><dd className="text-right font-mono">{c.moneda} {monto(c.iva_documento ?? c.base)}</dd></>}
          <dt className="text-texto-2">{iva ? 'Base de la retención (IVA)' : 'Base de la retención (sin IVA)'}</dt><dd className="text-right font-mono">{c.moneda} {monto(c.base)}</dd>
          <dt className="text-texto-2">{iva ? `Retención ${c.iva_total ? '(100 %)' : ''}` : 'Porcentaje'}</dt><dd className="text-right font-mono">{Number(c.porcentaje)} %</dd>
          {!iva && <><dt className="text-texto-2">Sustraendo</dt><dd className="text-right font-mono">{c.moneda} {monto(c.sustraendo)}</dd></>}
          <dt className="font-semibold">Impuesto retenido</dt><dd className="text-right font-mono font-semibold">{c.moneda} {monto(c.monto)}</dd>
          {c.moneda !== 'VES' && <><dt className="text-texto-2">Tasa de la factura</dt><dd className="text-right font-mono">{c.tasa}</dd></>}
        </dl>
        <p className="mt-4 text-xs text-texto-2">Emitido por {c.emitido_por}. Para imprimir use la opción de imprimir del navegador.</p>
      </Panel>
    </>
  );
}
