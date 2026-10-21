import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, hoyCaracas, monto } from '@/lib/formato';
import {
  NOMBRE_TIPO_ALCANCE, NOMBRE_TIPO_PROMOCION, ROLES_CREAN_PROMOCIONES, ROLES_VEN_PROMOCIONES, TEXTO_PROMOCION, TIPOS_ALCANCE,
  TIPOS_PROMOCION, TONO_PROMOCION, detallePromocion,
} from '@/lib/ventas/promociones';
import {
  agregarAlcanceAccion, anularPromocionAccion, aprobarPromocionAccion, editarPromocionAccion, enviarAprobacionAccion,
  quitarAlcanceAccion, rechazarPromocionAccion,
} from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return <div><dt className="text-texto-2">{etiqueta}</dt><dd>{children === null || children === undefined || children === '' ? '—' : children}</dd></div>;
}

export default async function PromocionPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PROMOCIONES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const p = await detallePromocion(db, id);
  if (!p) notFound();

  const puedeEditar = tieneRol(u, [...ROLES_CREAN_PROMOCIONES]);
  const borrador = p.estado === 'borrador';
  const puedeDecidir = p.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'promocion', id));
  const especial = p.tipo === 'precio_especial';
  const hoy = hoyCaracas();

  return (
    <>
      <Encabezado titulo={`${p.codigo} · ${p.nombre}`} descripcion={p.descripcion ?? undefined}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO_PROMOCION[p.estado]}>{TEXTO_PROMOCION[p.estado]}</Etiqueta>
          <Link href="/ventas/promociones" className="text-sm text-texto-2 hover:text-texto">← Promociones</Link>
        </div>
      </Encabezado>

      {p.estado === 'pendiente' && !puedeDecidir && <div className="mb-5"><Aviso>Espera la aprobación de Gerencia (una persona distinta de quien la creó).</Aviso></div>}
      {p.estado === 'rechazada' && <div className="mb-5"><Aviso tono="peligro">Rechazada: {p.rechazo_motivo}</Aviso></div>}
      {p.estado === 'anulada' && <div className="mb-5"><Aviso tono="peligro">Anulada: {p.anulado_motivo}</Aviso></div>}
      {p.estado === 'aprobada' && p.vigente_desde > hoy && <div className="mb-5"><Aviso>Aprobada. Empieza a aplicarse el {fecha(p.vigente_desde)}.</Aviso></div>}

      <Panel titulo="Condiciones">
        <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-3">
          <Dato etiqueta="Tipo">{NOMBRE_TIPO_PROMOCION[p.tipo]}</Dato>
          <Dato etiqueta="Descuento">{p.descuento_pct ? `${Number(p.descuento_pct)} %` : especial ? 'Precio fijo por producto' : null}</Dato>
          <Dato etiqueta="Compra mínima por línea">{p.cantidad_minima ? Number(p.cantidad_minima) : 'Sin mínimo'}</Dato>
          <Dato etiqueta="Vigencia">{fecha(p.vigente_desde)} → {fecha(p.vigente_hasta)}</Dato>
          <Dato etiqueta="Creada por">{p.creador}</Dato>
          <Dato etiqueta="Aprobada por">{p.aprobador}</Dato>
        </dl>
        <p className="mt-3 text-xs text-texto-2">
          En el pedido se aplica sola cuando deja un precio neto menor que el del cliente (el descuento pactado y la promoción no se acumulan). Un descuento escrito a mano no usa promoción.
        </p>
        {borrador && puedeEditar && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold text-acento hover:underline">Cambiar condiciones</summary>
            <Formulario accion={editarPromocionAccion} className="mt-3 grid gap-3 md:grid-cols-3 md:items-end">
              <input type="hidden" name="id" value={p.id} />
              <Campo etiqueta="Nombre"><input name="nombre" required maxLength={100} defaultValue={p.nombre} className="campo" /></Campo>
              <Campo etiqueta="Tipo">
                <select name="tipo" defaultValue={p.tipo} className="campo">{TIPOS_PROMOCION.map((t) => <option key={t} value={t}>{NOMBRE_TIPO_PROMOCION[t]}</option>)}</select>
              </Campo>
              <Campo etiqueta="Descuento (%)"><input name="descuento_pct" inputMode="decimal" defaultValue={p.descuento_pct ? String(Number(p.descuento_pct)) : ''} className="campo text-right tabular-nums" /></Campo>
              <Campo etiqueta="Compra mínima por línea"><input name="cantidad_minima" inputMode="decimal" defaultValue={p.cantidad_minima ? String(Number(p.cantidad_minima)) : ''} className="campo text-right tabular-nums" /></Campo>
              <Campo etiqueta="Rige desde"><input type="date" name="vigente_desde" required defaultValue={p.vigente_desde} className="campo" /></Campo>
              <Campo etiqueta="Rige hasta"><input type="date" name="vigente_hasta" required defaultValue={p.vigente_hasta} className="campo" /></Campo>
              <div className="md:col-span-2"><Campo etiqueta="Descripción"><input name="descripcion" maxLength={250} defaultValue={p.descripcion ?? ''} className="campo" /></Campo></div>
              <div className="md:text-right"><BotonEnviar variante="secundario">Guardar</BotonEnviar></div>
            </Formulario>
          </details>
        )}
      </Panel>

      <Panel titulo="A qué aplica" className="mt-5">
        <p className="mb-3 text-sm text-texto-2">
          Aplica a un producto si coincide con alguno de los elementos de producto de la lista. Si se agregan clientes, solo aplica a esos clientes; sin clientes, a todos.
        </p>
        <Tabla columnas={['Elemento', 'Código', 'Nombre', ...(especial ? [{ t: 'Precio especial', derecha: true }] : []), ...(borrador && puedeEditar ? [''] : [])]}
          vacio="Aún no hay nada en el alcance.">
          {p.alcance.map((a) => (
            <tr key={a.id}>
              <Celda className="text-texto-2">{NOMBRE_TIPO_ALCANCE[a.tipo]}</Celda>
              <Celda mono>{a.codigo}</Celda>
              <Celda>{a.nombre}</Celda>
              {especial && <Celda derecha>{a.precio_especial_usd ? monto(a.precio_especial_usd, 'US$ ') : '—'}</Celda>}
              {borrador && puedeEditar && (
                <Celda>
                  <Formulario accion={quitarAlcanceAccion}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="alcance_id" value={a.id} />
                    <BotonEnviar variante="peligro">Quitar</BotonEnviar>
                  </Formulario>
                </Celda>
              )}
            </tr>
          ))}
        </Tabla>
        {borrador && puedeEditar && (
          <Formulario accion={agregarAlcanceAccion} className="mt-5 grid gap-3 md:grid-cols-4 md:items-end">
            <input type="hidden" name="id" value={p.id} />
            <Campo etiqueta="Agregar">
              <select name="tipo" required defaultValue="" className="campo">
                <option value="" disabled>Seleccione…</option>
                {TIPOS_ALCANCE.filter((t) => !especial || t === 'producto' || t === 'cliente').map((t) => <option key={t} value={t}>{NOMBRE_TIPO_ALCANCE[t]}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Código" ayuda="El código del producto, código común, categoría, marca o cliente">
              <input name="codigo" required maxLength={40} className="campo font-mono uppercase" />
            </Campo>
            {especial && <Campo etiqueta="Precio especial (USD)" ayuda="Solo para productos"><input name="precio_especial_usd" inputMode="decimal" className="campo text-right tabular-nums" /></Campo>}
            <div><BotonEnviar variante="secundario">Agregar al alcance</BotonEnviar></div>
          </Formulario>
        )}
      </Panel>

      {(p.estado === 'aprobada' || p.aplicada.lineas > 0) && (
        <Panel titulo="Lo vendido con esta promoción" className="mt-5">
          <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-5">
            <Dato etiqueta="Notas de entrega">{p.aplicada.notas}</Dato>
            <Dato etiqueta="Unidades">{Number(p.aplicada.unidades)}</Dato>
            <Dato etiqueta="A precio de lista">{monto(p.aplicada.venta_lista_usd, 'US$ ')}</Dato>
            <Dato etiqueta="Cobrado">{monto(p.aplicada.venta_cobrada_usd, 'US$ ')}</Dato>
            <Dato etiqueta="Descuento otorgado">{monto(p.aplicada.descuento_usd, 'US$ ')}</Dato>
          </dl>
          <p className="mt-3 text-xs text-texto-2">Cuenta las notas de entrega vigentes (en USD). El efecto frente a la venta esperada sin la promoción se mide en la Fase 8.</p>
        </Panel>
      )}

      {(puedeEditar || puedeDecidir) && (borrador || p.estado === 'pendiente' || p.estado === 'aprobada') && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {borrador && puedeEditar && (
              <Formulario accion={enviarAprobacionAccion} className="space-y-2">
                <input type="hidden" name="id" value={p.id} />
                <p className="max-w-sm text-sm text-texto-2">Al enviarla, el alcance y las condiciones ya no se editan. Gerencia la aprueba o la rechaza.</p>
                <BotonEnviar>Enviar a aprobación</BotonEnviar>
              </Formulario>
            )}
            {puedeDecidir && (
              <>
                <Formulario accion={aprobarPromocionAccion}><input type="hidden" name="id" value={p.id} /><BotonEnviar>Aprobar</BotonEnviar></Formulario>
                <Formulario accion={rechazarPromocionAccion} className="flex items-end gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <Campo etiqueta="Motivo del rechazo"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
                  <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
                </Formulario>
              </>
            )}
            {puedeEditar && (
              <details>
                <summary className="cursor-pointer text-sm text-red-200 hover:underline">Anular promoción</summary>
                <Formulario accion={anularPromocionAccion} className="mt-2 flex items-end gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <Campo etiqueta="Motivo"><input name="motivo" required minLength={3} maxLength={200} className="campo" /></Campo>
                  <BotonEnviar variante="peligro">Anular</BotonEnviar>
                </Formulario>
              </details>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}
