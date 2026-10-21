import Link from 'next/link';
import { Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { NOMBRE_CLASE_NC, NOMBRE_CLASE_ND, ROLES_CREAN_NOTAS, ROLES_VEN_NOTAS, buscarNotas, type ClaseNC, type ClaseND } from '@/lib/ventas/notas';

const ESTADOS = [
  { valor: '', texto: 'Todas' }, { valor: 'borrador', texto: 'Borradores' }, { valor: 'pendiente', texto: 'Por aprobar' }, { valor: 'aprobada', texto: 'Por emitir' },
  { valor: 'emitida', texto: 'Emitidas' }, { valor: 'rechazada', texto: 'Rechazadas' },
] as const;
const TIPOS = [{ valor: '', texto: 'Crédito y débito' }, { valor: 'nota_credito', texto: 'Notas de crédito' }, { valor: 'nota_debito', texto: 'Notas de débito' }] as const;

export default async function NotasPage({ searchParams }: { searchParams: Promise<{ tipo?: string; estado?: string; q?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_NOTAS);
  const { tipo = '', estado = '', q = '' } = await searchParams;
  const t = TIPOS.some((x) => x.valor === tipo) ? tipo : '';
  const e = ESTADOS.some((x) => x.valor === estado) ? estado : '';
  const filas = await buscarNotas(await getDb(), u, { tipo: t, estado: e, texto: q });
  const enlace = (extra: Record<string, string>) => `/ventas/notas?${new URLSearchParams(Object.fromEntries(Object.entries({ tipo: t, estado: e, q, ...extra }).filter(([, v]) => v))).toString()}`;
  const situacion = (n: (typeof filas)[number]) => n.estado === 'emitido'
    ? (n.contingencia ? { texto: 'Emitida · contingencia', tono: 'advertencia' as const } : { texto: 'Emitida', tono: 'exito' as const })
    : n.situacion === 'pendiente_aprobacion' ? { texto: 'Por aprobar', tono: 'advertencia' as const }
    : n.situacion === 'aprobada' ? { texto: 'Por emitir', tono: 'info' as const }
    : n.situacion === 'rechazada' ? { texto: 'Rechazada', tono: 'peligro' as const }
    : { texto: 'Borrador', tono: 'info' as const };

  return (
    <>
      <Encabezado titulo="Notas de crédito y débito"
        descripcion="Devoluciones, descuentos y ajustes sobre una factura. Las aprueba el Supervisor de ventas y las emite Facturación.">
        {tieneRol(u, [...ROLES_CREAN_NOTAS]) && <Link href="/ventas/notas/nueva" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Nueva nota</Link>}
      </Encabezado>
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          {t && <input type="hidden" name="tipo" value={t} />}
          {e && <input type="hidden" name="estado" value={e} />}
          <label className="block"><span className="mb-1 block text-texto-2">Buscar</span><input name="q" defaultValue={q} placeholder="N° de nota o factura, cliente" className="campo w-72" /></label>
          <button type="submit" className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Buscar</button>
        </form>
        <div className="mb-4 flex flex-wrap gap-4 text-sm">
          <nav className="flex flex-wrap gap-2" aria-label="Filtrar por tipo">
            {TIPOS.map((x) => <Link key={x.valor} href={enlace({ tipo: x.valor })} className={`rounded-full border px-3 py-1 ${t === x.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{x.texto}</Link>)}
          </nav>
          <nav className="flex flex-wrap gap-2" aria-label="Filtrar por estado">
            {ESTADOS.map((x) => <Link key={x.valor} href={enlace({ estado: x.valor })} className={`rounded-full border px-3 py-1 ${e === x.valor ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{x.texto}</Link>)}
          </nav>
        </div>
        <Tabla columnas={['Nota', 'Clase', 'Factura', 'Cliente', 'Fecha', { t: 'Total Bs.', derecha: true }, 'Estado']} vacio="No hay notas con ese filtro.">
          {filas.map((n) => {
            const s = situacion(n);
            return (
              <tr key={n.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/ventas/notas/${n.id}`} className="text-acento hover:underline">{n.numero ?? 'Borrador'}</Link> <span className="text-xs text-texto-2">{n.tipo === 'nota_credito' ? 'NC' : 'ND'}</span></Celda>
                <Celda className="text-texto-2">{n.tipo === 'nota_credito' ? NOMBRE_CLASE_NC[n.motivo_nc as ClaseNC] : NOMBRE_CLASE_ND[n.motivo_nc as ClaseND]}</Celda>
                <Celda mono>{n.factura}</Celda>
                <Celda>{n.cliente_codigo} <span className="text-texto-2">· {n.cliente}</span></Celda>
                <Celda>{n.fecha ?? '—'}</Celda>
                <Celda derecha>{monto(n.total)}</Celda>
                <Celda><Etiqueta tono={s.tono}>{s.texto}</Etiqueta></Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>
    </>
  );
}
