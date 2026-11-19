import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { guardarProntoPagoAccion } from './acciones';

export default async function ProntoPagoPage() {
  await exigirRol('gerencia');
  const db = await getDb();
  const { rows } = await db.query<{ id: string; nombre: string; porcentaje: string | null; plazo: number | null }>(
    `select id, nombre, descuento_pronto_pago_pct::text as porcentaje, dias_pronto_pago as plazo
       from condicion_pago where activa order by dias, nombre`);

  return (
    <>
      <Encabezado titulo="Descuento por pronto pago" descripcion="El porcentaje y el plazo se guardan en las próximas facturas. Deje ambos campos vacíos para desactivar el descuento." />
      <div className="space-y-4">
        {rows.map((c) => (
          <Panel key={c.id} titulo={c.nombre}>
            <Formulario accion={guardarProntoPagoAccion} className="grid gap-3 md:grid-cols-3 md:items-end">
              <input type="hidden" name="id" value={c.id} />
              <Campo etiqueta="Descuento (%)"><input name="porcentaje" inputMode="decimal" defaultValue={c.porcentaje ?? ''} className="campo" /></Campo>
              <Campo etiqueta="Días desde la emisión"><input type="number" name="dias" min={0} max={365} defaultValue={c.plazo ?? ''} className="campo" /></Campo>
              <div><BotonEnviar>Guardar</BotonEnviar></div>
            </Formulario>
          </Panel>
        ))}
      </div>
    </>
  );
}
