import { Aviso, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_VEN_LIBROS, cuentasDelLibro, libroMayor, type LibroMayor } from '@/lib/contabilidad/libros';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const bs = (d: { toFixed: (n: number) => string }) => monto(d.toFixed(2));

export default async function LibroMayorPage({ searchParams }: { searchParams: Promise<{ cuenta?: string; desde?: string; hasta?: string }> }) {
  await exigirRol(...ROLES_VEN_LIBROS);
  const sp = await searchParams;
  const hoy = hoyCaracas();
  const desde = sp.desde && FECHA.test(sp.desde) ? sp.desde : `${hoy.slice(0, 4)}-01-01`;
  const hasta = sp.hasta && FECHA.test(sp.hasta) ? sp.hasta : hoy;
  const db = await getDb();
  const cuentas = await cuentasDelLibro(db);

  let libro: LibroMayor | null = null;
  let error: string | null = null;
  if (sp.cuenta) {
    try {
      libro = await libroMayor(db, sp.cuenta, desde, hasta);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  return (
    <>
      <Encabezado titulo="Libro mayor" descripcion="Los movimientos de una cuenta (y de sus subcuentas) en bolívares, con saldo inicial y saldo después de cada línea.">
        <form className="flex flex-wrap items-end gap-2 text-sm print:hidden">
          <select name="cuenta" defaultValue={sp.cuenta ?? ''} className="campo w-80" aria-label="Cuenta">
            <option value="">Seleccione una cuenta…</option>
            {cuentas.map((c) => <option key={c.codigo} value={c.codigo}>{c.codigo} · {c.nombre}</option>)}
          </select>
          <input type="date" name="desde" defaultValue={desde} className="campo w-auto" aria-label="Desde" />
          <input type="date" name="hasta" defaultValue={hasta} className="campo w-auto" aria-label="Hasta" />
          <button className="rounded-lg bg-acento px-3 py-2 font-semibold text-white">Ver</button>
        </form>
      </Encabezado>
      {error && <Aviso tono="advertencia">{error}</Aviso>}
      {!sp.cuenta && <Aviso>Seleccione una cuenta para ver su mayor.</Aviso>}
      {libro && (
        <Panel titulo={`${libro.cuenta.codigo} · ${libro.cuenta.nombre} — del ${fecha(desde)} al ${fecha(hasta)}`}>
          <p className="mb-3 text-xs text-texto-2">
            Cuenta de naturaleza {libro.cuenta.naturaleza === 'D' ? 'deudora' : 'acreedora'}{libro.subcuentas > 1 ? `; suma ${libro.subcuentas} subcuentas` : ''}. Montos en bolívares (Bs).
          </p>
          <Tabla columnas={['Fecha', 'Asiento N°', 'Cuenta', 'Descripción', { t: 'Debe (Bs)', derecha: true }, { t: 'Haber (Bs)', derecha: true }, { t: 'Saldo (Bs)', derecha: true }]}
            vacio="Sin movimientos en el rango.">
            <tr className="bg-white/[0.03] font-semibold">
              <Celda>{fecha(desde)}</Celda><Celda>{''}</Celda><Celda>{''}</Celda><Celda>Saldo inicial</Celda><Celda derecha>{''}</Celda><Celda derecha>{''}</Celda>
              <Celda derecha>{bs(libro.saldoInicial)}</Celda>
            </tr>
            {libro.movimientos.map((m, i) => (
              <tr key={i}>
                <Celda>{fecha(m.fecha)}</Celda>
                <Celda mono>{m.asiento}</Celda>
                <Celda mono>{m.codigo}</Celda>
                <Celda>{m.descripcion}{m.glosa ? <span className="text-texto-2"> · {m.glosa}</span> : null}</Celda>
                <Celda derecha>{m.debe.isZero() ? '' : bs(m.debe)}</Celda>
                <Celda derecha>{m.haber.isZero() ? '' : bs(m.haber)}</Celda>
                <Celda derecha>{bs(m.saldo)}</Celda>
              </tr>
            ))}
            <tr className="border-t border-borde font-semibold">
              <Celda>{''}</Celda><Celda>{''}</Celda><Celda>{''}</Celda><Celda>Totales y saldo final</Celda>
              <Celda derecha>{bs(libro.debe)}</Celda><Celda derecha>{bs(libro.haber)}</Celda><Celda derecha>{bs(libro.saldoFinal)}</Celda>
            </tr>
          </Tabla>
        </Panel>
      )}
    </>
  );
}
