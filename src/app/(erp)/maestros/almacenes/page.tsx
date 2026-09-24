import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { crearAlmacenAccion } from './acciones';

export default async function AlmacenesPage() {
  const u = await exigirRol(...ROLES_VEN_PRODUCTOS);
  const esGerencia = tieneRol(u, ['gerencia']);
  const db = await getDb();
  const visibles = await almacenesVisibles(db, u);
  const [almacenes, sucursales] = await Promise.all([
    db.query<{ id: string; codigo: string; nombre: string; sucursal: string; es_comercial: boolean; permite_venta: boolean; activo: boolean; usuarios: number }>(
      `select a.id, a.codigo, a.nombre, s.nombre as sucursal, a.es_comercial, a.permite_venta, a.activo,
              (select count(*)::int from usuario_almacen ua where ua.almacen_id = a.id) as usuarios
         from almacen a join sucursal s on s.id = a.sucursal_id
        where a.id = any($1::uuid[]) order by a.codigo`, [visibles]),
    db.query<{ id: string; nombre: string }>('select id, nombre from sucursal where activa order by nombre'),
  ]);

  return (
    <>
      <Encabezado titulo="Almacenes"
        descripcion="Solo un almacén comercial vende. Quien solo tiene el rol Almacén ve únicamente los almacenes que Gerencia le asigna." />
      <Panel>
        <Tabla columnas={['Código', 'Nombre', 'Sucursal', 'Tipo', { t: 'Usuarios asignados', derecha: true }, 'Estado']}
          vacio={visibles.length ? 'No hay almacenes.' : 'No tiene almacenes asignados.'}>
          {almacenes.rows.map((a) => (
            <tr key={a.id}>
              <Celda mono>{esGerencia ? <Link href={`/maestros/almacenes/${a.id}`} className="text-acento hover:underline">{a.codigo}</Link> : a.codigo}</Celda>
              <Celda>{a.nombre}</Celda>
              <Celda className="text-texto-2">{a.sucursal}</Celda>
              <Celda className="text-texto-2">{a.es_comercial ? (a.permite_venta ? 'Comercial · vende' : 'Comercial · no vende') : 'Depósito o tránsito'}</Celda>
              <Celda derecha>{a.usuarios}</Celda>
              <Celda><Etiqueta tono={a.activo ? 'exito' : 'info'}>{a.activo ? 'activo' : 'inactivo'}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      {esGerencia && (
        <Panel titulo="Nuevo almacén" className="mt-5">
          {sucursales.rows.length === 0 ? (
            <p className="text-sm text-texto-2">Primero registre una sucursal en Configuración → Empresa y sucursales.</p>
          ) : (
            <Formulario accion={crearAlmacenAccion} className="grid gap-3 md:grid-cols-[8rem_1fr_1fr] md:items-end">
              <Campo etiqueta="Código"><input name="codigo" required maxLength={6} placeholder="01" className="campo font-mono uppercase" /></Campo>
              <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} className="campo" /></Campo>
              <Campo etiqueta="Sucursal">
                <select name="sucursal_id" required className="campo">{sucursales.rows.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>
              </Campo>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="es_comercial" defaultChecked /> Almacén comercial</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="permite_venta" defaultChecked /> Permite vender</label>
              <div className="md:text-right"><BotonEnviar>Registrar almacén</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>
      )}
    </>
  );
}
