import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_VEN_TODO_COMISIONES, detallePlan } from '@/lib/comisiones/comisiones';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { decidirPlanAccion, enviarPlanAccion } from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { borrador: 'info', pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_TODO_COMISIONES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detallePlan(db, id);
  if (!d) notFound();
  const { plan } = d;
  const puedeDecidir = plan.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'plan_comision', id));

  return (
    <>
      <Encabezado titulo={plan.nombre} descripcion={`Creado por ${plan.creador}. Base de cálculo: lo cobrado, sin IVA ni IGTF.`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[plan.estado as keyof typeof TONO] ?? 'info'}>{plan.estado}</Etiqueta>
          <Link href="/comisiones/planes" className="text-sm text-texto-2 hover:text-texto">← Planes</Link>
        </div>
      </Encabezado>
      {plan.estado === 'pendiente' && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Quien creó el plan no lo aprueba.</Aviso></div>}
      {plan.estado === 'aprobado' && <div className="mb-5"><Aviso tono="exito">Aprobado por {plan.aprobador}. No se edita: un cambio es un plan nuevo.</Aviso></div>}
      {plan.estado === 'rechazado' && <div className="mb-5"><Aviso tono="peligro">Rechazado: {plan.rechazo_motivo}</Aviso></div>}

      <Panel titulo="Reglas, de la más específica a la más general" className="mb-5">
        <Tabla columnas={['Prioridad', 'Grupo de producto', 'Marca', { t: 'Porcentaje', derecha: true }]}>
          {d.reglas.map((r) => (
            <tr key={r.prioridad}>
              <Celda>{r.prioridad}</Celda><Celda>{r.grupo ?? 'Todos'}</Celda><Celda>{r.marca ?? 'Todas'}</Celda><Celda derecha>{Number(r.porcentaje).toFixed(2)} %</Celda>
            </tr>
          ))}
        </Tabla>
        <p className="mt-3 text-xs text-texto-2">Cada línea de la factura toma la primera regla que le corresponde; una línea sin regla no comisiona.</p>
      </Panel>

      {plan.estado === 'borrador' && plan.creado_por === u.id && (
        <Panel titulo="Enviar a aprobación">
          <Formulario accion={enviarPlanAccion} className="space-y-3">
            <input type="hidden" name="id" value={id} />
            <p className="text-sm text-texto-2">Enviado, el plan no se edita. Gerencia, distinta de quien lo creó, lo aprueba.</p>
            <BotonEnviar>Enviar a Gerencia</BotonEnviar>
          </Formulario>
        </Panel>
      )}
      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={decidirPlanAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="aprobada" />
              <BotonEnviar>Aprobar plan</BotonEnviar>
            </Formulario>
            <Formulario accion={decidirPlanAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="rechazada" />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar plan</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
