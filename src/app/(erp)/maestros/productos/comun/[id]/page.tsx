import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';
import { NOMBRE_LINEA_CALIDAD, ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import { actualizarProductoBaseAccion, agregarAplicacionAccion, quitarAplicacionAccion } from '../../acciones';
import { UUID, categorias } from '../../datos';

/** Código común: el mismo artículo en todas sus marcas, con su aplicación vehicular. */
export default async function CodigoComunPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PRODUCTOS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const hoy = hoyCaracas();

  const { rows } = await db.query<{ codigo: string; descripcion: string; categoria_id: string | null; categoria: string | null }>(
    `select codigo, descripcion, categoria_id, fn_categoria_ruta(categoria_id) as categoria from producto_base where id = $1`, [id]);
  const b = rows[0];
  if (!b) notFound();

  const [productos, aplicaciones, grupos, cats] = await Promise.all([
    db.query<{ id: string; codigo: string; marca: string | null; linea_calidad: keyof typeof NOMBRE_LINEA_CALIDAD | null;
      pais_origen: string | null; estado: string; precio_a: string | null; precio_b: string | null; precio_d: string | null }>(
      `select p.id, p.codigo, m.nombre as marca, p.linea_calidad, p.pais_origen, p.estado,
              fn_precio(p.id, 'A', $2::date) as precio_a, fn_precio(p.id, 'B', $2::date) as precio_b, fn_precio(p.id, 'D', $2::date) as precio_d
         from producto p left join marca m on m.id = p.marca_id
        where p.producto_base_id = $1 order by m.nombre`, [id, hoy]),
    db.query<{ id: string; modelo: string; anio_desde: number | null; anio_hasta: number | null; motor: string | null }>(
      `select a.id, g.codigo || ' · ' || g.nombre as modelo, a.anio_desde, a.anio_hasta, a.motor
         from producto_base_aplicacion a join grupo_producto g on g.id = a.grupo_id
        where a.producto_base_id = $1 order by g.codigo, a.anio_desde nulls first`, [id]),
    db.query<{ id: string; nombre: string }>(`select id, codigo || ' · ' || nombre as nombre from grupo_producto where activo order by codigo`),
    categorias(db),
  ]);
  const esAlmacen = tieneRol(u, ['almacen']);
  const anios = (d: number | null, h: number | null) => (d ?? h ? `${d ?? '…'} – ${h ?? '…'}` : 'Todos');
  const precio = (v: string | null) => (v === null ? '—' : monto(v, '$'));

  return (
    <>
      <Encabezado titulo={`Código común ${b.codigo}`} descripcion={`${b.descripcion}${b.categoria ? ` · ${b.categoria}` : ''}`}>
        <Link href="/maestros/productos" className="text-sm text-texto-2 hover:text-texto">← Productos</Link>
      </Encabezado>

      <Panel titulo={`Marcas de este artículo (${productos.rows.length})`}>
        <Tabla columnas={['Código', 'Marca', 'Línea de calidad', 'Origen', { t: 'Lista A', derecha: true },
          { t: 'Lista B', derecha: true }, { t: 'Lista D', derecha: true }, 'Estado']} vacio="Aún no hay productos con este código común.">
          {productos.rows.map((p) => (
            <tr key={p.id}>
              <Celda mono><Link href={`/maestros/productos/${p.id}`} className="text-acento hover:underline">{p.codigo}</Link></Celda>
              <Celda>{p.marca ?? '—'}</Celda>
              <Celda className="text-texto-2">{p.linea_calidad ? NOMBRE_LINEA_CALIDAD[p.linea_calidad] : '—'}</Celda>
              <Celda mono className="text-texto-2">{p.pais_origen ?? '—'}</Celda>
              <Celda derecha>{precio(p.precio_a)}</Celda>
              <Celda derecha>{precio(p.precio_b)}</Celda>
              <Celda derecha>{precio(p.precio_d)}</Celda>
              <Celda><Etiqueta tono={p.estado === 'activo' ? 'exito' : 'info'}>{p.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Panel titulo="Aplicación vehicular">
          <Tabla columnas={['Modelo', 'Años', 'Motor', '']} vacio="Sin aplicaciones registradas.">
            {aplicaciones.rows.map((a) => (
              <tr key={a.id}>
                <Celda>{a.modelo}</Celda>
                <Celda>{anios(a.anio_desde, a.anio_hasta)}</Celda>
                <Celda className="text-texto-2">{a.motor ?? '—'}</Celda>
                <Celda>
                  {esAlmacen && (
                    <Formulario accion={quitarAplicacionAccion}>
                      <input type="hidden" name="base_id" value={id} />
                      <input type="hidden" name="aplicacion_id" value={a.id} />
                      <BotonEnviar variante="secundario">Quitar</BotonEnviar>
                    </Formulario>
                  )}
                </Celda>
              </tr>
            ))}
          </Tabla>
          {esAlmacen && (
            <Formulario accion={agregarAplicacionAccion} className="mt-4 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="base_id" value={id} />
              <Campo etiqueta="Modelo">
                <select name="grupo_id" required className="campo">
                  <option value="">Seleccione…</option>
                  {grupos.rows.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Motor (opcional)"><input name="motor" maxLength={30} className="campo uppercase" /></Campo>
              <Campo etiqueta="Año desde"><input name="anio_desde" inputMode="numeric" maxLength={4} className="campo" /></Campo>
              <Campo etiqueta="Año hasta"><input name="anio_hasta" inputMode="numeric" maxLength={4} className="campo" /></Campo>
              <div><BotonEnviar>Agregar aplicación</BotonEnviar></div>
            </Formulario>
          )}
        </Panel>

        {esAlmacen && (
          <Panel titulo="Datos del código común">
            <p className="mb-4 text-sm text-texto-2">La categoría se aplica a todos los productos de este código común.</p>
            <Formulario accion={actualizarProductoBaseAccion} className="space-y-4">
              <input type="hidden" name="base_id" value={id} />
              <Campo etiqueta="Descripción genérica">
                <input name="descripcion" defaultValue={b.descripcion} required maxLength={200} className="campo" />
              </Campo>
              <Campo etiqueta="Categoría">
                <select name="categoria_id" defaultValue={b.categoria_id ?? ''} className="campo">
                  <option value="">Sin categoría</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </Campo>
              <BotonEnviar>Guardar</BotonEnviar>
            </Formulario>
          </Panel>
        )}
      </div>
    </>
  );
}
