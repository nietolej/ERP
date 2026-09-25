import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { PanelAdjuntos } from '@/components/panel-adjuntos';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, fechaHora, hoyCaracas, monto } from '@/lib/formato';
import { LISTAS, ROLES_PRECIOS, ROLES_VEN_PRODUCTOS } from '@/lib/maestros/productos';
import {
  actualizarProductoAccion, agregarReferenciaAccion, cambiarEstadoProductoAccion, fijarPrecioAccion, quitarReferenciaAccion,
} from '../acciones';
import { CamposProducto, UUID, opcionesProducto, type ValoresProducto } from '../datos';

export default async function ProductoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PRODUCTOS);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const hoy = hoyCaracas();

  const { rows } = await db.query<ValoresProducto & {
    codigo: string; estado: string; creador: string | null; created_at: Date; base_id: string | null; categoria: string | null;
  }>(
    `select p.codigo, b.codigo as codigo_comun, b.id as base_id, fn_categoria_ruta(p.categoria_id) as categoria,
            p.descripcion, p.grupo_id, p.marca_id, p.unidad, p.alicuota_iva_id, p.inventariable,
            p.codigo_alterno, p.peso_kg, p.linea_calidad, p.pais_origen, p.estado, u.nombre as creador, p.created_at
       from producto p
       left join producto_base b on b.id = p.producto_base_id
       left join usuario u on u.id = p.created_by where p.id = $1`, [id]);
  const p = rows[0];
  if (!p) notFound();

  const [op, refs, precios] = await Promise.all([
    opcionesProducto(db, hoy, [p.grupo_id, p.marca_id]),
    db.query<{ id: string; tipo: string; fabricante: string; referencia: string }>(
      'select id, tipo, fabricante, referencia from producto_referencia where producto_id = $1 order by tipo, fabricante, referencia', [id]),
    db.query<{ lista: string; precio: string; vigente_desde: string; autor: string | null; created_at: Date; vigente: boolean }>(
      `select pr.lista, pr.precio, pr.vigente_desde, u.nombre as autor, pr.created_at,
              pr.vigente_desde = (select max(x.vigente_desde) from precio x
                                   where x.producto_id = pr.producto_id and x.lista = pr.lista and x.vigente_desde <= $2::date) as vigente
         from precio pr left join usuario u on u.id = pr.created_by
        where pr.producto_id = $1 order by pr.lista, pr.vigente_desde desc`, [id, hoy]),
  ]);
  const esAlmacen = tieneRol(u, ['almacen']);
  const fijaPrecios = tieneRol(u, [...ROLES_PRECIOS]);
  const vigente = (lista: string) => precios.rows.find((x) => x.lista === lista && x.vigente);

  return (
    <>
      <Encabezado titulo={`${p.codigo} · ${p.descripcion}`}
        descripcion={`${p.categoria ? `${p.categoria} · ` : ''}Registrado por ${p.creador ?? '—'} · ${fechaHora(p.created_at)}`}>
        <div className="flex items-center gap-3">
          {p.base_id
            ? <Link href={`/maestros/productos/comun/${p.base_id}`} className="rounded-lg border border-borde bg-white/5 px-3 py-1.5 text-sm font-semibold hover:bg-white/10">Código común {p.codigo_comun}</Link>
            : <Etiqueta tono="advertencia">sin código común</Etiqueta>}
          <Etiqueta tono={p.estado === 'activo' ? 'exito' : 'info'}>{p.estado}</Etiqueta>
          <Link href="/maestros/productos" className="text-sm text-texto-2 hover:text-texto">← Productos</Link>
        </div>
      </Encabezado>

      <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
        <Panel titulo="Datos del producto">
          {esAlmacen ? (
            <Formulario accion={actualizarProductoAccion} className="space-y-5">
              <input type="hidden" name="id" value={id} />
              <CamposProducto op={op} v={p} />
              <div className="flex justify-end"><BotonEnviar>Guardar cambios</BotonEnviar></div>
            </Formulario>
          ) : <CamposProducto op={op} v={p} soloLectura />}
        </Panel>

        <div className="space-y-5">
          <Panel titulo="Precios vigentes hoy">
            <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-sm">
              {LISTAS.map((l) => {
                const v = vigente(l);
                return (
                  <div key={l} className="contents">
                    <dt className="text-texto-2">Lista {l}</dt>
                    <dd className="tabular-nums">{v ? `${monto(v.precio, '$')} desde ${fecha(v.vigente_desde)}` : 'Sin precio'}</dd>
                  </div>
                );
              })}
            </dl>
            {fijaPrecios && (
              <Formulario accion={fijarPrecioAccion} className="mt-5 grid grid-cols-2 gap-3">
                <input type="hidden" name="id" value={id} />
                <Campo etiqueta="Lista">
                  <select name="lista" className="campo">{LISTAS.map((l) => <option key={l} value={l}>{l}</option>)}</select>
                </Campo>
                <Campo etiqueta="Precio (USD)">
                  <input name="precio" required inputMode="decimal" placeholder="0.00" className="campo text-right tabular-nums" />
                </Campo>
                <Campo etiqueta="Rige desde">
                  <input type="date" name="vigente_desde" required defaultValue={hoy} min={hoy} className="campo" />
                </Campo>
                <div className="self-end"><BotonEnviar>Registrar precio</BotonEnviar></div>
              </Formulario>
            )}
          </Panel>

          {esAlmacen && (
            <Panel titulo="Estado">
              <p className="mb-3 text-sm text-texto-2">Un producto no se borra: se inactiva y deja de ofrecerse.</p>
              <Formulario accion={cambiarEstadoProductoAccion}>
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="estado" value={p.estado === 'activo' ? 'inactivo' : 'activo'} />
                <BotonEnviar variante="secundario">{p.estado === 'activo' ? 'Inactivar' : 'Reactivar'}</BotonEnviar>
              </Formulario>
            </Panel>
          )}
        </div>
      </div>

      <Panel titulo="Referencias cruzadas" className="mt-5">
        <Tabla columnas={['Tipo', 'Fabricante', 'Referencia', esAlmacen ? '' : ' ']} vacio="Sin referencias registradas.">
          {refs.rows.map((r) => (
            <tr key={r.id}>
              <Celda><Etiqueta tono={r.tipo === 'oem' ? 'info' : 'advertencia'}>{r.tipo === 'oem' ? 'OEM' : 'Alterna'}</Etiqueta></Celda>
              <Celda>{r.fabricante}</Celda>
              <Celda mono>{r.referencia}</Celda>
              <Celda>
                {esAlmacen && (
                  <Formulario accion={quitarReferenciaAccion}>
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="referencia_id" value={r.id} />
                    <BotonEnviar variante="secundario">Quitar</BotonEnviar>
                  </Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
        {esAlmacen && (
          <Formulario accion={agregarReferenciaAccion} className="mt-4 grid gap-3 sm:grid-cols-[9rem_1fr_1fr_auto] sm:items-end">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Tipo">
              <select name="tipo" className="campo"><option value="oem">OEM</option><option value="alterna">Alterna</option></select>
            </Campo>
            <Campo etiqueta="Fabricante"><input name="fabricante" required maxLength={60} className="campo uppercase" /></Campo>
            <Campo etiqueta="Referencia"><input name="referencia" required maxLength={40} className="campo font-mono uppercase" /></Campo>
            <div><BotonEnviar>Agregar</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>

      <Panel titulo="Historial de precios" className="mt-5">
        <Tabla columnas={['Lista', { t: 'Precio', derecha: true }, 'Rige desde', 'Registrado por', '']} vacio="Sin precios registrados.">
          {precios.rows.map((x) => (
            <tr key={`${x.lista}-${x.vigente_desde}`}>
              <Celda>{x.lista}</Celda>
              <Celda derecha>{monto(x.precio, '$')}</Celda>
              <Celda>{fecha(x.vigente_desde)}</Celda>
              <Celda className="text-texto-2">{x.autor ?? '—'} · {fechaHora(x.created_at)}</Celda>
              <Celda>{x.vigente ? <Etiqueta tono="exito">vigente</Etiqueta> : x.vigente_desde > hoy ? <Etiqueta tono="info">programado</Etiqueta> : null}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      <PanelAdjuntos tipo="producto" entidadId={id} usuario={u} className="mt-5" />
    </>
  );
}
