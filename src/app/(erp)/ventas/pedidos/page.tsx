import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { ROLES_VENDEN, ROLES_VEN_VENTAS, buscarDocumentos, verTodosLosDocumentos } from '@/lib/ventas/pedidos';
import { etiquetaDocumento } from '@/lib/ventas/presentacion';

const FILTROS = [
  { valor: '', texto: 'Todos' },
  { valor: 'borrador', texto: 'Borradores' },
  { valor: 'retenido_credito', texto: 'Retenidos por crédito' },
  { valor: 'aprobado', texto: 'Aprobados' },
  { valor: 'anulado', texto: 'Anulados' },
] as const;

export default async function PedidosPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_VENTAS);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const filas = await buscarDocumentos(await getDb(), u, 'pedido', { estado: filtro });
  const crea = tieneRol(u, ROLES_VENDEN);
  const retenidos = filas.filter((f) => f.situacion === 'retenido_credito' && f.estado === 'emitido').length;

  return (
    <>
      <Encabezado titulo="Pedidos de venta"
        descripcion={verTodosLosDocumentos(u) ? 'Los pedidos aprobados reservan existencia; con ellos se generan las notas de entrega.' : 'Sus pedidos de venta.'}>
        {crea && (
          <Link href="/ventas/pedidos/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Nuevo pedido
          </Link>
        )}
      </Encabezado>
      {retenidos > 0 && filtro === '' && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            {retenidos === 1 ? 'Hay 1 pedido retenido' : `Hay ${retenidos} pedidos retenidos`} por exceder el crédito del cliente: Gerencia debe aprobarlos.
          </Aviso>
        </div>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/ventas/pedidos?estado=${f.valor}` : '/ventas/pedidos'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Pedido', 'Fecha', 'Cliente', 'Vendedor', 'Almacén', { t: 'Total (USD)', derecha: true }, 'Estado']}
          vacio="No hay pedidos con ese filtro.">
          {filas.map((p) => {
            const e = etiquetaDocumento(p.estado, p.situacion);
            return (
              <tr key={p.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/ventas/pedidos/${p.id}`} className="text-acento hover:underline">{p.numero ?? 'Borrador'}</Link></Celda>
                <Celda className="text-texto-2">{p.fecha ?? '—'}</Celda>
                <Celda>{p.cliente_codigo} · {p.cliente}</Celda>
                <Celda className="text-texto-2">{p.vendedor ?? '—'}</Celda>
                <Celda className="text-texto-2">{p.almacen}</Celda>
                <Celda derecha mono>{monto(p.total_usd, 'US$ ')}</Celda>
                <Celda><Etiqueta tono={e.tono}>{e.texto}</Etiqueta></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>
    </>
  );
}
