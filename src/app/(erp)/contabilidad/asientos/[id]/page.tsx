import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { huellaAsiento } from '@/lib/contabilidad/manual';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { getDb } from '@/lib/db';
import { fecha, fechaHora, monto, tasa } from '@/lib/formato';
import { aprobarAsientoManual, eliminarAsiento } from '../acciones';
import { UUID } from '../datos';
import { NOMBRE_TIPO } from '../tipos';

export default async function AsientoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol('contabilidad', 'jefe_contabilidad', 'gerencia', 'auditor');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();

  const { rows } = await db.query<{
    numero: string | null; fecha: string; tipo: string; descripcion: string; estado: string;
    created_by: string; creador: string; created_at: Date; aprobador: string | null; contabilizado_at: Date | null;
    reversa_de: string | null; numero_reversado: string | null; reverso_id: string | null; numero_reverso: string | null;
  }>(
    `select a.numero, a.fecha, a.tipo, a.descripcion, a.estado, a.created_by, uc.nombre as creador, a.created_at,
            ua.nombre as aprobador, a.contabilizado_at,
            a.reversa_de, ar.numero as numero_reversado, rv.id as reverso_id, rv.numero as numero_reverso
       from asiento a
       join usuario uc on uc.id = a.created_by
       left join usuario ua on ua.id = a.aprobado_por
       left join asiento ar on ar.id = a.reversa_de
       left join asiento rv on rv.reversa_de = a.id
      where a.id = $1`, [id]);
  const a = rows[0];
  if (!a) notFound();

  const { rows: lineas } = await db.query<{
    id: string; codigo: string; cuenta: string; glosa: string | null; moneda_original: string; monto_original: string; tasa: string;
    debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string;
  }>(
    `select l.id, c.codigo, c.nombre as cuenta, l.glosa, l.moneda_original, l.monto_original, l.tasa,
            l.debe_ves, l.haber_ves, l.debe_usd, l.haber_usd
       from asiento_linea l join cuenta_contable c on c.id = l.cuenta_id
      where l.asiento_id = $1 order by l.id`, [id]);
  const { rows: tot } = await db.query<{ debe_ves: string; haber_ves: string; debe_usd: string; haber_usd: string; cuadra: boolean }>(
    `select coalesce(sum(debe_ves), 0) as debe_ves, coalesce(sum(haber_ves), 0) as haber_ves,
            coalesce(sum(debe_usd), 0) as debe_usd, coalesce(sum(haber_usd), 0) as haber_usd,
            coalesce(sum(debe_ves) = sum(haber_ves) and sum(debe_usd) = sum(haber_usd), false) as cuadra
       from asiento_linea where asiento_id = $1`, [id]);
  const t = tot[0];

  const borradorManual = a.tipo === 'manual' && a.estado === 'borrador';
  const esCreador = a.created_by === u.id;
  const puedeEditar = borradorManual && esCreador && tieneRol(u, ['contabilidad']);
  const puedeAprobar = borradorManual && (await puedeDecidirObjeto(db, u.id, 'asiento_manual', id));
  const huella = puedeAprobar ? await huellaAsiento(db, id) : '';

  return (
    <>
      <Encabezado
        titulo={a.numero ? `Asiento N° ${a.numero}` : 'Asiento en borrador'}
        descripcion={`${fecha(a.fecha)} · ${NOMBRE_TIPO[a.tipo] ?? a.tipo} · ${a.descripcion}`}>
        <Link href="/contabilidad/asientos" className="text-sm text-texto-2 hover:text-texto">← Volver a asientos</Link>
      </Encabezado>

      <div className="mb-5 grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Panel titulo="Datos">
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            <dt className="text-texto-2">Estado</dt>
            <dd>{a.estado === 'contabilizado'
              ? <Etiqueta tono="exito">contabilizado</Etiqueta>
              : <Etiqueta tono="advertencia">borrador · pendiente de aprobación</Etiqueta>}</dd>
            <dt className="text-texto-2">Registrado por</dt>
            <dd>{a.creador} · {fechaHora(a.created_at)}</dd>
            <dt className="text-texto-2">Aprobado por</dt>
            <dd>{a.aprobador ?? '—'}</dd>
            <dt className="text-texto-2">Contabilizado</dt>
            <dd>{fechaHora(a.contabilizado_at)}</dd>
            {a.reversa_de && (<>
              <dt className="text-texto-2">Reversa a</dt>
              <dd><Link href={`/contabilidad/asientos/${a.reversa_de}`} className="text-acento hover:underline">Asiento N° {a.numero_reversado}</Link></dd>
            </>)}
            {a.reverso_id && (<>
              <dt className="text-texto-2">Reversado por</dt>
              <dd><Link href={`/contabilidad/asientos/${a.reverso_id}`} className="text-acento hover:underline">Asiento N° {a.numero_reverso}</Link></dd>
            </>)}
          </dl>
        </Panel>

        {borradorManual && (
          <Panel titulo="Acciones">
            {puedeAprobar && (
              <Formulario accion={aprobarAsientoManual} className="space-y-3">
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="huella" value={huella} />
                <p className="text-sm text-texto-2">Al aprobar, el asiento queda contabilizado con su número y ya no se puede modificar: se corrige con un reverso.</p>
                <BotonEnviar>Aprobar y contabilizar</BotonEnviar>
              </Formulario>
            )}
            {puedeEditar && (
              <div className="space-y-3">
                <Link href={`/contabilidad/asientos/${id}/editar`}
                  className="inline-block rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Corregir borrador</Link>
                <Formulario accion={eliminarAsiento}>
                  <input type="hidden" name="id" value={id} />
                  <BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar>
                </Formulario>
              </div>
            )}
            {!puedeAprobar && !puedeEditar && (
              <p className="text-sm text-texto-2">
                {esCreador
                  ? 'Usted registró este asiento: debe aprobarlo otro usuario con el rol Jefe de contabilidad.'
                  : 'Pendiente de aprobación por un usuario con el rol Jefe de contabilidad.'}
              </p>
            )}
          </Panel>
        )}
      </div>

      <Panel titulo="Líneas">
        <Tabla columnas={['Cuenta', 'Glosa', { t: 'Importe original', derecha: true }, { t: 'Tasa', derecha: true },
          { t: 'Debe Bs', derecha: true }, { t: 'Haber Bs', derecha: true }, { t: 'Debe US$', derecha: true }, { t: 'Haber US$', derecha: true }]}>
          {lineas.map((l) => (
            <tr key={l.id}>
              <Celda><span className="font-mono">{l.codigo}</span> · {l.cuenta}</Celda>
              <Celda className="text-texto-2">{l.glosa ?? ''}</Celda>
              <Celda derecha>{l.moneda_original} {monto(l.monto_original)}</Celda>
              <Celda derecha className="text-texto-2">{tasa(l.tasa)}</Celda>
              <Celda derecha>{monto(l.debe_ves)}</Celda>
              <Celda derecha>{monto(l.haber_ves)}</Celda>
              <Celda derecha>{monto(l.debe_usd)}</Celda>
              <Celda derecha>{monto(l.haber_usd)}</Celda>
            </tr>
          ))}
          <tr className="font-semibold">
            <Celda>Totales</Celda><Celda>{''}</Celda><Celda>{''}</Celda><Celda>{''}</Celda>
            <Celda derecha>{monto(t.debe_ves, 'Bs ')}</Celda>
            <Celda derecha>{monto(t.haber_ves, 'Bs ')}</Celda>
            <Celda derecha>{monto(t.debe_usd, '$')}</Celda>
            <Celda derecha>{monto(t.haber_usd, '$')}</Celda>
          </tr>
        </Tabla>
        {!t.cuadra && (
          <div className="mt-4"><Aviso tono="peligro">El asiento no cuadra: no se podrá contabilizar.</Aviso></div>
        )}
      </Panel>
    </>
  );
}
