import { Aviso, Celda, Encabezado, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_LIBROS, libroVentas } from '@/lib/fiscal/libros';
import { fecha, monto } from '@/lib/formato';
import { leerPeriodo } from '../periodo';

const NOMBRE_TIPO = { factura: 'Factura', nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito' } as const;
const NOMBRE_LIBRO: Record<string, string> = { gravada: 'Gravada', exenta: 'Exenta', exonerada: 'Exonerada', no_sujeta: 'No sujeta' };

export default async function LibroVentasPage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  await exigirRol(...ROLES_VEN_LIBROS);
  const { periodo } = await searchParams;
  const p = leerPeriodo(periodo);
  const l = await libroVentas(await getDb(), p.anio, p.mes);

  return (
    <>
      <Encabezado titulo="Libro de ventas"
        descripcion="Facturas, notas de crédito (restan) y de débito emitidas en el mes, por alícuota y en bolívares. Las anuladas se muestran marcadas y no suman. El IGTF no entra en este libro." />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={p.texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
      </Panel>

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <KpiCard titulo="Base imponible y exenta (Bs.)" valor={monto(l.base)} />
        <KpiCard titulo="Débito fiscal (Bs.)" valor={monto(l.debito)} />
        <KpiCard titulo="Documentos" valor={String(new Set(l.filas.map((f) => f.numero_documento + f.tipo)).size)} />
      </div>

      <Panel titulo="Resumen por alícuota" className="mb-5">
        <Tabla columnas={['Alícuota', 'Tipo', { t: 'Base (Bs.)', derecha: true }, { t: 'IVA (Bs.)', derecha: true }]} vacio="Sin documentos en este mes.">
          {l.resumen.map((r) => (
            <tr key={`${r.alicuota_pct}${r.tipo_libro}`}>
              <Celda mono>{Number(r.alicuota_pct)} %</Celda>
              <Celda>{NOMBRE_LIBRO[r.tipo_libro] ?? r.tipo_libro}</Celda>
              <Celda derecha mono>{monto(r.base)}</Celda>
              <Celda derecha mono>{monto(r.iva)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <Panel titulo="Detalle del libro">
        {l.filas.some((f) => f.contingencia) && <div className="mb-3"><Aviso tono="advertencia">Hay documentos en contingencia (sin número de control todavía).</Aviso></div>}
        <Tabla columnas={['Fecha', 'Documento', 'N° de control', 'Afecta a', 'RIF', 'Cliente', { t: 'Alícuota', derecha: true }, { t: 'Base (Bs.)', derecha: true }, { t: 'IVA (Bs.)', derecha: true }, 'Situación']}
          vacio="Sin documentos en este mes.">
          {l.filas.map((f, i) => (
            <tr key={`${f.numero_documento}-${f.tipo}-${f.alicuota_pct}-${i}`} className={f.incluido ? '' : 'opacity-60'}>
              <Celda className="text-texto-2">{fecha(f.fecha)}</Celda>
              <Celda mono>{NOMBRE_TIPO[f.tipo as keyof typeof NOMBRE_TIPO] ?? f.tipo} {f.numero_documento}</Celda>
              <Celda mono>{f.numero_control ?? '—'}</Celda>
              <Celda mono className="text-texto-2">{f.documento_afectado ?? ''}</Celda>
              <Celda mono>{f.rif}</Celda>
              <Celda>{f.razon_social}</Celda>
              <Celda derecha mono>{Number(f.alicuota_pct)} %</Celda>
              <Celda derecha mono>{monto(f.base_ves)}</Celda>
              <Celda derecha mono>{monto(f.iva_ves)}</Celda>
              <Celda>{f.incluido ? (f.contingencia ? <Etiqueta tono="advertencia">contingencia</Etiqueta> : 'Emitido') : <Etiqueta tono="peligro">ANULADA {f.fecha_anulacion ? fecha(f.fecha_anulacion) : ''}</Etiqueta>}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
