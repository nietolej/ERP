import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ROLES_PRODUCEN, productosInventariables } from '@/lib/produccion/ordenes';
import { crearOrdenAccion } from '../acciones';

export default async function NuevaOrdenPage() {
  const u = await exigirRol(...ROLES_PRODUCEN);
  const db = await getDb();
  const visibles = await almacenesVisibles(db, u);
  const [productos, { rows: almacenes }] = await Promise.all([
    productosInventariables(db),
    db.query<{ id: string; texto: string }>(`select id, codigo || ' · ' || nombre as texto from almacen where activo and id = any($1::uuid[]) order by codigo`, [visibles]),
  ]);

  return (
    <>
      <Encabezado titulo="Nueva orden de producción" descripcion="Primero el producto terminado y el almacén; los componentes se agregan en el borrador.">
        <Link href="/inventario/produccion" className="text-sm text-texto-2 hover:text-texto">← Órdenes</Link>
      </Encabezado>
      {almacenes.length === 0 && <Aviso tono="advertencia">No tiene almacenes asignados.</Aviso>}
      <Panel>
        <Formulario accion={crearOrdenAccion} className="grid gap-4 sm:grid-cols-3">
          <Campo etiqueta="Producto terminado">
            <select name="producto_id" required defaultValue="" className="campo">
              <option value="" disabled>Seleccione…</option>
              {productos.map((p) => <option key={p.id} value={p.id}>{p.texto}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Cantidad a producir"><input name="cantidad" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
          <Campo etiqueta="Almacén" ayuda="De aquí salen los componentes y aquí entra el terminado.">
            <select name="almacen_id" required defaultValue="" className="campo">
              <option value="" disabled>Seleccione…</option>
              {almacenes.map((a) => <option key={a.id} value={a.id}>{a.texto}</option>)}
            </select>
          </Campo>
          <div className="sm:col-span-3"><Campo etiqueta="Observaciones (opcional)"><input name="observaciones" maxLength={300} className="campo" /></Campo></div>
          <div className="sm:col-span-3"><BotonEnviar>Crear borrador</BotonEnviar></div>
        </Formulario>
      </Panel>
    </>
  );
}
