import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_COMPRAN, ROLES_VEN_COMPRAS, buscarOrdenes } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';

const FILTROS = [
  { valor: '', texto: 'Todas' },
  { valor: 'borrador', texto: 'Borradores' },
  { valor: 'pendiente', texto: 'Pendientes de aprobación' },
  { valor: 'aprobada', texto: 'Aprobadas' },
  { valor: 'rechazada', texto: 'Rechazadas' },
  { valor: 'anulada', texto: 'Anuladas' },
] as const;

const TONO = { borrador: 'info', pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro', anulada: 'peligro' } as const;

export default async function OrdenesPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const filas = await buscarOrdenes(await getDb(), u, { estado: filtro });
  const pendientes = filas.filter((f) => f.estado === 'pendiente').length;

  return (
    <>
      <Encabezado titulo="Órdenes de compra"
        descripcion="Las crea Compras y las aprueba Gerencia (nunca quien la creó). La mercancía se recibe contra la orden aprobada.">
        {tieneRol(u, ROLES_COMPRAN) && (
          <Link href="/compras/ordenes/nueva" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Nueva orden
          </Link>
        )}
      </Encabezado>
      {pendientes > 0 && filtro === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5">
          <Aviso tono="advertencia">{pendientes === 1 ? 'Hay 1 orden pendiente' : `Hay ${pendientes} órdenes pendientes`} de aprobación.</Aviso>
        </div>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/compras/ordenes?estado=${f.valor}` : '/compras/ordenes'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Orden', 'Fecha', 'Proveedor', 'Almacén', { t: 'Total', derecha: true }, 'Entrega prometida', { t: 'Pendiente por recibir', derecha: true }, 'Estado']}
          vacio="No hay órdenes con ese filtro.">
          {filas.map((o) => (
            <tr key={o.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/compras/ordenes/${o.id}`} className="text-acento hover:underline">{o.numero ?? 'Borrador'}</Link></Celda>
              <Celda className="text-texto-2">{o.fecha}</Celda>
              <Celda>{o.proveedor}</Celda>
              <Celda className="text-texto-2">{o.almacen}</Celda>
              <Celda derecha mono>{o.moneda} {monto(o.total)}</Celda>
              <Celda className="text-texto-2">{o.fecha_prometida ?? '—'}</Celda>
              <Celda derecha mono>{o.estado === 'aprobada' ? Number(o.pendiente) : '—'}</Celda>
              <Celda><Etiqueta tono={TONO[o.estado as keyof typeof TONO] ?? 'info'}>{o.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
