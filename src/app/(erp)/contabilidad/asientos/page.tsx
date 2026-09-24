import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { NOMBRE_TIPO } from './tipos';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE = 300;

export default async function AsientosPage({ searchParams }: { searchParams: Promise<{ desde?: string; hasta?: string; estado?: string }> }) {
  const u = await exigirRol('contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor');
  const sp = await searchParams;
  const hoy = hoyCaracas();
  const desde = sp.desde && FECHA.test(sp.desde) ? sp.desde : `${hoy.slice(0, 7)}-01`;
  const hasta = sp.hasta && FECHA.test(sp.hasta) ? sp.hasta : hoy;
  const estado = sp.estado === 'borrador' || sp.estado === 'contabilizado' ? sp.estado : '';
  const db = await getDb();

  const { rows: pendientes } = await db.query<{ n: number }>(
    `select count(*)::int as n from asiento where tipo = 'manual' and estado = 'borrador'`);

  // Los borradores se listan siempre (sin importar el rango de fechas) para que no queden olvidados.
  const { rows } = await db.query<{
    id: string; numero: string | null; fecha: string; tipo: string; descripcion: string; estado: string;
    creador: string; aprobador: string | null; total_ves: string; total_usd: string;
  }>(
    `select a.id, a.numero, a.fecha, a.tipo, a.descripcion, a.estado, uc.nombre as creador, ua.nombre as aprobador,
            coalesce(sum(l.debe_ves), 0) as total_ves, coalesce(sum(l.debe_usd), 0) as total_usd
       from asiento a
       join usuario uc on uc.id = a.created_by
       left join usuario ua on ua.id = a.aprobado_por
       left join asiento_linea l on l.asiento_id = a.id
      where ((a.fecha between $1 and $2) or a.estado = 'borrador')
        and ($3 = '' or a.estado = $3)
      group by a.id, uc.nombre, ua.nombre
      order by a.estado = 'borrador' desc, a.fecha desc, a.numero desc nulls first
      limit ${LIMITE + 1}`,
    [desde, hasta, estado]);
  const truncado = rows.length > LIMITE;

  return (
    <>
      <Encabezado titulo="Asientos contables" descripcion="Libro diario. Los asientos manuales se contabilizan con la aprobación del jefe de contabilidad.">
        <div className="flex flex-wrap items-end gap-2">
          <form className="flex flex-wrap items-end gap-2 text-sm">
            <input type="date" name="desde" defaultValue={desde} className="campo w-auto" aria-label="Desde" />
            <input type="date" name="hasta" defaultValue={hasta} className="campo w-auto" aria-label="Hasta" />
            <select name="estado" defaultValue={estado} className="campo w-auto" aria-label="Estado">
              <option value="">Todos</option>
              <option value="borrador">Borradores</option>
              <option value="contabilizado">Contabilizados</option>
            </select>
            <button className="rounded-lg border border-borde bg-white/5 px-3 py-2 font-semibold hover:bg-white/10">Ver</button>
          </form>
          {tieneRol(u, ['contabilidad']) && (
            <Link href="/contabilidad/asientos/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
              Nuevo asiento manual
            </Link>
          )}
        </div>
      </Encabezado>

      {pendientes[0].n > 0 && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            {pendientes[0].n === 1 ? 'Hay 1 asiento manual pendiente' : `Hay ${pendientes[0].n} asientos manuales pendientes`} de aprobación.
            {tieneRol(u, ['jefe_contabilidad']) && ' Ábralo para revisarlo y aprobarlo.'}
          </Aviso>
        </div>
      )}

      <Panel>
        <Tabla columnas={['N°', 'Fecha', 'Tipo', 'Descripción', { t: 'Total Bs', derecha: true }, { t: 'Total US$', derecha: true }, 'Estado', 'Registró', 'Aprobó']}
          vacio="No hay asientos en el rango indicado.">
          {rows.slice(0, LIMITE).map((a) => (
            <tr key={a.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/contabilidad/asientos/${a.id}`} className="text-acento hover:underline">{a.numero ?? 'borrador'}</Link></Celda>
              <Celda>{fecha(a.fecha)}</Celda>
              <Celda className="text-texto-2">{NOMBRE_TIPO[a.tipo] ?? a.tipo}</Celda>
              <Celda><Link href={`/contabilidad/asientos/${a.id}`} className="hover:underline">{a.descripcion}</Link></Celda>
              <Celda derecha>{monto(a.total_ves, 'Bs ')}</Celda>
              <Celda derecha>{monto(a.total_usd, '$')}</Celda>
              <Celda>{a.estado === 'contabilizado' ? <Etiqueta tono="exito">contabilizado</Etiqueta> : <Etiqueta tono="advertencia">borrador</Etiqueta>}</Celda>
              <Celda className="text-texto-2">{a.creador}</Celda>
              <Celda className="text-texto-2">{a.aprobador ?? '—'}</Celda>
            </tr>
          ))}
        </Tabla>
        {truncado && <p className="mt-3 text-sm text-texto-2">Se muestran los primeros {LIMITE} asientos. Reduzca el rango de fechas para ver el resto.</p>}
      </Panel>
    </>
  );
}
