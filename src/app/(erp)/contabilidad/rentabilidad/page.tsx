import Link from 'next/link';
import { Aviso, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import {
  DIMENSIONES, NOMBRE_DIMENSION, ROLES_VEN_RENTABILIDAD, rentabilidadPor, rentabilidadTotal, type Cifras, type Dimension, type FilaRentabilidad,
} from '@/lib/contabilidad/rentabilidad';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const us = (d: { toFixed: (n: number) => string }) => monto(d.toFixed(2));
const pct = (c: Cifras) => (c.margenPct === null ? '—' : `${c.margenPct} %`);

export default async function RentabilidadPage({ searchParams }: { searchParams: Promise<{ dim?: string; desde?: string; hasta?: string }> }) {
  await exigirRol(...ROLES_VEN_RENTABILIDAD);
  const sp = await searchParams;
  const hoy = hoyCaracas();
  const desde = sp.desde && FECHA.test(sp.desde) ? sp.desde : `${hoy.slice(0, 4)}-01-01`;
  const hasta = sp.hasta && FECHA.test(sp.hasta) ? sp.hasta : hoy;
  const dim: Dimension = DIMENSIONES.includes(sp.dim as Dimension) ? (sp.dim as Dimension) : 'cliente';
  const db = await getDb();

  let filas: FilaRentabilidad[] = [];
  let total: Cifras | null = null;
  let error: string | null = null;
  try {
    [filas, total] = await Promise.all([rentabilidadPor(db, dim, desde, hasta), rentabilidadTotal(db, desde, hasta)]);
  } catch (e) {
    error = (e as Error).message;
  }
  const enlace = (d: Dimension) => `/contabilidad/rentabilidad?${new URLSearchParams({ dim: d, desde, hasta }).toString()}`;

  return (
    <>
      <Encabezado titulo="Rentabilidad por dimensión"
        descripcion={`Margen del ${fecha(desde)} al ${fecha(hasta)}, en dólares (gestión): venta neta de devoluciones y descuentos, menos el costo de cada línea al despachar. Las comisiones devengadas al cobrar también se restan.`}>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="dim" value={dim} />
          <input type="date" name="desde" defaultValue={desde} className="campo w-auto" aria-label="Desde" />
          <input type="date" name="hasta" defaultValue={hasta} className="campo w-auto" aria-label="Hasta" />
          <button className="rounded-lg bg-acento px-3 py-2 font-semibold text-white">Ver</button>
        </form>
      </Encabezado>
      <nav className="mb-5 flex flex-wrap gap-2 text-sm" aria-label="Dimensión">
        {DIMENSIONES.map((d) => (
          <Link key={d} href={enlace(d)} className={`rounded-full border px-3 py-1 ${d === dim ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{NOMBRE_DIMENSION[d]}</Link>
        ))}
      </nav>
      {error && <Aviso tono="advertencia">{error}</Aviso>}
      {total && (
        <Panel titulo={`Por ${NOMBRE_DIMENSION[dim].toLowerCase()}`}>
          <Tabla columnas={['Código', NOMBRE_DIMENSION[dim], { t: 'Venta (US$)', derecha: true }, { t: 'Desc. de línea (US$)', derecha: true }, { t: 'Devoluciones (US$)', derecha: true },
            { t: 'Desc. posteriores (US$)', derecha: true }, { t: 'Pronto pago (US$)', derecha: true }, { t: 'Venta neta (US$)', derecha: true }, { t: 'Costo (US$)', derecha: true },
            { t: 'Comisiones (US$)', derecha: true }, { t: 'Margen (US$)', derecha: true }, { t: 'Margen %', derecha: true }]} vacio="Sin facturas emitidas en el rango.">
            {filas.length === 0 ? null : <>{filas.map((f) => (
              <tr key={`${f.codigo}|${f.nombre}`}>
                <Celda mono>{f.codigo}</Celda>
                <Celda>{f.nombre}</Celda>
                <Celda derecha>{us(f.ventaUsd)}</Celda>
                <Celda derecha className="text-texto-2">{us(f.descuentoLineaUsd)}</Celda>
                <Celda derecha>{us(f.devolucionUsd)}</Celda>
                <Celda derecha>{us(f.descuentoPosteriorUsd)}</Celda>
                <Celda derecha>{us(f.prontoPagoUsd)}</Celda>
                <Celda derecha>{us(f.ventaNetaUsd)}</Celda>
                <Celda derecha>{us(f.costoUsd)}</Celda>
                <Celda derecha>{us(f.comisionUsd)}</Celda>
                <Celda derecha className={f.margenUsd.isNegative() ? 'text-red-300' : ''}>{us(f.margenUsd)}</Celda>
                <Celda derecha className={f.margenUsd.isNegative() ? 'text-red-300' : ''}>{pct(f)}</Celda>
              </tr>
            ))}
              <tr className="border-t border-borde font-semibold">
                <Celda>{''}</Celda><Celda>Total</Celda>
                <Celda derecha>{us(total.ventaUsd)}</Celda><Celda derecha>{us(total.descuentoLineaUsd)}</Celda><Celda derecha>{us(total.devolucionUsd)}</Celda>
                <Celda derecha>{us(total.descuentoPosteriorUsd)}</Celda><Celda derecha>{us(total.prontoPagoUsd)}</Celda><Celda derecha>{us(total.ventaNetaUsd)}</Celda>
                <Celda derecha>{us(total.costoUsd)}</Celda><Celda derecha>{us(total.comisionUsd)}</Celda><Celda derecha>{us(total.margenUsd)}</Celda><Celda derecha>{pct(total)}</Celda>
              </tr></>}
          </Tabla>
          <p className="mt-3 text-xs text-texto-2">
            La venta ya viene neta de los descuentos de línea (columna aparte, informativa). Venta neta = venta − devoluciones − descuentos posteriores − pronto pago. La devolución resta también el costo que reingresa al inventario. Las comisiones se imputan en la fecha del cobro que las devengó y se reparten entre las líneas de su factura.
          </p>
        </Panel>
      )}
    </>
  );
}
