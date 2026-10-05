import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_AJUSTAN } from '@/lib/inventario/ajustes';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { crearAjusteAccion } from '../../acciones';

export default async function NuevoAjustePage() {
  const u = await exigirRol(...ROLES_AJUSTAN);
  const db = await getDb();
  const visibles = await almacenesVisibles(db, u);
  const [almacenes, usuarios] = await Promise.all([
    db.query<{ id: string; codigo: string; nombre: string }>(
      `select id, codigo, nombre from almacen where activo and id = any($1::uuid[]) order by codigo`, [visibles]).then((r) => r.rows),
    db.query<{ id: string; nombre: string }>(
      `select distinct u.id, u.nombre from usuario u join usuario_rol r on r.usuario_id = u.id
        where u.activo and r.rol in ('almacen', 'gerencia') order by u.nombre`).then((r) => r.rows),
  ]);

  return (
    <>
      <Encabezado titulo="Nuevo ajuste de inventario" descripcion="Indique el almacén y quién hizo el conteo; después agregue lo contado de cada producto.">
        <Link href="/inventario/ajustes" className="text-sm text-texto-2 hover:text-texto">← Ajustes</Link>
      </Encabezado>
      <Panel>
        {almacenes.length === 0 ? (
          <Aviso tono="advertencia">No tiene almacenes asignados. Gerencia puede asignárselos en Almacenes.</Aviso>
        ) : (
          <Formulario accion={crearAjusteAccion} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo etiqueta="Almacén">
                <select name="almacen_id" required defaultValue={almacenes.length === 1 ? almacenes[0].id : ''} className="campo">
                  <option value="" disabled>Seleccione…</option>
                  {almacenes.map((a) => <option key={a.id} value={a.id}>{a.codigo} · {a.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Conteo hecho por" ayuda="Quien cuenta no puede aprobar el ajuste. Si lo deja vacío, es usted.">
                <select name="contado_por" defaultValue="" className="campo">
                  <option value="">Yo</option>
                  {usuarios.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                </select>
              </Campo>
              <div className="sm:col-span-2">
                <Campo etiqueta="Observaciones"><textarea name="observaciones" rows={2} maxLength={300} className="campo" /></Campo>
              </div>
            </div>
            <div className="flex justify-end"><BotonEnviar>Crear ajuste</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>
    </>
  );
}
