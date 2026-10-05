import { notFound } from 'next/navigation';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { PROVEEDOR_SIMULADO } from '@/lib/fiscal/imprenta';
import { monto, tasa } from '@/lib/formato';
import { verTodosLosDocumentos } from '@/lib/ventas/pedidos';
import { ROLES_VEN_FACTURAS, detalleFactura } from '@/lib/ventas/facturas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Vista para imprimir con los campos que exige una factura (§11.1): denominación, número y de control, emisor y adquirente
 * con su RIF, fecha y hora, descripción, base e IVA por alícuota, IGTF por separado y datos de la imprenta.
 * Mientras el número de control sea del simulador, la hoja se marca como PRUEBA y no sirve como factura.
 */
export default async function ImprimirFacturaPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_FACTURAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const f = await detalleFactura(await getDb(), id);
  if (!f) notFound();
  if (!verTodosLosDocumentos(u) && f.vendedor_usuario !== u.id) notFound();
  const prueba = f.imprenta === PROVEEDOR_SIMULADO;

  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-sm text-black print:p-0">
      {(prueba || f.estado === 'anulado' || f.contingencia) && (
        <p className="mb-4 rounded border-2 border-red-600 p-2 text-center text-base font-bold text-red-700">
          {f.estado === 'anulado' ? 'FACTURA ANULADA' : prueba ? 'DOCUMENTO DE PRUEBA: SIN VALIDEZ FISCAL' : 'EN CONTINGENCIA: SIN NÚMERO DE CONTROL'}
        </p>
      )}
      <header className="flex justify-between gap-6 border-b border-black pb-3">
        <div>
          <p className="text-base font-bold">{f.empresa_razon ?? '—'}</p>
          <p>RIF: {f.empresa_rif ?? '—'}</p>
          <p>{f.empresa_domicilio ?? ''}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold">FACTURA</p>
          <p>N.º {f.serie}-{f.numero}</p>
          <p>N.º de control: {f.numero_control ?? 'pendiente'}</p>
          <p>Fecha y hora: {f.fecha}</p>
        </div>
      </header>

      <section className="my-3 border-b border-black pb-3">
        <p className="font-semibold">Adquirente</p>
        <p>{f.cliente}</p>
        <p>RIF: {f.cliente_rif}</p>
        {f.cliente_direccion && <p>{f.cliente_direccion}</p>}
        {f.cliente_telefono && <p>Teléfono: {f.cliente_telefono}</p>}
        <p>Condición de pago: {f.condicion_pago ?? '—'} · Vence: {f.vencimiento ?? '—'}</p>
      </section>

      <table className="w-full">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="py-1">Código</th><th>Descripción</th><th className="text-right">Cant.</th>
            <th className="text-right">Precio Bs.</th><th className="text-right">Desc. %</th><th className="text-right">IVA %</th><th className="text-right">Total Bs.</th>
          </tr>
        </thead>
        <tbody>
          {f.lineas.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="py-0.5 font-mono">{l.codigo}</td><td>{l.descripcion}</td>
              <td className="text-right">{Number(l.cantidad)}</td><td className="text-right">{monto(l.precio_unitario)}</td>
              <td className="text-right">{Number(l.descuento_pct)}</td><td className="text-right">{Number(l.alicuota_pct)}</td>
              <td className="text-right">{monto(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-x-4 gap-y-0.5 border-t border-black pt-2">
        <dt>Subtotal</dt><dd className="text-right">{monto(f.subtotal)}</dd>
        <dt>Descuento</dt><dd className="text-right">{monto(f.descuento)}</dd>
        {f.desglose.map((d) => (
          <div key={d.alicuota_pct} className="col-span-2 grid grid-cols-2">
            <dt>{Number(d.alicuota_pct) > 0 ? `Base imponible ${Number(d.alicuota_pct)} %` : 'Exento'}</dt><dd className="text-right">{monto(d.base)}</dd>
          </div>
        ))}
        <dt>IVA</dt><dd className="text-right">{monto(f.iva)}</dd>
        <dt>IGTF</dt><dd className="text-right">{monto(f.igtf)}</dd>
        <dt className="font-bold">Total Bs.</dt><dd className="text-right font-bold">{monto(f.total)}</dd>
      </dl>

      <footer className="mt-6 border-t border-black pt-2 text-xs">
        <p>Equivalente en US$ {monto(f.total_usd)} a la tasa BCV de {tasa(f.tasa)} Bs. por US$.</p>
        <p>Imprenta digital: {f.imprenta ?? 'pendiente de asignar'}.</p>
      </footer>
    </div>
  );
}
