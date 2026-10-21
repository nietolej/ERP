import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, monto } from '@/lib/formato';
import { ROLES_COBRAN, ROLES_VEN_COBROS, buscarCobros } from '@/lib/ventas/cobros';

const FILTROS = [
  { valor: '', texto: 'Todos' }, { valor: 'registrado', texto: 'Registrados' }, { valor: 'conciliado', texto: 'Conciliados' }, { valor: 'anulado', texto: 'Anulados' },
] as const;
const TONO = { registrado: 'exito', conciliado: 'info', anulado: 'peligro' } as const;

export default async function CobrosPage({ searchParams }: { searchParams: Promise<{ estado?: string; q?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COBROS);
  const { estado = '', q = '' } = await searchParams;
  const filtro = FILTROS.some((f) => f.valor === estado) ? estado : '';
  const filas = await buscarCobros(await getDb(), u, { estado: filtro, texto: q });
  const puedeCobrar = tieneRol(u, [...ROLES_COBRAN]);
  const enlace = (e: string) => `/cobranzas/cobros?${new URLSearchParams({ ...(e ? { estado: e } : {}), ...(q ? { q } : {}) }).toString()}`;

  return (
    <>
      <Encabezado titulo="Cobros" descripcion="Pagos de clientes y su aplicación a las facturas. Lo que no se aplica queda como anticipo del cliente.">
        {puedeCobrar && <Link href="/cobranzas/cobros/nuevo" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Registrar cobro</Link>}
      </Encabezado>
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          {filtro && <input type="hidden" name="estado" value={filtro} />}
          <label className="block"><span className="mb-1 block text-texto-2">Buscar</span><input name="q" defaultValue={q} placeholder="N° de cobro, cliente o referencia" className="campo w-72" /></label>
          <button type="submit" className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Buscar</button>
        </form>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {FILTROS.map((f) => (
            <Link key={f.valor} href={enlace(f.valor)}
              className={`rounded-full border px-3 py-1 ${filtro === f.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{f.texto}</Link>
          ))}
        </nav>
        <Tabla columnas={['N°', 'Fecha', 'Cliente', 'Instrumento', 'Cuenta', 'Referencia', { t: 'Monto', derecha: true }, { t: 'Por aplicar', derecha: true }, 'Estado']}
          vacio="No hay cobros con ese filtro.">
          {filas.map((c) => (
            <tr key={c.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/cobranzas/cobros/${c.id}`} className="text-acento hover:underline">{c.numero}</Link></Celda>
              <Celda>{fecha(c.fecha)}</Celda>
              <Celda>{c.cliente_codigo} <span className="text-texto-2">· {c.cliente}</span></Celda>
              <Celda className="text-texto-2">{c.instrumento}</Celda>
              <Celda className="text-texto-2">{c.cuenta}</Celda>
              <Celda mono className="text-texto-2">{c.referencia ?? '—'}</Celda>
              <Celda derecha>{c.moneda} {monto(c.monto)}</Celda>
              <Celda derecha>{Number(c.por_aplicar) > 0 ? <Etiqueta tono="info">{c.moneda} {monto(c.por_aplicar)}</Etiqueta> : '—'}</Celda>
              <Celda><Etiqueta tono={TONO[c.estado as keyof typeof TONO] ?? 'info'}>{c.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
