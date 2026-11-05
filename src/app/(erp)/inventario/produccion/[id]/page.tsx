import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { monto } from '@/lib/formato';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { NOMBRE_ESTADO_ORDEN, ROLES_PRODUCEN, ROLES_VEN_PRODUCCION, detalleOrden, productosInventariables } from '@/lib/produccion/ordenes';
import {
  anularOrdenAccion, aprobarOrdenAccion, eliminarBorradorAccion, enviarOrdenAccion, guardarComponenteAccion, iniciarOrdenAccion, quitarComponenteAccion, rechazarOrdenAccion,
  terminarOrdenAccion,
} from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { borrador: 'info', pendiente: 'advertencia', liberada: 'info', en_proceso: 'advertencia', terminada: 'exito', rechazada: 'peligro', anulada: 'peligro' } as const;

export default async function OrdenProduccionPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PRODUCCION);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleOrden(db, id);
  if (!d || !(await almacenesVisibles(db, u)).includes(d.almacen_id)) notFound();

  const opera = tieneRol(u, ROLES_PRODUCEN);
  const borrador = d.estado === 'borrador';
  const activa = ['borrador', 'pendiente', 'liberada', 'en_proceso'].includes(d.estado);
  const puedeDecidir = d.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'orden_produccion', id));
  const productos = borrador && opera ? await productosInventariables(db) : [];
  const faltan = d.estado === 'en_proceso' ? d.componentes_detalle.filter((c) => Number(c.disponible) < Number(c.cantidad)) : [];

  return (
    <>
      <Encabezado titulo={`Orden de producción N° ${d.numero}`} descripcion={`${d.producto} × ${Number(d.cantidad)} · almacén ${d.almacen}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_ORDEN[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/inventario/produccion" className="text-sm text-texto-2 hover:text-texto">← Órdenes</Link>
        </div>
      </Encabezado>

      {d.estado === 'pendiente' && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Liberar no reserva ni mueve nada: la existencia se verifica al terminar.</Aviso></div>}
      {d.estado === 'pendiente' && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">La debe liberar otra persona de Gerencia: quien creó la orden ({d.creador}) no la libera.</Aviso></div>
      )}
      {d.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'anulada' && <div className="mb-5"><Aviso tono="peligro">Anulada: {d.anulado_motivo}</Aviso></div>}
      {d.estado === 'terminada' && (
        <div className="mb-5"><Aviso tono="exito">Terminada por {d.terminada_por} el {d.terminada}. El producto entró al costo de US$ {monto(d.costo_unitario_usd ?? '0')} por unidad (US$ {monto(d.costo_total_usd ?? '0')} en total).</Aviso></div>
      )}
      {faltan.length > 0 && (
        <div className="mb-5"><Aviso tono="advertencia">No se puede terminar todavía: falta existencia disponible de {faltan.map((c) => `${c.codigo} (necesita ${Number(c.cantidad)}, hay ${Number(c.disponible)})`).join('; ')}.</Aviso></div>
      )}

      <Panel titulo="Componentes">
        <Tabla columnas={['Producto', { t: 'Cantidad', derecha: true }, ...(d.estado !== 'terminada' ? [{ t: 'Disponible en el almacén', derecha: true }] : [{ t: 'Costo consumido (US$)', derecha: true }]), '']} vacio="Todavía no hay componentes.">
          {d.componentes_detalle.map((c) => (
            <tr key={c.id}>
              <Celda><span className="font-mono">{c.codigo}</span><span className="block text-xs text-texto-2">{c.descripcion}</span></Celda>
              <Celda derecha mono>{Number(c.cantidad)}</Celda>
              {d.estado !== 'terminada'
                ? <Celda derecha mono className={Number(c.disponible) < Number(c.cantidad) ? 'text-peligro' : ''}>{Number(c.disponible)}</Celda>
                : <Celda derecha mono>{monto(c.costo_total_usd ?? '0')}</Celda>}
              <Celda>
                {borrador && opera && (
                  <Formulario accion={quitarComponenteAccion}><input type="hidden" name="id" value={id} /><input type="hidden" name="componente_id" value={c.id} /><BotonEnviar variante="peligro">Quitar</BotonEnviar></Formulario>
                )}
              </Celda>
            </tr>
          ))}
        </Tabla>
        {borrador && opera && (
          <Formulario accion={guardarComponenteAccion} className="mt-5 grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Agregar componente (si ya está, cambia su cantidad)">
              <select name="producto_id" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {productos.filter((p) => p.id !== d.producto_id).map((p) => <option key={p.id} value={p.id}>{p.texto}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Cantidad total"><input name="cantidad" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
            <BotonEnviar>Guardar componente</BotonEnviar>
          </Formulario>
        )}
      </Panel>

      {d.observaciones && <p className="mt-3 text-sm text-texto-2">Observaciones: {d.observaciones}</p>}

      {opera && activa && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {borrador && d.componentes > 0 && <Formulario accion={enviarOrdenAccion}><input type="hidden" name="id" value={id} /><BotonEnviar>Enviar a Gerencia</BotonEnviar></Formulario>}
            {borrador && <Formulario accion={eliminarBorradorAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>}
            {d.estado === 'liberada' && <Formulario accion={iniciarOrdenAccion}><input type="hidden" name="id" value={id} /><BotonEnviar>Poner en proceso</BotonEnviar></Formulario>}
            {d.estado === 'en_proceso' && (
              <Formulario accion={terminarOrdenAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-sm text-xs text-texto-2">Al terminar salen los componentes al costo promedio y entra el producto terminado, todo en el mismo acto.</p>
                <BotonEnviar>Terminar orden</BotonEnviar>
              </Formulario>
            )}
            {!borrador && (
              <details>
                <summary className="cursor-pointer text-sm text-texto-2 hover:text-texto">Anular orden</summary>
                <Formulario accion={anularOrdenAccion} className="mt-2 space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <input name="motivo" required minLength={3} maxLength={200} placeholder="Motivo" aria-label="Motivo de la anulación" className="campo" />
                  <BotonEnviar variante="peligro">Anular</BotonEnviar>
                </Formulario>
              </details>
            )}
          </div>
        </Panel>
      )}

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarOrdenAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <BotonEnviar>Liberar orden</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarOrdenAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
