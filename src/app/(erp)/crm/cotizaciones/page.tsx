import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM } from '@/lib/crm/comun';
import { LISTAS, listarCotizaciones } from '@/lib/crm/cotizaciones';
import { tercerosComerciales } from '@/lib/crm/prospectos';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { crearCotizacionAccion } from '../acciones';

const ESTADOS: Record<string, { texto: string; tono: 'info' | 'exito' | 'advertencia' | 'peligro' }> = {
  borrador: { texto: 'Borrador', tono: 'advertencia' },
  emitida: { texto: 'Emitida', tono: 'info' },
  convertida: { texto: 'Convertida en pedido', tono: 'exito' },
  anulada: { texto: 'Anulada', tono: 'peligro' },
};

export default async function CotizacionesPage({ searchParams }: { searchParams: Promise<{ estado?: string; tercero?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const sp = await searchParams;
  const estado = sp.estado && ESTADOS[sp.estado] ? sp.estado : '';
  const db = await getDb();
  const crea = tieneRol(u, [...ROLES_CRM]);
  const [filas, terceros, almacenes] = await Promise.all([
    listarCotizaciones(db, u, { estado }),
    crea ? tercerosComerciales(db, u) : Promise.resolve([]),
    crea ? db.query<{ id: string; nombre: string }>(`select id, codigo || ' · ' || nombre as nombre from almacen where activo and permite_venta order by codigo`).then((r) => r.rows) : Promise.resolve([]),
  ]);

  return (
    <>
      <Encabezado titulo="Cotizaciones"
        descripcion="Ofertas en US$ con vigencia, a clientes activos o prospectos. No reservan existencia; al ganarse la oportunidad se copian a un pedido en borrador." />
      {crea && (
        <Panel titulo="Nueva cotización" className="mb-5">
          <Formulario accion={crearCotizacionAccion} className="grid gap-4 sm:grid-cols-4">
            <Campo etiqueta="Cliente o prospecto">
              <select name="tercero_id" required defaultValue={terceros.some((t) => t.id === sp.tercero) ? sp.tercero : ''} className="campo">
                <option value="" disabled>Seleccione…</option>
                {terceros.map((t) => <option key={t.id} value={t.id}>{t.etiqueta}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Almacén">
              <select name="almacen_id" required defaultValue={almacenes.length === 1 ? almacenes[0].id : ''} className="campo">
                <option value="" disabled>Seleccione…</option>
                {almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Lista de precio (solo prospectos)" ayuda="Un cliente se cotiza siempre con su propia lista.">
              <select name="lista_precio" defaultValue="B" className="campo">
                {LISTAS.map((l) => <option key={l} value={l}>Lista {l}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Observaciones"><input name="observaciones" className="campo" /></Campo>
            <div className="sm:col-span-4 flex justify-end"><BotonEnviar>Crear cotización</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por estado">
          {[['', 'Todas'], ...Object.entries(ESTADOS).map(([k, v]) => [k, v.texto])].map(([k, t]) => (
            <Link key={k || 'todas'} href={k ? `/crm/cotizaciones?estado=${k}` : '/crm/cotizaciones'}
              className={`rounded-full border px-3 py-1 ${estado === k ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{t}</Link>
          ))}
        </nav>
        <Tabla columnas={['Número', 'Cliente o prospecto', 'Vendedor', 'Emitida', 'Vigente hasta', { t: 'Total US$', derecha: true }, 'Estado']}
          vacio="No hay cotizaciones con ese filtro.">
          {filas.map((q) => {
            const e = ESTADOS[q.estado];
            return (
              <tr key={q.id} className="hover:bg-white/[0.03]">
                <Celda mono><Link href={`/crm/cotizaciones/${q.id}`} className="text-acento hover:underline">{q.numero ?? 'Borrador'}</Link></Celda>
                <Celda>{q.tercero}{q.prospecto && <span className="ml-2"><Etiqueta>Prospecto</Etiqueta></span>}</Celda>
                <Celda className="text-texto-2">{q.vendedor}</Celda>
                <Celda className="text-texto-2">{q.fecha ?? '—'}</Celda>
                <Celda className="text-texto-2">{q.vigente_hasta ?? '—'}</Celda>
                <Celda derecha mono>{monto(q.total)}</Celda>
                <Celda>{q.vencida ? <Etiqueta tono="advertencia">Vencida</Etiqueta> : <Etiqueta tono={e.tono}>{e.texto}</Etiqueta>}</Celda>
              </tr>
            );
          })}
        </Tabla>
      </Panel>
    </>
  );
}
