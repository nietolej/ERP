import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_GESTIONAN_ACTIVOS, ROLES_VEN_ACTIVOS, detalleActivo } from '@/lib/contabilidad/activos';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import { decidirActivoAccion, solicitarBajaAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { pendiente: 'advertencia', activo: 'exito', depreciado: 'info', dado_de_baja: 'peligro', rechazado: 'peligro' } as const;

function Decision({ id, tipo, texto }: { id: string; tipo: 'alta' | 'baja'; texto: string }) {
  return (
    <Panel titulo="Decisión de Gerencia" className="mb-5">
      <div className="grid gap-6 md:grid-cols-2">
        <Formulario accion={decidirActivoAccion} className="space-y-3">
          <input type="hidden" name="id" value={id} /><input type="hidden" name="tipo" value={tipo} /><input type="hidden" name="decision" value="aprobada" />
          <p className="text-sm text-texto-2">{texto}</p>
          <BotonEnviar>Aprobar</BotonEnviar>
        </Formulario>
        <Formulario accion={decidirActivoAccion} className="space-y-3">
          <input type="hidden" name="id" value={id} /><input type="hidden" name="tipo" value={tipo} /><input type="hidden" name="decision" value="rechazada" />
          <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
          <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
        </Formulario>
      </div>
    </Panel>
  );
}

export default async function ActivoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_ACTIVOS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleActivo(db, id);
  if (!d) notFound();
  const a = d.activo;
  const puedeAlta = a.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'activo_fijo', id));
  const puedeBaja = d.baja?.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'baja_activo_fijo', d.baja.id));

  return (
    <>
      <Encabezado titulo={`${a.codigo} · ${a.descripcion}`} descripcion={`${a.categoria} · adquirido el ${fecha(a.fecha_adquisicion)} · registrado por ${a.creador}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[a.estado as keyof typeof TONO] ?? 'info'}>{a.estado.replace(/_/g, ' ')}</Etiqueta>
          <Link href="/contabilidad/activos" className="text-sm text-texto-2 hover:text-texto">← Activos</Link>
        </div>
      </Encabezado>
      {a.estado === 'pendiente' && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia: quien lo registró no lo aprueba.</Aviso></div>}
      {a.estado === 'rechazado' && <div className="mb-5"><Aviso tono="peligro">Rechazado: {a.rechazo_motivo}</Aviso></div>}
      {a.aprobador && <div className="mb-5"><Aviso tono="exito">Aprobado por {a.aprobador}. Asiento de alta {a.asiento}.</Aviso></div>}

      <Panel titulo="Valores" className="mb-5">
        <dl className="grid gap-3 text-sm md:grid-cols-4">
          <div><dt className="text-texto-2">Costo</dt><dd className="font-semibold">Bs {monto(a.costo_ves)} · US$ {monto(a.costo_usd)}</dd></div>
          <div><dt className="text-texto-2">Depreciación acumulada</dt><dd className="font-semibold">Bs {monto(a.depreciacion_ves)} · US$ {monto(a.depreciacion_usd)}</dd></div>
          <div><dt className="text-texto-2">Valor en libros</dt><dd className="font-semibold">Bs {monto(a.valor_libros_ves)}</dd></div>
          <div><dt className="text-texto-2">Vida útil · valor residual</dt><dd className="font-semibold">{a.vida_util_meses} meses ({a.meses_apertura} al arranque) · Bs {monto(a.residual_ves)}</dd></div>
        </dl>
      </Panel>

      <Panel titulo="Cuotas de depreciación" className="mb-5">
        <Tabla columnas={['Mes', { t: 'Bs', derecha: true }, { t: 'US$', derecha: true }, 'Asiento']} vacio="Todavía no tiene cuotas posteriores al arranque.">
          {d.cuotas.map((c) => <tr key={c.periodo}><Celda>{c.periodo}</Celda><Celda derecha>{monto(c.monto_ves)}</Celda><Celda derecha>{monto(c.monto_usd)}</Celda><Celda mono>{c.asiento}</Celda></tr>)}
        </Tabla>
      </Panel>

      {puedeAlta && <Decision id={id} tipo="alta" texto="Al aprobar se contabiliza el costo y la depreciación acumulada contra «Saldos de apertura»." />}
      {d.baja && (
        <div className="mb-5"><Aviso tono={d.baja.estado === 'aprobada' ? 'info' : 'advertencia'}>Baja {d.baja.numero} del {fecha(d.baja.fecha)} ({d.baja.estado}), solicitada por {d.baja.creador}: {d.baja.motivo}</Aviso></div>
      )}
      {puedeBaja && d.baja && <Decision id={d.baja.id} tipo="baja" texto="Al aprobar sale el costo y la depreciación acumulada, y la diferencia va a pérdida por baja." />}
      {['activo', 'depreciado'].includes(a.estado) && !d.baja && tieneRol(u, ROLES_GESTIONAN_ACTIVOS) && (
        <Panel titulo="Dar de baja">
          <Formulario accion={solicitarBajaAccion} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="activo_id" value={id} />
            <Campo etiqueta="Fecha de la baja"><input type="date" name="fecha" defaultValue={hoyCaracas()} required className="campo" /></Campo>
            <Campo etiqueta="Motivo"><input name="motivo" required minLength={3} maxLength={200} className="campo w-80" /></Campo>
            <BotonEnviar variante="peligro">Solicitar la baja</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Antes de la baja deben estar depreciados los meses anteriores a su fecha. Gerencia, distinta de quien la solicita, la aprueba.</p>
        </Panel>
      )}
    </>
  );
}
