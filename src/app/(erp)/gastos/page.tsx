import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { NOMBRE_ESTADO_GASTO, ROLES_REGISTRAN_GASTO, ROLES_VEN_GASTOS, buscarGastosProveedor } from '@/lib/gastos/gastos';

const FILTROS = [
  { valor: '', texto: 'Todos' },
  { valor: 'pendiente', texto: 'Por aprobar' },
  { valor: 'contabilizado', texto: 'Contabilizados' },
  { valor: 'rechazado', texto: 'Rechazados' },
] as const;

const TONO = { pendiente: 'advertencia', contabilizado: 'exito', rechazado: 'peligro' } as const;

export default async function GastosPage({ searchParams }: { searchParams: Promise<{ estado?: string; texto?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_GASTOS);
  const q = await searchParams;
  const estado = FILTROS.some((f) => f.valor === (q.estado ?? '')) ? (q.estado ?? '') : '';
  const texto = (q.texto ?? '').trim();
  const filas = await buscarGastosProveedor(await getDb(), u, { estado, texto });
  const pendientes = filas.filter((f) => f.estado === 'pendiente').length;

  return (
    <>
      <Encabezado titulo="Facturas de gasto"
        descripcion="Facturas de proveedores de servicios (alquiler, servicios, publicidad…). Gerencia, distinta de quien las registró, las aprueba; al aprobarse nace la cuenta por pagar.">
        <div className="flex items-center gap-3">
          <Link href="/gastos/categorias" className="text-sm text-texto-2 hover:text-texto">Categorías de gasto</Link>
          {tieneRol(u, ROLES_REGISTRAN_GASTO) && (
            <Link href="/gastos/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Registrar gasto</Link>
          )}
        </div>
      </Encabezado>
      {pendientes > 0 && estado === '' && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">{pendientes === 1 ? 'Hay 1 gasto por aprobar.' : `Hay ${pendientes} gastos por aprobar.`}</Aviso></div>
      )}
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="estado" value={estado} />
          <label className="block"><span className="mb-1 block text-texto-2">Proveedor, factura o número</span>
            <input name="texto" defaultValue={texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Buscar</button>
        </form>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={f.valor ? `/gastos?estado=${f.valor}` : '/gastos'}
              className={`rounded-full border px-3 py-1 ${estado === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>
              {f.texto}
            </Link>
          ))}
        </nav>
        <Tabla columnas={['N°', 'Proveedor', 'Categoría', 'Factura', 'Fecha', { t: 'Total', derecha: true }, 'Estado']} vacio="No hay gastos con ese filtro.">
          {filas.map((f) => (
            <tr key={f.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/gastos/${f.id}`} className="text-acento hover:underline">{f.numero}</Link></Celda>
              <Celda>{f.proveedor}</Celda>
              <Celda>{f.categoria}</Celda>
              <Celda mono>{f.numero_factura}</Celda>
              <Celda className="text-texto-2">{f.fecha}</Celda>
              <Celda derecha mono>{f.moneda} {monto(f.total)}</Celda>
              <Celda><Etiqueta tono={TONO[f.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_GASTO[f.estado] ?? f.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
