import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { actualizarAlmacenAccion, asignarUsuariosAccion, fijarObjetivosPickingAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AlmacenPage({ params }: { params: Promise<{ id: string }> }) {
  await exigirRol('gerencia');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const { rows } = await db.query<{ codigo: string; nombre: string; sucursal_id: string; es_comercial: boolean; permite_venta: boolean; usa_picking: boolean; activo: boolean }>(
    'select codigo, nombre, sucursal_id, es_comercial, permite_venta, usa_picking, activo from almacen where id = $1', [id]);
  const a = rows[0];
  if (!a) notFound();
  const objetivos = (await db.query<{ prioridad: number; horas: string }>(
    'select prioridad, horas::text from almacen_picking_objetivo where almacen_id = $1', [id])).rows;
  const [sucursales, usuarios] = await Promise.all([
    db.query<{ id: string; nombre: string }>('select id, nombre from sucursal where activa or id = $1 order by nombre', [a.sucursal_id]),
    db.query<{ id: string; nombre: string; email: string; asignado: boolean }>(
      `select u.id, u.nombre, u.email, exists (select 1 from usuario_almacen x where x.usuario_id = u.id and x.almacen_id = $1) as asignado
         from usuario u
        where u.activo and exists (select 1 from usuario_rol r where r.usuario_id = u.id and r.rol = 'almacen')
        order by u.nombre`, [id]),
  ]);

  return (
    <>
      <Encabezado titulo={`Almacén ${a.codigo} · ${a.nombre}`}>
        <Link href="/maestros/almacenes" className="text-sm text-texto-2 hover:text-texto">← Almacenes</Link>
      </Encabezado>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Datos">
          <Formulario accion={actualizarAlmacenAccion} className="space-y-4">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Nombre"><input name="nombre" defaultValue={a.nombre} required maxLength={80} className="campo" /></Campo>
            <Campo etiqueta="Sucursal">
              <select name="sucursal_id" defaultValue={a.sucursal_id} className="campo">
                {sucursales.rows.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
              </select>
            </Campo>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="es_comercial" defaultChecked={a.es_comercial} /> Almacén comercial</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="permite_venta" defaultChecked={a.permite_venta} /> Permite vender</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="usa_picking" defaultChecked={a.usa_picking} /> Usa picking y empaque</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="activo" defaultChecked={a.activo} /> Activo</label>
            </div>
            <BotonEnviar>Guardar</BotonEnviar>
          </Formulario>
        </Panel>
        <Panel titulo="Objetivo de picking (horas)">
          <Formulario accion={fijarObjetivosPickingAccion} className="space-y-3">
            <input type="hidden" name="id" value={id} />
            <p className="text-sm text-texto-2">Horas máximas entre la creación de la orden y su empaque, por prioridad (1 = más urgente). Vacío = sin objetivo.</p>
            <div className="grid grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map((p) => (
                <Campo key={p} etiqueta={`Prioridad ${p}`}>
                  <input name={`horas_${p}`} inputMode="decimal" className="campo" defaultValue={objetivos.find((o) => o.prioridad === p)?.horas.replace(/\.?0+$/, '') ?? ''} />
                </Campo>
              ))}
            </div>
            <BotonEnviar variante="secundario">Guardar objetivos</BotonEnviar>
          </Formulario>
        </Panel>
        <Panel titulo="Usuarios de Almacén que lo ven">
          {usuarios.rows.length === 0 ? (
            <p className="text-sm text-texto-2">No hay usuarios activos con el rol Almacén.</p>
          ) : (
            <Formulario accion={asignarUsuariosAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              {usuarios.rows.map((x) => (
                <label key={x.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="usuarios" value={x.id} defaultChecked={x.asignado} /> {x.nombre}
                  <span className="text-texto-2">{x.email}</span>
                </label>
              ))}
              <BotonEnviar variante="secundario">Guardar asignación</BotonEnviar>
            </Formulario>
          )}
        </Panel>
      </div>
    </>
  );
}
