import { Celda, Encabezado, Etiqueta, KpiCard, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_LIBROS } from '@/lib/fiscal/libros';
import { fecha, monto } from '@/lib/formato';
import { reporteIgtf, type FilaIgtf } from '@/lib/ventas/igtf';
import { leerPeriodo } from '../periodo';

function Detalle({ filas, tercero }: { filas: FilaIgtf[]; tercero: string }) {
  return (
    <Tabla columnas={['Fecha', 'Documento', tercero, 'RIF', { t: 'Base', derecha: true }, { t: '%', derecha: true }, { t: 'IGTF', derecha: true }, { t: 'IGTF (Bs.)', derecha: true }, 'Situación']} vacio="Sin movimientos en este mes.">
      {filas.map((f, i) => (
        <tr key={`${f.documento}-${i}`} className={f.revertido ? 'opacity-60' : ''}>
          <Celda className="text-texto-2">{fecha(f.fecha)}</Celda>
          <Celda mono>{f.documento}</Celda>
          <Celda>{f.tercero}</Celda>
          <Celda mono>{f.rif}</Celda>
          <Celda derecha mono>{f.moneda} {monto(f.base)}</Celda>
          <Celda derecha mono>{Number(f.porcentaje)}</Celda>
          <Celda derecha mono>{f.moneda} {monto(f.monto)}</Celda>
          <Celda derecha mono>{monto(f.monto_ves)}</Celda>
          <Celda>{f.revertido ? <Etiqueta tono="peligro">revertido</Etiqueta> : 'Vigente'}</Celda>
        </tr>
      ))}
    </Tabla>
  );
}

export default async function IgtfPage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  await exigirRol(...ROLES_VEN_LIBROS);
  const { periodo } = await searchParams;
  const p = leerPeriodo(periodo);
  const r = await reporteIgtf(await getDb(), p.anio, p.mes);

  return (
    <>
      <Encabezado titulo="IGTF"
        descripcion="Reporte propio del impuesto a las grandes transacciones financieras (no se mezcla con los libros de IVA). Lo percibido en cobros es un pasivo por enterar; lo pagado a proveedores agentes de percepción es gasto financiero." />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Mes</span><input type="month" name="periodo" defaultValue={p.texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
      </Panel>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <KpiCard titulo="Percibido en cobros del mes (Bs.)" valor={monto(r.totalPercibidoVes)} />
        <KpiCard titulo="IGTF por enterar al cierre (Bs.)" valor={monto(r.porEnterarVes)} subtitulo="Saldo de 2.1.06 en el mayor" />
        <KpiCard titulo="Pagado a proveedores en el mes (Bs.)" valor={monto(r.totalPagadoVes)} subtitulo="Gasto financiero" />
      </div>
      <Panel titulo="Percibido en cobros">
        <Detalle filas={r.percibido} tercero="Cliente" />
      </Panel>
      <Panel titulo="Pagado a proveedores" className="mt-5">
        <Detalle filas={r.pagado} tercero="Proveedor" />
      </Panel>
    </>
  );
}
