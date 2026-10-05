import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { puedeDecidirObjeto } from '@/lib/flujo/flujo';
import { monto } from '@/lib/formato';
import { ROLES_AJUSTAN, ROLES_VEN_AJUSTES, detalleAjuste } from '@/lib/inventario/ajustes';
import { almacenesVisibles } from '@/lib/maestros/almacenes';
import { listarMotivos } from '@/lib/maestros/motivos';
import {
  aprobarAjusteAccion, eliminarAjusteAccion, enviarAjusteAccion, guardarLineaAccion, quitarLineaAjusteAccion, rechazarAjusteAccion,
} from '../../acciones';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONO = { borrador: 'info', pendiente: 'advertencia', aprobado: 'exito', rechazado: 'peligro' } as const;

export default async function AjustePage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_AJUSTES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  const d = await detalleAjuste(db, id);
  if (!d) notFound();
  if (!(await almacenesVisibles(db, u)).includes(d.almacen_id)) notFound();

  const borrador = d.estado === 'borrador';
  const puedeEditar = borrador && tieneRol(u, ROLES_AJUSTAN);
  const pendiente = d.estado === 'pendiente';
  const puedeDecidir = pendiente && (await puedeDecidirObjeto(db, u.id, 'ajuste_inventario', id));
  const motivos = puedeEditar ? await listarMotivos(db, { tipo: 'merma', soloActivos: true }) : [];
  const conDiferencia = d.lineas.filter((l) => Number(l.diferencia) !== 0).length;

  return (
    <>
      <Encabezado titulo={d.numero ? `Ajuste de inventario ${d.numero}` : 'Ajuste de inventario en borrador'} descripcion={`Almacén ${d.almacen}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[d.estado as keyof typeof TONO] ?? 'info'}>{d.estado}</Etiqueta>
          <Link href="/inventario/ajustes" className="text-sm text-texto-2 hover:text-texto">← Ajustes</Link>
        </div>
      </Encabezado>

      {pendiente && !puedeDecidir && tieneRol(u, ['gerencia']) && (
        <div className="mb-5">
          <Aviso tono="advertencia">
            Lo debe aprobar otra persona de Gerencia: quien creó el ajuste ({d.creado_por}) o hizo el conteo ({d.contado_por}) no lo aprueba.
          </Aviso>
        </div>
      )}
      {d.estado === 'rechazado' && <div className="mb-5"><Aviso tono="peligro">Rechazado: {d.rechazo_motivo}</Aviso></div>}
      {d.estado === 'aprobado' && <div className="mb-5"><Aviso tono="exito">Aprobado por {d.aprobado_por} el {d.aprobado_at}. Las diferencias ya están en la existencia y en la contabilidad.</Aviso></div>}

      <Panel titulo="Datos del ajuste">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          <div><dt className="text-texto-2">Almacén</dt><dd>{d.almacen}</dd></div>
          <div><dt className="text-texto-2">Creó</dt><dd>{d.creado_por} · {d.fecha}</dd></div>
          <div><dt className="text-texto-2">Conteo hecho por</dt><dd>{d.contado_por}</dd></div>
          <div><dt className="text-texto-2">Valor de las diferencias</dt><dd className="font-mono">{monto(d.valor_usd, 'US$ ')}</dd></div>
          {d.observaciones && <div className="md:col-span-2"><dt className="text-texto-2">Observaciones</dt><dd className="whitespace-pre-line">{d.observaciones}</dd></div>}
        </dl>
      </Panel>

      <Panel titulo={`Productos contados (${d.lineas.length})`} className="mt-5">
        <Tabla
          columnas={['Código', 'Descripción', { t: 'Sistema', derecha: true }, { t: 'Contado', derecha: true }, { t: 'Diferencia', derecha: true },
            { t: 'Costo US$', derecha: true }, 'Motivo', ...(puedeEditar ? [''] : [])]}
          vacio="Agregue lo contado de cada producto.">
          {d.lineas.map((l) => {
            const dif = Number(l.diferencia);
            return (
              <tr key={l.id}>
                <Celda mono>{l.codigo}</Celda>
                <Celda>{l.descripcion}</Celda>
                <Celda derecha mono>{Number(l.sistema)}</Celda>
                <Celda derecha mono>{Number(l.contada)}</Celda>
                <Celda derecha mono className={dif < 0 ? 'text-red-300' : dif > 0 ? 'text-emerald-300' : 'text-texto-2'}>{dif > 0 ? `+${dif}` : dif}</Celda>
                <Celda derecha mono className="text-texto-2">{monto(l.costo_unitario ?? l.costo_promedio)}</Celda>
                <Celda className="text-texto-2">{l.motivo ?? '—'}</Celda>
                {puedeEditar && (
                  <Celda>
                    <Formulario accion={quitarLineaAjusteAccion}>
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="linea_id" value={l.id} />
                      <BotonEnviar variante="peligro">Quitar</BotonEnviar>
                    </Formulario>
                  </Celda>
                )}
              </tr>
            );
          })}
        </Tabla>

        {puedeEditar && (
          <Formulario accion={guardarLineaAccion} className="mt-5 flex flex-wrap items-end gap-3 border-t border-borde pt-4">
            <input type="hidden" name="id" value={id} />
            <Campo etiqueta="Código del producto"><input name="codigo" required autoComplete="off" className="campo w-44 font-mono uppercase" placeholder="PF-001" /></Campo>
            <Campo etiqueta="Cantidad contada"><input name="contada" required inputMode="decimal" className="campo w-32" /></Campo>
            <Campo etiqueta="Motivo de la diferencia">
              <select name="motivo_id" defaultValue="" className="campo w-60">
                <option value="">Sin diferencia</option>
                {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Costo US$" ayuda="Solo si sobra un producto sin costo">
              <input name="costo" inputMode="decimal" className="campo w-28" />
            </Campo>
            <BotonEnviar>Agregar o reemplazar</BotonEnviar>
          </Formulario>
        )}
      </Panel>

      {puedeDecidir && (
        <Panel titulo="Decisión de Gerencia" className="mt-5">
          <div className="grid gap-6 md:grid-cols-2">
            <Formulario accion={aprobarAjusteAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <p className="text-sm text-texto-2">Al aprobar se aplican las diferencias a la existencia y se contabilizan los faltantes y sobrantes.</p>
              <BotonEnviar>Aprobar ajuste</BotonEnviar>
            </Formulario>
            <Formulario accion={rechazarAjusteAccion} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Motivo del rechazo"><textarea name="motivo" required rows={2} maxLength={300} className="campo" /></Campo>
              <BotonEnviar variante="peligro">Rechazar ajuste</BotonEnviar>
            </Formulario>
          </div>
        </Panel>
      )}

      {puedeEditar && (
        <Panel titulo="Acciones" className="mt-5">
          <div className="flex flex-wrap items-start gap-6">
            {conDiferencia > 0 && (
              <Formulario accion={enviarAjusteAccion} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                <p className="max-w-xs text-sm text-texto-2">Al enviarlo recibe su número y ya no se edita. Gerencia lo aprueba o lo rechaza.</p>
                <BotonEnviar>Enviar a aprobación</BotonEnviar>
              </Formulario>
            )}
            <Formulario accion={eliminarAjusteAccion}><input type="hidden" name="id" value={id} /><BotonEnviar variante="peligro">Eliminar borrador</BotonEnviar></Formulario>
          </div>
        </Panel>
      )}
    </>
  );
}
