import { Fragment } from 'react';
import { Aviso, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { LINEAS_POR_FOLIO, ROLES_VEN_LIBROS, libroDiario, type LibroDiario } from '@/lib/contabilidad/libros';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const bs = (d: { toFixed: (n: number) => string }) => monto(d.toFixed(2));

export default async function LibroDiarioPage({ searchParams }: { searchParams: Promise<{ desde?: string; hasta?: string; lineas?: string; folio?: string }> }) {
  await exigirRol(...ROLES_VEN_LIBROS);
  const sp = await searchParams;
  const hoy = hoyCaracas();
  const desde = sp.desde && FECHA.test(sp.desde) ? sp.desde : `${hoy.slice(0, 7)}-01`;
  const hasta = sp.hasta && FECHA.test(sp.hasta) ? sp.hasta : hoy;
  const lineas = Number(sp.lineas) || LINEAS_POR_FOLIO;
  const folio = Number(sp.folio) || 1;

  let libro: LibroDiario | null = null;
  let error: string | null = null;
  try {
    libro = await libroDiario(await getDb(), desde, hasta, { lineasPorFolio: lineas, folioInicial: folio });
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <>
      <Encabezado titulo="Libro diario" descripcion={`Asientos contabilizados del ${fecha(desde)} al ${fecha(hasta)}, en bolívares (legal), por número de asiento y repartidos en folios.`}>
        <form className="flex flex-wrap items-end gap-2 text-sm print:hidden">
          <input type="date" name="desde" defaultValue={desde} className="campo w-auto" aria-label="Desde" />
          <input type="date" name="hasta" defaultValue={hasta} className="campo w-auto" aria-label="Hasta" />
          <label className="flex items-center gap-1 text-texto-2">Líneas por folio <input type="number" name="lineas" min={5} max={200} defaultValue={lineas} className="campo w-20" /></label>
          <label className="flex items-center gap-1 text-texto-2">Folio inicial <input type="number" name="folio" min={1} defaultValue={folio} className="campo w-24" /></label>
          <button className="rounded-lg bg-acento px-3 py-2 font-semibold text-white">Ver</button>
        </form>
      </Encabezado>
      {error && <Aviso tono="advertencia">{error}</Aviso>}
      {libro && (
        <>
          <div className="mb-5">
            {libro.cuadra
              ? <Aviso tono="exito">{libro.asientos} asientos en {libro.folios.length} folios. Cuadra: debe Bs {bs(libro.debe)} = haber Bs {bs(libro.haber)}.</Aviso>
              : <Aviso tono="peligro">No cuadra: debe Bs {bs(libro.debe)} ≠ haber Bs {bs(libro.haber)}. Es una alerta de integridad.</Aviso>}
          </div>
          <Panel>
            <Tabla columnas={['Folio', 'Fecha', 'Asiento N°', 'Código', 'Cuenta y detalle', { t: 'Debe (Bs)', derecha: true }, { t: 'Haber (Bs)', derecha: true }]} vacio="Sin asientos contabilizados en el rango.">
              {libro.folios.map((f) => (
                <Fragment key={f.folio}>
                  {f.asientos.map((a, i) => (
                    <Fragment key={a.id}>
                      <tr className={`bg-white/[0.03] font-semibold ${i === 0 ? 'print:break-before-page' : ''}`}>
                        <Celda mono>{i === 0 ? f.folio : ''}</Celda>
                        <Celda>{fecha(a.fecha)}</Celda>
                        <Celda mono>{a.numero}</Celda>
                        <Celda>{''}</Celda>
                        <Celda>{a.descripcion} <span className="font-normal text-texto-2">({a.tipo})</span></Celda>
                        <Celda derecha>{''}</Celda>
                        <Celda derecha>{''}</Celda>
                      </tr>
                      {a.lineas.map((l, j) => (
                        <tr key={j}>
                          <Celda>{''}</Celda><Celda>{''}</Celda><Celda>{''}</Celda>
                          <Celda mono>{l.codigo}</Celda>
                          <Celda className={l.haber.isZero() ? '' : 'pl-8'}>{l.cuenta}{l.glosa ? <span className="text-texto-2"> · {l.glosa}</span> : null}</Celda>
                          <Celda derecha>{l.debe.isZero() ? '' : bs(l.debe)}</Celda>
                          <Celda derecha>{l.haber.isZero() ? '' : bs(l.haber)}</Celda>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr className="border-t border-borde font-semibold">
                    <Celda mono>{f.folio}</Celda><Celda>{''}</Celda><Celda>{''}</Celda><Celda>{''}</Celda>
                    <Celda>Total del folio {f.folio}</Celda>
                    <Celda derecha>{bs(f.debe)}</Celda><Celda derecha>{bs(f.haber)}</Celda>
                  </tr>
                  <tr className="text-texto-2">
                    <Celda>{''}</Celda><Celda>{''}</Celda><Celda>{''}</Celda><Celda>{''}</Celda>
                    <Celda>Pasa al folio siguiente (acumulado)</Celda>
                    <Celda derecha>{bs(f.debeAcumulado)}</Celda><Celda derecha>{bs(f.haberAcumulado)}</Celda>
                  </tr>
                </Fragment>
              ))}
            </Tabla>
          </Panel>
        </>
      )}
    </>
  );
}
