import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fechaHora, monto } from '@/lib/formato';
import { NOMBRE_TIPO_META, ROLES_APRUEBAN_METAS, ROLES_VEN_METAS, type TipoMeta } from '@/lib/maestros/metas';
import { aprobarLoteAccion, rechazarLoteAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const TONO = { pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function LoteMetasPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_METAS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const { rows } = await db.query<{
    version: number; origen: string; archivo: string | null; estado: 'pendiente' | 'aprobado' | 'rechazado'; creado_por: string;
    creador: string; created_at: string; resolutor: string | null; resuelto_at: string | null; motivo_rechazo: string | null;
  }>(
    `select l.version, l.origen, l.archivo, l.estado, l.creado_por, c.nombre as creador, l.created_at,
            r.nombre as resolutor, l.resuelto_at, l.motivo_rechazo
       from meta_lote l join usuario c on c.id = l.creado_por left join usuario r on r.id = l.resuelto_por
      where l.id = $1`, [id]);
  const l = rows[0];
  if (!l) notFound();

  // Cada fila junto con la meta vigente que reemplazaría (o la anterior a este lote, si ya se resolvió).
  const filas = await db.query<{ tipo: TipoMeta; entidad: string; anio: number; mes: number | null; monto_usd: string; vigente_usd: string | null }>(
    `select m.tipo, fn_meta_entidad(m.tipo, m.entidad_id) as entidad, m.anio, m.mes, m.monto_usd,
            (select v.monto_usd from vw_meta_periodo v
              where v.tipo = m.tipo and v.entidad_id is not distinct from m.entidad_id and v.anio = m.anio and v.mes is not distinct from m.mes
                and ($3::boolean or v.version < $2)) as vigente_usd
       from meta_venta m where m.lote_id = $1 order by m.tipo, entidad, m.anio, m.mes nulls first`, [id, l.version, l.estado === 'pendiente']);

  const puedeResolver = l.estado === 'pendiente' && tieneRol(u, ROLES_APRUEBAN_METAS);
  const esQuienCargo = l.creado_por === u.id;

  return (
    <>
      <Encabezado titulo={`Lote de metas v${l.version}`}>
        <Link href="/metas" className="text-sm text-texto-2 hover:text-texto">← Metas</Link>
      </Encabezado>
      <Panel titulo="Datos del lote">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          <div><dt className="text-texto-2">Estado</dt><dd><Etiqueta tono={TONO[l.estado]}>{l.estado}</Etiqueta></dd></div>
          <div><dt className="text-texto-2">Origen</dt><dd>{l.origen === 'excel' ? `Excel${l.archivo ? ` · ${l.archivo}` : ''}` : 'Captura manual'}</dd></div>
          <div><dt className="text-texto-2">Cargó</dt><dd>{l.creador} · {fechaHora(l.created_at)}</dd></div>
          {l.resolutor && <div><dt className="text-texto-2">{l.estado === 'aprobado' ? 'Aprobó' : 'Rechazó'}</dt><dd>{l.resolutor} · {fechaHora(l.resuelto_at)}</dd></div>}
          {l.motivo_rechazo && <div className="md:col-span-2"><dt className="text-texto-2">Motivo del rechazo</dt><dd className="whitespace-pre-line">{l.motivo_rechazo}</dd></div>}
        </dl>
      </Panel>

      <Panel titulo={`Metas del lote (${filas.rows.length})`} className="mt-5">
        <Tabla columnas={['Tipo', 'Entidad', 'Año', 'Mes', { t: 'Vigente antes (USD)', derecha: true }, { t: 'Meta del lote (USD)', derecha: true }]}>
          {filas.rows.map((f) => (
            <tr key={`${f.tipo}${f.entidad}${f.anio}${f.mes}`}>
              <Celda>{NOMBRE_TIPO_META[f.tipo]}</Celda>
              <Celda>{f.entidad}</Celda>
              <Celda mono>{f.anio}</Celda>
              <Celda>{f.mes ? MESES[f.mes - 1] : 'Anual'}</Celda>
              <Celda derecha mono className="text-texto-2">{f.vigente_usd ? monto(f.vigente_usd, '$') : 'Sin meta'}</Celda>
              <Celda derecha mono>{monto(f.monto_usd, '$')}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      {puedeResolver && (
        <Panel titulo="Resolución de Gerencia" className="mt-5">
          {esQuienCargo ? (
            <Aviso tono="advertencia">Usted cargó este lote: lo debe aprobar o rechazar otro usuario con el rol Gerencia.</Aviso>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              <Formulario accion={aprobarLoteAccion} className="space-y-3">
                <input type="hidden" name="id" value={id} />
                <p className="text-sm text-texto-2">Al aprobar, estas metas pasan a ser las vigentes.</p>
                <BotonEnviar>Aprobar lote</BotonEnviar>
              </Formulario>
              <Formulario accion={rechazarLoteAccion} className="space-y-3">
                <input type="hidden" name="id" value={id} />
                <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
                <BotonEnviar variante="peligro">Rechazar lote</BotonEnviar>
              </Formulario>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
