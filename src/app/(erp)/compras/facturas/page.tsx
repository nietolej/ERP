import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_ESTADO_FACTURA, ROLES_REGISTRAN_FACTURA, buscarFacturas } from '@/lib/compras/facturas';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';

const FILTROS = [
  { valor: '', texto: 'Todas' },
  { valor: 'borrador', texto: 'Borradores' },
  { valor: 'retenida', texto: 'Retenidas' },
  { valor: 'contabilizada', texto: 'Contabilizadas' },
  { valor: 'rechazada', texto: 'Rechazadas' },
] as const;

const TONO = { borrador: 'info', retenida: 'advertencia', contabilizada: 'exito', rechazada: 'peligro' } as const;

export default async function FacturasCompraPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const { estado = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const filas = await buscarFacturas(await getDb(), u, { estado: filtro });
  const retenidas = filas.filter((f) => f.estado === 'retenida').length;

  return (
    <>
      <Encabezado titulo="Facturas de proveedor"
        descripcion="Cada factura se concilia con la orden (precio) y la recepción (cantidad). Fuera de tolerancia queda retenida y no se puede pagar hasta que Gerencia la apruebe.">
        {tieneRol(u, ROLES_REGISTRAN_FACTURA) && (
          <Link href="/compras/facturas/nueva" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">
            Registrar factura
          </Link>
        )}
      </Encabezado>
      {retenidas > 0 && filtro === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5">
          <Aviso tono="advertencia">{retenidas === 1 ? 'Hay 1 factura retenida' : `Hay ${retenidas} facturas retenidas`} por diferencia de precio.</Aviso>
        </div>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/compras/facturas?estado=${f.valor}` : '/compras/facturas'}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['Registro', 'Factura', 'Proveedor', 'Orden', 'Fecha', 'Vence', { t: 'Total', derecha: true }, 'Estado']} vacio="No hay facturas con ese filtro.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/compras/facturas/${f.id}`} className="text-acento hover:underline">{f.numero ?? 'Borrador'}</Link></Celda>
              <Celda mono>{f.numero_factura}</Celda>
              <Celda>{f.proveedor}</Celda>
              <Celda mono className="text-texto-2">{f.orden}</Celda>
              <Celda className="text-texto-2">{f.fecha}</Celda>
              <Celda className="text-texto-2">{f.vencimiento}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.total)}</Celda>
              <Celda><Etiqueta tono={TONO[f.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_FACTURA[f.estado] ?? f.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
