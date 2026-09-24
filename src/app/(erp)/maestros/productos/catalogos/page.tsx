import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { crearCatalogoAccion, crearCategoriaAccion } from '../acciones';
import { categorias } from '../datos';

export default async function CatalogosPage() {
  const u = await exigirRol(...ROLES_VEN_PRODUCTOS);
  const esAlmacen = tieneRol(u, ['almacen']);
  const db = await getDb();
  const cats = await categorias(db);
  const { rows: usoCategorias } = await db.query<{ id: string; codigo: string; bases: number }>(
    `select c.id, c.codigo, (select count(*)::int from producto_base b where b.categoria_id = c.id) as bases
       from categoria_producto c`);
  const [grupos, marcas] = await Promise.all(['grupo_producto', 'marca'].map((t) =>
    db.query<{ id: string; codigo: string; nombre: string; productos: number }>(
      `select c.id, c.codigo, c.nombre,
              (select count(*)::int from producto p where p.${t === 'marca' ? 'marca_id' : 'grupo_id'} = c.id) as productos
         from ${t} c order by c.codigo`)));

  const bloque = (titulo: string, tabla: 'grupo_producto' | 'marca', filas: typeof grupos.rows, ejemplo: string) => (
    <Panel titulo={titulo}>
      <Tabla columnas={['Código', 'Nombre', { t: 'Productos', derecha: true }]} vacio="Sin registros.">
        {filas.map((f) => (
          <tr key={f.id}><Celda mono>{f.codigo}</Celda><Celda>{f.nombre}</Celda><Celda derecha>{f.productos}</Celda></tr>
        ))}
      </Tabla>
      {esAlmacen && (
        <Formulario accion={crearCatalogoAccion} className="mt-4 grid gap-3 sm:grid-cols-[9rem_1fr_auto] sm:items-end">
          <input type="hidden" name="tabla" value={tabla} />
          <Campo etiqueta="Código"><input name="codigo" required maxLength={20} placeholder={ejemplo} className="campo uppercase" /></Campo>
          <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} className="campo" /></Campo>
          <div><BotonEnviar>Agregar</BotonEnviar></div>
        </Formulario>
      )}
    </Panel>
  );

  return (
    <>
      <Encabezado titulo="Categorías, grupos y marcas" descripcion="La categoría clasifica el artículo (Frenos › Pastillas); el grupo es el modelo de vehículo (TUCSON, RIO).">
        <Link href="/maestros/productos" className="text-sm text-texto-2 hover:text-texto">← Productos</Link>
      </Encabezado>
      <Panel titulo="Categorías" className="mb-5">
        <Tabla columnas={['Código', 'Categoría', { t: 'Códigos comunes', derecha: true }]} vacio="Sin categorías.">
          {cats.map((c) => {
            const uso = usoCategorias.find((x) => x.id === c.id);
            return (<tr key={c.id}><Celda mono>{uso?.codigo}</Celda><Celda>{c.nombre}</Celda><Celda derecha>{uso?.bases ?? 0}</Celda></tr>);
          })}
        </Tabla>
        {esAlmacen && (
          <Formulario accion={crearCategoriaAccion} className="mt-4 grid gap-3 sm:grid-cols-[9rem_1fr_1fr_auto] sm:items-end">
            <Campo etiqueta="Código"><input name="codigo" required maxLength={20} placeholder="FRENOS" className="campo uppercase" /></Campo>
            <Campo etiqueta="Nombre"><input name="nombre" required maxLength={80} className="campo" /></Campo>
            <Campo etiqueta="Dentro de">
              <select name="padre_id" defaultValue="" className="campo">
                <option value="">(categoría principal)</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </Campo>
            <div><BotonEnviar>Agregar</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        {bloque('Grupos (modelos de vehículo)', 'grupo_producto', grupos.rows, 'TUCSON')}
        {bloque('Marcas', 'marca', marcas.rows, 'MOBIS')}
      </div>
    </>
  );
}
