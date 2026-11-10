import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_CRM, ROLES_VEN_CRM } from '@/lib/crm/comun';
import { ETAPAS, listarOportunidades, NOMBRE_ETAPA } from '@/lib/crm/oportunidades';
import { tercerosComerciales } from '@/lib/crm/prospectos';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import { crearOportunidadAccion } from '../acciones';

export default async function OportunidadesPage({ searchParams }: { searchParams: Promise<{ etapa?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CRM);
  const sp = await searchParams;
  const etapa = sp.etapa === 'todas' || (ETAPAS as readonly string[]).includes(sp.etapa ?? '') ? sp.etapa! : 'abiertas';
  const db = await getDb();
  const crea = tieneRol(u, [...ROLES_CRM]);
  const [filas, terceros] = await Promise.all([
    listarOportunidades(db, u, etapa === 'abiertas' ? { abiertas: true } : etapa === 'todas' ? {} : { etapa }),
    crea ? tercerosComerciales(db, u) : Promise.resolve([]),
  ]);
  const filtros = [['abiertas', 'Abiertas'], ...ETAPAS.map((e) => [e, NOMBRE_ETAPA[e]]), ['todas', 'Todas']];

  return (
    <>
      <Encabezado titulo="Oportunidades"
        descripcion="Lo que se le quiere vender a un cliente o prospecto. Las etapas avanzan una a una: Prospecto, Calificada, Cotizada (con su cotización), Negociación y Ganada o Perdida." />
      {crea && (
        <Panel titulo="Nueva oportunidad" className="mb-5">
          <Formulario accion={crearOportunidadAccion} className="grid gap-4 sm:grid-cols-4">
            <Campo etiqueta="Cliente o prospecto">
              <select name="tercero_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {terceros.map((t) => <option key={t.id} value={t.id}>{t.etiqueta}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Descripción"><input name="titulo" required className="campo" placeholder="Pastillas para la flota" /></Campo>
            <Campo etiqueta="Monto estimado US$"><input name="monto" inputMode="decimal" defaultValue="0" className="campo" /></Campo>
            <Campo etiqueta="Cierre estimado"><input name="cierre" type="date" className="campo" /></Campo>
            <div className="sm:col-span-4 flex justify-end"><BotonEnviar>Crear oportunidad</BotonEnviar></div>
          </Formulario>
        </Panel>
      )}
      <Panel>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filtrar por etapa">
          {filtros.map(([v, t]) => (
            <Link key={v} href={`/crm/oportunidades?etapa=${v}`}
              className={`rounded-full border px-3 py-1 ${etapa === v ? 'border-acento bg-acento/15 text-texto' : 'border-borde text-texto-2 hover:text-texto'}`}>{t}</Link>
          ))}
        </nav>
        <Tabla columnas={['Oportunidad', 'Cliente o prospecto', 'Vendedor', 'Etapa', { t: 'Monto US$', derecha: true }, 'Cierre estimado', 'Cotización']}
          vacio="No hay oportunidades con ese filtro.">
          {filas.map((o) => (
            <tr key={o.id} className="hover:bg-white/[0.03]">
              <Celda><Link href={`/crm/oportunidades/${o.id}`} className="text-acento hover:underline">{o.titulo}</Link></Celda>
              <Celda><Link href={`/crm/terceros/${o.tercero_id}`} className="hover:underline">{o.tercero}</Link>{o.prospecto && <span className="ml-2"><Etiqueta>Prospecto</Etiqueta></span>}</Celda>
              <Celda className="text-texto-2">{o.vendedor}</Celda>
              <Celda><Etiqueta tono={o.etapa === 'ganada' ? 'exito' : o.etapa === 'perdida' ? 'peligro' : 'info'}>{NOMBRE_ETAPA[o.etapa]}</Etiqueta></Celda>
              <Celda derecha mono>{monto(o.monto_estimado_usd)}</Celda>
              <Celda className="text-texto-2">{o.cerrada ? `Cerrada ${o.cerrada}` : o.cierre_estimado ?? '—'}</Celda>
              <Celda mono className="text-texto-2">{o.cotizacion_numero ?? '—'}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
