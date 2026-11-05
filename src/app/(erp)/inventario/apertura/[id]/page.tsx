import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { NOMBRE_ESTADO_CONTEO, ROLES_CUENTAN, ROLES_FIJAN_COSTO, ROLES_VEN_CONTEO, detalleConteo } from '@/lib/apertura/inventario';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { fecha, monto } from '@/lib/formato';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { decidirConteoAccion, eliminarConteoAccion, enviarConteoAccion, fijarCostosAccion, guardarLineaConteoAccion, quitarLineaConteoAccion } from '../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { borrador: 'info', pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function ConteoPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CONTEO);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleConteo(db, id);
  if (!d || !(await almacenesVisibles(db, u)).includes(d.almacen_id)) notFound();

  const borrador = d.estado === 'borrador';
  const cuenta = borrador && tieneRol(u, ROLES_CUENTAN);
  const costea = borrador && tieneRol(u, ROLES_FIJAN_COSTO);
  const sinCosto = d.detalle.filter((l) => l.costo === null).length;
  const puedeDecidir = d.estado === 'pendiente' && (await puedeDecidirObjeto(db, u.id, 'apertura_inventario', id));
  const productos = cuenta
    ? (await db.query<{ id: string; texto: string }>(`select id, codigo || ' · ' || descripcion as texto from producto where inventariable and estado = 'activo' order by codigo limit 1500`)).rows
    : [];

  return (
    <>
      <Encabezado titulo={`Conteo inicial N° ${d.numero}`} descripcion={`${d.almacen} · arranque ${fecha(d.fecha)}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{NOMBRE_ESTADO_CONTEO[d.estado] ?? d.estado}</Etiqueta>
          <Link href="/inventario/apertura" className="text-sm text-texto-2 hover:text-texto">← Conteos</Link>
        </div>
      </Encabezado>

      {d.estado === 'pendiente' && <div className="mb-5"><Aviso tono="advertencia">Pendiente de Gerencia. Mientras no se apruebe no entra existencia ni hay asiento.</Aviso></div>}
      {d.estado === 'pendiente' && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5"><Aviso tono="advertencia">Lo debe decidir otra persona de Gerencia: quien registró el conteo ({d.creador}){d.costos_por ? ` o fijó los costos (${d.costos_por})` : ''} no lo aprueba.</Aviso></div>
      )}
      {d.estado === 'rechazado' && <div className="mb-5"><Aviso tono="peligro">Rechazado: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'aprobado' && <div className="mb-5"><Aviso tono="exito">Aprobado por {d.aprobado_por}. Asiento {d.asiento ?? '—'}. Valor del inventario inicial: US$ {monto(d.total_usd)}.</Aviso></div>}
      {borrador && sinCosto > 0 && d.lineas > 0 && <div className="mb-5"><Aviso tono="advertencia">Contabilidad debe fijar el costo de {sinCosto === 1 ? '1 línea' : `${sinCosto} líneas`} antes de enviar el conteo.</Aviso></div>}

      <Panel titulo={`Productos contados (${d.lineas})`}>
        <Formulario accion={fijarCostosAccion} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          <Tabla columnas={['Producto', { t: 'Cantidad', derecha: true }, { t: 'Costo unitario (US$)', derecha: true }, { t: 'Valor (US$)', derecha: true }]} vacio="Todavía no hay productos contados.">
            {d.detalle.map((l) => (
              <tr key={l.id}>
                <Celda><span className="font-mono">{l.codigo}</span><span className="block text-xs text-texto-2">{l.descripcion}</span></Celda>
                <Celda derecha mono>{Number(l.cantidad)}</Celda>
                <Celda derecha mono>
                  {costea
                    ? <input name={`costo_${l.id}`} defaultValue={l.costo ?? ''} inputMode="decimal" className="campo w-28 text-right" aria-label={`Costo de ${l.codigo}`} />
                    : (l.costo === null ? '—' : Number(l.costo).toFixed(4))}
                </Celda>
                <Celda derecha mono>{l.total === null ? '—' : monto(l.total)}</Celda>
              </tr>
            ))}
          </Tabla>
          {costea && d.lineas > 0 && <BotonEnviar>Guardar costos</BotonEnviar>}
        </Formulario>
        <p className="mt-3 text-sm text-texto-2">Valor total: <span className="font-mono">US$ {monto(d.total_usd)}</span></p>
        {cuenta && d.lineas > 0 && (
          <Formulario accion={quitarLineaConteoAccion} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Quitar una línea del conteo">
              <select name="linea_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{d.detalle.map((l) => <option key={l.id} value={l.id}>{l.codigo} · {Number(l.cantidad)}</option>)}</select>
            </Campo>
            <BotonEnviar variante="peligro">Quitar</BotonEnviar>
          </Formulario>
        )}
      </Panel>

      {cuenta && (
        <Panel titulo="Agregar producto contado" className="mt-5">
          <Formulario accion={guardarLineaConteoAccion} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Producto (si ya está, cambia su cantidad)">
              <select name="producto_id" required defaultValue="" className="campo"><option value="" disabled>Seleccione…</option>{productos.map((p) => <option key={p.id} value={p.id}>{p.texto}</option>)}</select>
            </Campo>
            <Campo etiqueta="Cantidad contada"><input name="cantidad" inputMode="decimal" required className="campo text-right font-mono" /></Campo>
            <BotonEnviar>Guardar línea</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">¿Falta el producto? Se crea en <Link href="/maestros/productos" className="text-acento hover:underline">Maestros → Productos</Link> y vuelve aquí.</p>
        </Panel>
      )}

      {cuenta && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-center gap-6">
            {d.lineas > 0 && <Formulario accion={enviarConteoAccion}><input type="hidden" name="id" value={id} /><BotonEnviar>Enviar a Gerencia</BotonEnviar></Formulario>}
            <Formulario accion={eliminarConteoAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
          </div>
        </Panel>
      )}

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={decidirConteoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="aprobar" />
              <p className="text-sm text-texto-2">Al aprobar entra el inventario inicial al costo fijado y se contabiliza contra «Saldos de apertura», todo en el mismo acto.</p>
              <BotonEnviar>Aprobar conteo</BotonEnviar>
            </Formulario>
            <Formulario accion={decidirConteoAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="rechazar" />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar conteo</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
