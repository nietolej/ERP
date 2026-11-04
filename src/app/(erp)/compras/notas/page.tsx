import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { NOMBRE_CLASE_NOTA, NOMBRE_ESTADO_NOTA, NOMBRE_TIPO_NOTA, ROLES_REGISTRAN_NOTA_PROVEEDOR, buscarNotas } from '@/lib/compras/notas-proveedor';
import { ROLES_VEN_COMPRAS } from '@/lib/compras/ordenes';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';

const FILTROS = [
  { valor: '', texto: 'Todas' },
  { valor: 'pendiente', texto: 'Por aprobar' },
  { valor: 'aprobada', texto: 'Aprobadas' },
  { valor: 'rechazada', texto: 'Rechazadas' },
] as const;

const TONO = { pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro' } as const;

export default async function NotasProveedorPage({ searchParams }: { searchParams: Promise<{ estado?: string; texto?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPRAS);
  const q = await searchParams;
  const estado = FILTROS.some((f) => f.valor === (q.estado ?? '')) ? (q.estado ?? '') : '';
  const texto = (q.texto ?? '').trim();
  const filas = await buscarNotas(await getDb(), u, { estado, texto });
  const pendientes = filas.filter((f) => f.estado === 'pendiente').length;

  return (
    <>
      <Encabezado titulo="Notas del proveedor"
        descripcion="Notas de crédito (devolución de mercancía o descuento) y de débito que corrigen una factura contabilizada. Gerencia, distinta de quien la registró, las aprueba.">
        {tieneRol(u, ROLES_REGISTRAN_NOTA_PROVEEDOR) && (
          <Link href="/compras/notas/nueva" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Registrar nota</Link>
        )}
      </Encabezado>
      {pendientes > 0 && estado === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">{pendientes === 1 ? 'Hay 1 nota por aprobar.' : `Hay ${pendientes} notas por aprobar.`}</Aviso></div>
      )}
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="estado" value={estado} />
          <label className="block"><span className="mb-1 block text-texto-2">Proveedor, nota o factura</span>
            <input name="texto" defaultValue={texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Buscar</button>
        </form>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/compras/notas?estado=${f.valor}` : '/compras/notas'}
              className={`rounded-full border px-3 py-1 ${estado === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['N°', 'Tipo', 'Nota del proveedor', 'Proveedor', 'Factura', 'Fecha', { t: 'Total', derecha: true }, 'Estado']} vacio="No hay notas con ese filtro.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/compras/notas/${f.id}`} className="text-acento hover:underline">{f.numero}</Link></Celda>
              <Celda>{NOMBRE_TIPO_NOTA[f.tipo]}<span className="block text-xs text-texto-2">{NOMBRE_CLASE_NOTA[f.clase]}</span></Celda>
              <Celda mono>{f.numero_documento}</Celda>
              <Celda>{f.proveedor}</Celda>
              <Celda mono><Link href={`/compras/facturas/${f.factura_id}`} className="text-acento hover:underline">{f.factura}</Link></Celda>
              <Celda className="text-texto-2">{fecha(f.fecha)}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.total)}</Celda>
              <Celda><Etiqueta tono={TONO[f.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_NOTA[f.estado] ?? f.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
