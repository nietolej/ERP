import { Celda, Encabezado, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_LIBROS, libroCompras } from '@/lib/fiscal/libros';
import { fecha, monto } from '@/lib/formato';
import { leerPeriodo } from '../periodo';

const NOMBRE_ORIGEN: Record<string, string> = { factura: 'Factura de compra', gasto_importacion: 'Gasto de importación', gasto: 'Factura de gasto' };
const NOMBRE_TIPO: Record<string, string> = { nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito' };
const NOMBRE_LIBRO: Record<string, string> = { gravada: 'Gravada', exenta: 'Exenta', exonerada: 'Exonerada', no_sujeta: 'No sujeta' };

export default async function LibroComprasPage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  await exigirRol(...ROLES_VEN_LIBROS);
  const { periodo } = await searchParams;
  const p = leerPeriodo(periodo);
  const l = await libroCompras(await getDb(), p.anio, p.mes);

  return (
    <>
      <Encabezado titulo="Libro de compras"
        descripcion="Facturas de mercancía, gastos de importación, facturas de gasto y notas del proveedor del mes, por alícuota y en bolívares. Las notas de crédito restan. El crédito fiscal excluye el IVA de los gastos sin derecho a él." />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={p.texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
      </Panel>

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <KpiCard titulo="Base imponible y exenta (Bs.)" valor={monto(l.base)} />
        <KpiCard titulo="Crédito fiscal (Bs.)" valor={monto(l.credito)} />
        <KpiCard titulo="IVA retenido (Bs.)" valor={monto(l.retencionIva)} />
        <KpiCard titulo="ISLR retenido (Bs.)" valor={monto(l.retencionIslr)} />
      </div>

      <Panel titulo="Resumen por alícuota" className="mb-5">
        <Tabla columnas={['Alícuota', 'Tipo', { t: 'Base (Bs.)', derecha: true }, { t: 'IVA (Bs.)', derecha: true }, { t: 'Crédito fiscal (Bs.)', derecha: true }]} vacio="Sin documentos en este mes.">
          {l.resumen.map((r) => (
            <tr key={`${r.alicuota_pct}${r.tipo_libro}`}>
              <Celda mono>{Number(r.alicuota_pct)} %</Celda>
              <Celda>{NOMBRE_LIBRO[r.tipo_libro] ?? r.tipo_libro}</Celda>
              <Celda derecha mono>{monto(r.base)}</Celda>
              <Celda derecha mono>{monto(r.iva)}</Celda>
              <Celda derecha mono>{monto(r.credito ?? '0')}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Panel titulo="Detalle del libro">
        <Tabla columnas={['Fecha', 'Documento', 'N° de control', 'Afecta a', 'RIF', 'Proveedor', { t: 'Alícuota', derecha: true }, { t: 'Base (Bs.)', derecha: true }, { t: 'IVA (Bs.)', derecha: true },
          { t: 'Crédito fiscal (Bs.)', derecha: true }, { t: 'IVA retenido (Bs.)', derecha: true }, { t: 'ISLR retenido (Bs.)', derecha: true }]} vacio="Sin documentos en este mes.">
          {l.filas.map((f, i) => (
            <tr key={`${f.documento_id}-${f.alicuota_pct}-${i}`}>
              <Celda className="text-texto-2">{fecha(f.fecha)}</Celda>
              <Celda mono>{NOMBRE_TIPO[f.tipo] ?? NOMBRE_ORIGEN[f.origen] ?? f.origen} {f.numero_documento}</Celda>
              <Celda mono>{f.numero_control}</Celda>
              <Celda mono className="text-texto-2">{f.documento_afectado ?? ''}</Celda>
              <Celda mono>{f.rif}</Celda>
              <Celda>{f.razon_social}</Celda>
              <Celda derecha mono>{Number(f.alicuota_pct)} %</Celda>
              <Celda derecha mono>{monto(f.base_ves)}</Celda>
              <Celda derecha mono>{monto(f.iva_ves)}</Celda>
              <Celda derecha mono>{monto(f.credito_ves)}</Celda>
              <Celda derecha mono>{monto(f.retencion_iva_ves)}</Celda>
              <Celda derecha mono>{monto(f.retencion_islr_ves)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
