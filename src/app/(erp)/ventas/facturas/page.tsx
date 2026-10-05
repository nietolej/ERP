import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { ROLES_FACTURAN, ROLES_VEN_FACTURAS, buscarFacturas, notasPorFacturar } from '@/lib/ventas/facturas';

const FILTROS = [
  { valor: '', texto: 'Todas' },
  { valor: 'emitido', texto: 'Emitidas' },
  { valor: 'contingencia', texto: 'En contingencia' },
  { valor: 'anulado', texto: 'Anuladas' },
] as const;

export default async function FacturasPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_FACTURAS);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const db = await getDb();
  const [filas, pendientes] = await Promise.all([buscarFacturas(db, u, { estado: filtro }), notasPorFacturar(db, u)]);
  const factura = tieneRol(u, ROLES_FACTURAN);
  const enContingencia = filas.filter((f) => f.contingencia && f.estado === 'emitido').length;

  return (
    <>
      <Encabezado titulo="Facturas de venta"
        descripcion="Facturas fiscales en bolívares a la tasa BCV del día. Salen de las notas de entrega ya despachadas.">
        {factura && (
          <Link href="/ventas/facturas/nueva" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Facturar notas de entrega{pendientes.length ? ` (${pendientes.length})` : ''}
          </Link>
        )}
      </Encabezado>
      {enContingencia > 0 && filtro === '' && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            {enContingencia === 1 ? 'Hay 1 factura emitida' : `Hay ${enContingencia} facturas emitidas`} en contingencia, sin número de control: ábralas para asignarlo.
          </Aviso>
        </div>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/ventas/facturas?estado=${f.valor}` : '/ventas/facturas'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Factura', 'Control', 'Fecha', 'Cliente', { t: 'Total (Bs.)', derecha: true }, { t: 'Saldo (Bs.)', derecha: true }, 'Vence', 'Estado']}
          vacio="No hay facturas con ese filtro.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/ventas/facturas/${f.id}`} className="text-acento hover:underline">{f.numero}</Link></Celda>
              <Celda mono className="text-texto-2">{f.numero_control ?? '—'}</Celda>
              <Celda className="text-texto-2">{f.fecha}</Celda>
              <Celda>{f.cliente_codigo} · {f.cliente}</Celda>
              <Celda derecha mono>{monto(f.total, 'Bs. ')}</Celda>
              <Celda derecha mono>{f.saldo === null ? '—' : monto(f.saldo, 'Bs. ')}</Celda>
              <Celda className="text-texto-2">{f.vencimiento ?? '—'}</Celda>
              <Celda>
                {f.estado === 'anulado' ? <Etiqueta tono="peligro">Anulada</Etiqueta>
                  : f.contingencia ? <Etiqueta tono="advertencia">Contingencia</Etiqueta>
                  : <Etiqueta tono="exito">Emitida</Etiqueta>}
              </Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
