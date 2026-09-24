import { Aviso, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export default async function BalancePage({ searchParams }: { searchParams: Promise<{ desde?: string; hasta?: string; moneda?: string }> }) {
  await exigirRol('contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor');
  const sp = await searchParams;
  const hoy = hoyCaracas();
  const desde = sp.desde && FECHA.test(sp.desde) ? sp.desde : `${hoy.slice(0, 4)}-01-01`;
  const hasta = sp.hasta && FECHA.test(sp.hasta) ? sp.hasta : hoy;
  const usd = sp.moneda === 'USD';
  const db = await getDb();

  const { rows } = await db.query<{ codigo: string; nombre: string; debe: string; haber: string; saldo: string }>(
    `select c.codigo, c.nombre,
            sum(${usd ? 'l.debe_usd' : 'l.debe_ves'}) as debe,
            sum(${usd ? 'l.haber_usd' : 'l.haber_ves'}) as haber,
            sum(${usd ? 'l.debe_usd - l.haber_usd' : 'l.debe_ves - l.haber_ves'}) as saldo
       from asiento_linea l
       join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
       join cuenta_contable c on c.id = l.cuenta_id
      where a.fecha between $1 and $2
      group by c.codigo, c.nombre
      order by string_to_array(c.codigo, '.')::int[]`,
    [desde, hasta]);
  const tot = (await db.query<{ debe: string; haber: string }>(
    `select coalesce(sum(${usd ? 'l.debe_usd' : 'l.debe_ves'}), 0) as debe, coalesce(sum(${usd ? 'l.haber_usd' : 'l.haber_ves'}), 0) as haber
       from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
      where a.fecha between $1 and $2`, [desde, hasta])).rows[0];
  const simbolo = usd ? '$' : 'Bs ';

  return (
    <>
      <Encabezado titulo="Balance de comprobación" descripcion={`Asientos contabilizados del ${fecha(desde)} al ${fecha(hasta)}, en ${usd ? 'USD (gestión)' : 'VES (legal)'}.`}>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <input type="date" name="desde" defaultValue={desde} className="campo w-auto" />
          <input type="date" name="hasta" defaultValue={hasta} className="campo w-auto" />
          <select name="moneda" defaultValue={usd ? 'USD' : 'VES'} className="campo w-auto">
            <option value="VES">VES</option><option value="USD">USD</option>
          </select>
          <button className="rounded-lg bg-acento px-3 py-2 font-semibold text-white">Ver</button>
        </form>
      </Encabezado>
      <div className="mb-5">
        {tot.debe === tot.haber
          ? <Aviso tono="exito">Cuadra: debe {monto(tot.debe, simbolo)} = haber {monto(tot.haber, simbolo)}.</Aviso>
          : <Aviso tono="peligro">No cuadra: debe {monto(tot.debe, simbolo)} ≠ haber {monto(tot.haber, simbolo)}. Es una alerta de integridad.</Aviso>}
      </div>
      <Panel>
        <Tabla columnas={['Código', 'Cuenta', { t: 'Debe', derecha: true }, { t: 'Haber', derecha: true }, { t: 'Saldo', derecha: true }]}
          vacio="Sin asientos contabilizados en el período.">
          {rows.map((r) => (
            <tr key={r.codigo}>
              <Celda mono>{r.codigo}</Celda>
              <Celda>{r.nombre}</Celda>
              <Celda derecha>{monto(r.debe)}</Celda>
              <Celda derecha>{monto(r.haber)}</Celda>
              <Celda derecha className={r.saldo.startsWith('-') ? 'text-amber-300' : ''}>{monto(r.saldo)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
