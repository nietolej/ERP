import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirSesion, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { monto } from '@/lib/formato';
import { NOMBRE_ESTADO_REPOSICION, NOMBRE_TIPO_REPOSICION, detalleFondo, detalleReposicion, valesDeReposicion, veFondo } from '@/lib/gastos/caja-chica';
import { aprobarReposicionAccion, rechazarReposicionAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { pendiente: 'advertencia', aprobada: 'exito', rechazada: 'peligro' } as const;

export default async function ReposicionPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirSesion();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const r = await detalleReposicion(db, id);
  if (!r) notFound();
  const f = await detalleFondo(db, r.fondo_id);
  if (!f || !veFondo(u, f)) notFound();

  const vales = r.tipo === 'reposicion' ? await valesDeReposicion(db, id) : [];
  const pendiente = r.estado === 'pendiente';
  const puedeDecidir = pendiente && (await puedeDecidirObjeto(db, u.id, 'reposicion_caja', id));
  const titulo = NOMBRE_TIPO_REPOSICION[r.tipo];

  return (
    <>
      <Encabezado titulo={`${titulo} N° ${r.numero}`} descripcion={r.fondo}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[r.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_REPOSICION[r.estado] ?? r.estado}</Etiqueta>
          <Link href={`/caja-chica/${r.fondo_id}`} className="text-sm text-texto-2 hover:text-texto">← Fondo</Link>
        </div>
      </Encabezado>

      {pendiente && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Mientras no se apruebe no sale dinero del banco ni hay asiento.</Aviso></div>}
      {pendiente && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe decidir otra persona de Gerencia: quien lo solicitó ({r.creador}) no lo aprueba.</Aviso></div>
      )}
      {r.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {r.rechazo_motivo}</Aviso></div>}
      {r.estado === 'aprobada' && <div className="mb-5"><Aviso tono="exito">Aprobada por {r.aprobado_por} el {r.aprobado}. Asiento {r.asiento ?? '—'}.</Aviso></div>}

      <Panel titulo="Datos">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Monto</dt><dd className="font-mono text-lg">{r.moneda} {monto(r.monto)}</dd></div>
          <div><dt className="text-texto-2">El dinero sale de</dt><dd>{r.cuenta_origen}</dd></div>
          <div><dt className="text-texto-2">Referencia</dt><dd className="font-mono">{r.referencia ?? '—'}</dd></div>
          <div><dt className="text-texto-2">Solicitó</dt><dd>{r.creador} · {r.creado}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-texto-2">
          {r.tipo === 'constitucion' ? 'Al aprobar, el dinero pasa del banco a la caja y el fondo queda en su monto fijo.' : 'Al aprobar, el dinero pasa del banco a la caja, los vales quedan repuestos y el fondo vuelve a su monto fijo.'}
        </p>
      </Panel>

      {r.tipo === 'reposicion' && (
        <Panel titulo={`Vales que repone (${vales.length})`} className="mt-5">
          <Tabla columnas={['N°', 'Fecha', 'Categoría', 'Pagado a', { t: 'Total', derecha: true }, 'Estado']} vacio="Sin vales.">
            {vales.map((v) => (
              <tr key={v.id}>
                <Celda mono>{v.numero}</Celda>
                <Celda className="text-texto-2">{v.fecha}</Celda>
                <Celda>{v.categoria}<span className="block text-xs text-texto-2">{v.descripcion}</span></Celda>
                <Celda>{v.beneficiario}</Celda>
                <Celda derecha mono>{v.moneda} {monto(v.total)}</Celda>
                <Celda className="text-texto-2">{v.estado}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      )}

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarReposicionAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="fondo_id" value={r.fondo_id} />
              <p className="text-sm text-texto-2">Al aprobar el dinero entra a la caja y se contabiliza, todo en el mismo acto.</p>
              <BotonEnviar>Aprobar</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarReposicionAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="fondo_id" value={r.fondo_id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
