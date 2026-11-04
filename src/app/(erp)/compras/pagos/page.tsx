import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_ESTADO_PAGO, ROLES_PAGAN, ROLES_VEN_PAGOS, buscarPagos } from '@/lib/compras/pagos';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';

const FILTROS = [
  { valor: '', texto: 'Todos' },
  { valor: 'solicitado', texto: 'Por aprobar' },
  { valor: 'pagado', texto: 'Pagados' },
  { valor: 'rechazado', texto: 'Rechazados' },
  { valor: 'anulado', texto: 'Anulados' },
] as const;

const TONO = { solicitado: 'advertencia', pagado: 'exito', rechazado: 'peligro', anulado: 'info' } as const;

export default async function PagosPage({ searchParams }: { searchParams: Promise<{ estado?: string; texto?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PAGOS);
  const q = await searchParams;
  const estado = FILTROS.some((f) => f.valor === (q.estado ?? '')) ? (q.estado ?? '') : '';
  const texto = (q.texto ?? '').trim();
  const filas = await buscarPagos(await getDb(), u, { estado, texto });
  const porAprobar = filas.filter((f) => f.estado === 'solicitado').length;

  return (
    <>
      <Encabezado titulo="Pagos a proveedores"
        descripcion="Tesorería solicita el pago; Gerencia, distinta de quien lo solicitó, lo aprueba. Solo al aprobarse se aplica a las facturas, sale del banco y se contabiliza.">
        {tieneRol(u, ROLES_PAGAN) && (
          <Link href="/compras/pagos/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Solicitar pago</Link>
        )}
      </Encabezado>
      {porAprobar > 0 && estado === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">{porAprobar === 1 ? 'Hay 1 pago por aprobar.' : `Hay ${porAprobar} pagos por aprobar.`}</Aviso></div>
      )}
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="estado" value={estado} />
          <label className="block"><span className="mb-1 block text-texto-2">Proveedor, número o referencia</span>
            <input name="texto" defaultValue={texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Buscar</button>
        </form>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/compras/pagos?estado=${f.valor}` : '/compras/pagos'}
              className={`rounded-full border px-3 py-1 ${estado === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['N°', 'Fecha', 'Proveedor', 'Cuenta', 'Referencia', { t: 'Monto', derecha: true }, { t: 'Anticipo', derecha: true }, 'Estado']} vacio="No hay pagos con ese filtro.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/compras/pagos/${f.id}`} className="text-acento hover:underline">{f.numero}</Link></Celda>
              <Celda className="text-texto-2">{fecha(f.fecha)}</Celda>
              <Celda>{f.proveedor}</Celda>
              <Celda className="text-texto-2">{f.cuenta} · {f.instrumento}</Celda>
              <Celda mono className="text-texto-2">{f.referencia ?? '—'}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.monto)}</Celda>
              <Celda derecha mono>{f.estado === 'pagado' && Number(f.por_aplicar) > 0 ? `${f.moneda} ${monto(f.por_aplicar)}` : '—'}</Celda>
              <Celda><Etiqueta tono={TONO[f.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_PAGO[f.estado] ?? f.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
