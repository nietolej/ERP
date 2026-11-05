import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_ESTADO_ORDEN, ROLES_PRODUCEN, ROLES_VEN_PRODUCCION, buscarOrdenes } from '@/lib/produccion/ordenes';

const FILTROS = [
  { valor: '', texto: 'Todas' }, { valor: 'borrador', texto: 'Borradores' }, { valor: 'pendiente', texto: 'Por liberar' }, { valor: 'liberada', texto: 'Liberadas' },
  { valor: 'en_proceso', texto: 'En proceso' }, { valor: 'terminada', texto: 'Terminadas' }, { valor: 'anulada', texto: 'Anuladas' },
] as const;
const TONO = { borrador: 'info', pendiente: 'advertencia', liberada: 'info', en_proceso: 'advertencia', terminada: 'exito', rechazada: 'peligro', anulada: 'peligro' } as const;

export default async function ProduccionPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PRODUCCION);
  const q = await searchParams;
  const estado = FILTROS.some((f) => f.valor === (q.estado ?? '')) ? (q.estado ?? '') : '';
  const filas = await buscarOrdenes(await getDb(), u, estado);
  const porLiberar = filas.filter((f) => f.estado === 'pendiente').length;

  return (
    <>
      <Encabezado titulo="Órdenes de producción"
        descripcion="Ensamblaje simple: los componentes salen del almacén al costo promedio y el producto terminado entra por la suma de esos costos. Gerencia, distinta de quien la creó, libera la orden.">
        {tieneRol(u, ROLES_PRODUCEN) && (
          <Link href="/inventario/produccion/nueva" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Nueva orden</Link>
        )}
      </Encabezado>
      {porLiberar > 0 && estado === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">{porLiberar === 1 ? 'Hay 1 orden por liberar.' : `Hay ${porLiberar} órdenes por liberar.`}</Aviso></div>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/inventario/produccion?estado=${f.valor}` : '/inventario/produccion'}
              className={`rounded-full border px-3 py-1 ${estado === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['N°', 'Producto terminado', { t: 'Cantidad', derecha: true }, 'Almacén', { t: 'Componentes', derecha: true }, 'Creó', 'Estado']} vacio="No hay órdenes con ese filtro.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/inventario/produccion/${f.id}`} className="text-acento hover:underline">{f.numero}</Link></Celda>
              <Celda>{f.producto}</Celda>
              <Celda derecha mono>{Number(f.cantidad)}</Celda>
              <Celda mono>{f.almacen}</Celda>
              <Celda derecha mono>{f.componentes}</Celda>
              <Celda className="text-texto-2">{f.creador} · {f.fecha}</Celda>
              <Celda><Etiqueta tono={TONO[f.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_ORDEN[f.estado] ?? f.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
