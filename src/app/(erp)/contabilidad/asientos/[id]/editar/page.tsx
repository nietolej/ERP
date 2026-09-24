import { notFound, redirect } from 'next/navigation';
import { Encabezado, Panel } from '@/components/ui';
import { FormularioAsiento } from '@/components/formulario-asiento';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { guardarAsiento } from '../../acciones';
import { cuentasParaManual, monedasActivas, UUID } from '../../datos';

export default async function EditarAsientoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol('contabilidad');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();

  const { rows } = await db.query<{ fecha: string; descripcion: string; estado: string; tipo: string; created_by: string }>(
    'select fecha, descripcion, estado, tipo, created_by from asiento where id = $1', [id]);
  const a = rows[0];
  if (!a || a.tipo !== 'manual') notFound();
  if (a.estado !== 'borrador' || a.created_by !== u.id) redirect(`/contabilidad/asientos/${id}`);

  // Las líneas de redondeo (monto original 0) las recalcula el sistema al guardar.
  const { rows: lineas } = await db.query<{ cuenta_id: string; al_debe: boolean; monto_original: string; moneda_original: string; glosa: string | null }>(
    `select cuenta_id, (debe_ves > 0 or debe_usd > 0) as al_debe, monto_original, moneda_original, glosa
       from asiento_linea where asiento_id = $1 and monto_original > 0 order by id`, [id]);
  const [cuentas, monedas] = await Promise.all([cuentasParaManual(db), monedasActivas(db)]);

  return (
    <>
      <Encabezado titulo="Corregir borrador" descripcion={a.descripcion} />
      <Panel>
        <FormularioAsiento accion={guardarAsiento} cuentas={cuentas} monedas={monedas}
          inicial={{
            id,
            fecha: a.fecha,
            descripcion: a.descripcion,
            moneda: lineas[0]?.moneda_original ?? 'VES',
            lineas: lineas.map((l) => ({
              cuentaId: l.cuenta_id,
              debe: l.al_debe ? l.monto_original : '',
              haber: l.al_debe ? '' : l.monto_original,
              glosa: l.glosa ?? '',
            })),
          }} />
      </Panel>
    </>
  );
}
