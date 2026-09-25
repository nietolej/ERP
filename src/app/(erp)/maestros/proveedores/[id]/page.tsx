import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { FormularioProveedor, type ValoresProveedor } from '@/components/formulario-proveedor';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { PanelAdjuntos } from '@/components/panel-adjuntos';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fechaHora } from '@/lib/formato';
import { CAMPOS_SENSIBLES, NOMBRE_TIPO_PROVEEDOR, ROLES_VEN_PROVEEDORES, type TipoProveedor } from '@/lib/maestros/proveedores';
import {
  actualizarContactoAccion, aprobarProveedorAccion, cambiarCondicionAccion, cambiarEstadoProveedorAccion,
  corregirPendienteAccion, resolverCambioAccion, solicitarCambioAccion,
} from '../acciones';
import { TIPOS, UUID, conceptosIslr } from '../datos';

const TONO = { pendiente: 'advertencia', activo: 'exito', inactivo: 'info', bloqueado: 'peligro' } as const;

interface Proveedor {
  codigo: string; rif: string; razon_social: string; nombre_comercial: string | null; domiciliado: boolean;
  contribuyente_especial: boolean; agente_retencion_iva: boolean; direccion_fiscal: string | null;
  telefono: string | null; email: string | null; tipo: TipoProveedor; pais: string; concepto_islr_id: string | null;
  concepto: string | null; condicion_pago_id: string | null; condicion: string | null; estado: keyof typeof TONO;
  created_by: string | null; creador: string | null; created_at: Date; aprobador: string | null; aprobado_at: Date | null;
}

interface Cambio {
  id: string; datos: Record<string, string | boolean>; estado: string; solicitado_por: string; solicitante: string;
  solicitado_at: Date; resolutor: string | null; resuelto_at: Date | null; motivo_rechazo: string | null;
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (<><dt className="text-texto-2">{etiqueta}</dt><dd>{children || '—'}</dd></>);
}

export default async function ProveedorPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_PROVEEDORES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();

  const { rows } = await db.query<Proveedor>(
    `select p.codigo, t.rif, t.razon_social, t.nombre_comercial, t.domiciliado, t.contribuyente_especial, t.agente_retencion_iva,
            t.direccion_fiscal, t.telefono, t.email, p.tipo, p.pais, p.concepto_islr_id,
            ci.codigo || ' · ' || ci.descripcion as concepto, p.condicion_pago_id, cp.nombre as condicion, p.estado,
            p.created_by, uc.nombre as creador, p.created_at, ua.nombre as aprobador, p.aprobado_at
       from proveedor p
       join tercero t on t.id = p.tercero_id
       left join concepto_islr ci on ci.id = p.concepto_islr_id
       left join condicion_pago cp on cp.id = p.condicion_pago_id
       left join usuario uc on uc.id = p.created_by
       left join usuario ua on ua.id = p.aprobado_por
      where p.tercero_id = $1`, [id]);
  const p = rows[0];
  if (!p) notFound();

  const { rows: cambios } = await db.query<Cambio>(
    `select c.id, c.datos, c.estado, c.solicitado_por, us.nombre as solicitante, c.solicitado_at,
            ur.nombre as resolutor, c.resuelto_at, c.motivo_rechazo
       from proveedor_cambio c join usuario us on us.id = c.solicitado_por left join usuario ur on ur.id = c.resuelto_por
      where c.proveedor_id = $1 order by c.solicitado_at desc`, [id]);
  const abierto = cambios.find((c) => c.estado === 'pendiente');
  const conceptos = await conceptosIslr(db, p.concepto_islr_id);
  const condiciones = (await db.query<{ id: string; nombre: string }>(
    'select id, nombre from condicion_pago where activa order by dias, nombre')).rows;

  const esCompras = tieneRol(u, ['compras']);
  const esGerencia = tieneRol(u, ['gerencia']);
  const pendiente = p.estado === 'pendiente';
  const nombreConcepto = (v: string) => conceptos.find((c) => c.id === v)?.nombre ?? (v ? v : 'Sin concepto');
  const mostrar = (campo: string, v: unknown): string => {
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (campo === 'tipo') return NOMBRE_TIPO_PROVEEDOR[v as TipoProveedor] ?? String(v);
    if (campo === 'concepto_islr_id') return nombreConcepto(String(v ?? ''));
    return String(v ?? '—');
  };
  const actual: Record<string, unknown> = {
    razon_social: p.razon_social, domiciliado: p.domiciliado, contribuyente_especial: p.contribuyente_especial,
    agente_retencion_iva: p.agente_retencion_iva, tipo: p.tipo, pais: p.pais, concepto_islr_id: p.concepto_islr_id ?? '',
  };
  const valores: ValoresProveedor = {
    id, rif: p.rif, razonSocial: p.razon_social, domiciliado: p.domiciliado, contribuyenteEspecial: p.contribuyente_especial,
    agenteRetencionIva: p.agente_retencion_iva, tipo: p.tipo, pais: p.pais, conceptoIslrId: p.concepto_islr_id ?? '',
    nombreComercial: p.nombre_comercial ?? '', direccionFiscal: p.direccion_fiscal ?? '', telefono: p.telefono ?? '', email: p.email ?? '',
  };

  return (
    <>
      <Encabezado titulo={`${p.codigo} · ${p.razon_social}`} descripcion={`RIF ${p.rif} · ${NOMBRE_TIPO_PROVEEDOR[p.tipo]} · ${p.pais}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[p.estado]}>{p.estado}</Etiqueta>
          {abierto && <Etiqueta tono="advertencia">cambio por aprobar</Etiqueta>}
          <Link href="/maestros/proveedores" className="text-sm text-texto-2 hover:text-texto">← Proveedores</Link>
        </div>
      </Encabezado>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Datos del proveedor">
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
            <Dato etiqueta="Nombre comercial">{p.nombre_comercial}</Dato>
            <Dato etiqueta="Domiciliado">{p.domiciliado ? 'Sí' : 'No'}</Dato>
            <Dato etiqueta="Contribuyente especial">{p.contribuyente_especial ? 'Sí' : 'No'}</Dato>
            <Dato etiqueta="Agente de retención IVA">{p.agente_retencion_iva ? 'Sí' : 'No'}</Dato>
            <Dato etiqueta="Concepto de ISLR">{p.concepto}</Dato>
            <Dato etiqueta="Condición de pago">{p.condicion ?? (pendiente ? 'La asigna Gerencia al aprobar' : null)}</Dato>
            <Dato etiqueta="Dirección fiscal">{p.direccion_fiscal}</Dato>
            <Dato etiqueta="Teléfono">{p.telefono}</Dato>
            <Dato etiqueta="Correo">{p.email}</Dato>
            <Dato etiqueta="Registrado por">{`${p.creador ?? '—'} · ${fechaHora(p.created_at)}`}</Dato>
            <Dato etiqueta="Aprobado por">{p.aprobador ? `${p.aprobador} · ${fechaHora(p.aprobado_at)}` : null}</Dato>
          </dl>
        </Panel>

        {pendiente && esGerencia && (
          <Panel titulo="Aprobar proveedor">
            {p.created_by === u.id ? (
              <p className="text-sm text-texto-2">Usted registró este proveedor: debe aprobarlo otro usuario de Gerencia.</p>
            ) : (
              <Formulario accion={aprobarProveedorAccion} className="space-y-4">
                <input type="hidden" name="id" value={id} />
                <Campo etiqueta="Condición de pago">
                  <select name="condicion_pago_id" required className="campo" defaultValue="">
                    <option value="">Seleccione…</option>
                    {condiciones.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </Campo>
                <BotonEnviar>Aprobar proveedor</BotonEnviar>
              </Formulario>
            )}
          </Panel>
        )}

        {abierto && (
          <Panel titulo="Solicitud de cambio por aprobar">
            <p className="mb-3 text-sm text-texto-2">Solicitada por {abierto.solicitante} · {fechaHora(abierto.solicitado_at)}</p>
            <Tabla columnas={['Dato', 'Actual', 'Propuesto']}>
              {Object.entries(abierto.datos).map(([campo, v]) => (
                <tr key={campo}>
                  <Celda className="text-texto-2">{CAMPOS_SENSIBLES[campo] ?? campo}</Celda>
                  <Celda>{mostrar(campo, actual[campo])}</Celda>
                  <Celda className="font-semibold text-amber-200">{mostrar(campo, v)}</Celda>
                </tr>
              ))}
            </Tabla>
            {esGerencia && abierto.solicitado_por !== u.id && (
              <div className="mt-4 flex flex-wrap items-start gap-3">
                <Formulario accion={resolverCambioAccion}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="cambio_id" value={abierto.id} />
                  <input type="hidden" name="decision" value="aprobar" />
                  <BotonEnviar>Aprobar y aplicar</BotonEnviar>
                </Formulario>
                <Formulario accion={resolverCambioAccion} className="flex flex-wrap items-start gap-2">
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="cambio_id" value={abierto.id} />
                  <input type="hidden" name="decision" value="rechazar" />
                  <input name="motivo" required placeholder="Motivo del rechazo" className="campo w-64" />
                  <BotonEnviar variante="peligro">Rechazar</BotonEnviar>
                </Formulario>
              </div>
            )}
            {esGerencia && abierto.solicitado_por === u.id && (
              <p className="mt-3 text-sm text-texto-2">Usted solicitó este cambio: debe resolverlo otro usuario de Gerencia.</p>
            )}
          </Panel>
        )}

        {esGerencia && !pendiente && (
          <Panel titulo="Condición de pago y estado">
            <Formulario accion={cambiarCondicionAccion} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={id} />
              <Campo etiqueta="Condición de pago">
                <select name="condicion_pago_id" defaultValue={p.condicion_pago_id ?? ''} className="campo">
                  {condiciones.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </Campo>
              <BotonEnviar variante="secundario">Guardar</BotonEnviar>
            </Formulario>
            <p className="mb-2 mt-5 text-sm text-texto-2">Un proveedor no se borra: se inactiva, o se bloquea para impedir compras y pagos.</p>
            <div className="flex flex-wrap gap-2">
              {(['activo', 'inactivo', 'bloqueado'] as const).filter((e) => e !== p.estado).map((e) => (
                <Formulario key={e} accion={cambiarEstadoProveedorAccion}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="estado" value={e} />
                  <BotonEnviar variante={e === 'bloqueado' ? 'peligro' : 'secundario'}>
                    {e === 'activo' ? 'Reactivar' : e === 'inactivo' ? 'Inactivar' : 'Bloquear'}
                  </BotonEnviar>
                </Formulario>
              ))}
            </div>
          </Panel>
        )}
      </div>

      {pendiente && esCompras && (
        <Panel titulo="Corregir datos (mientras está pendiente)" className="mt-5">
          <FormularioProveedor accion={corregirPendienteAccion} modo="pendiente" tipos={TIPOS} conceptos={conceptos}
            inicial={valores} boton="Guardar correcciones" />
        </Panel>
      )}

      {!pendiente && esCompras && (
        <Panel titulo="Datos de contacto" className="mt-5">
          <p className="mb-4 text-sm text-texto-2">Se actualizan de inmediato.</p>
          <FormularioProveedor accion={actualizarContactoAccion} modo="contacto" tipos={TIPOS} conceptos={conceptos}
            inicial={valores} boton="Guardar contacto" />
        </Panel>
      )}

      {!pendiente && !abierto && (esCompras || esGerencia) && (
        <Panel titulo="Solicitar cambio de datos sensibles" className="mt-5">
          <p className="mb-4 text-sm text-texto-2">
            Razón social, datos fiscales, tipo, país y concepto de ISLR. El cambio se aplica cuando lo aprueba Gerencia
            (otra persona distinta de quien lo solicita).
          </p>
          <FormularioProveedor accion={solicitarCambioAccion} modo="solicitud" tipos={TIPOS} conceptos={conceptos}
            inicial={valores} boton="Enviar solicitud" />
        </Panel>
      )}

      {cambios.some((c) => c.estado !== 'pendiente') && (
        <Panel titulo="Historial de cambios" className="mt-5">
          <Tabla columnas={['Solicitado', 'Cambios', 'Resultado', 'Resuelto']}>
            {cambios.filter((c) => c.estado !== 'pendiente').map((c) => (
              <tr key={c.id}>
                <Celda className="text-texto-2">{c.solicitante} · {fechaHora(c.solicitado_at)}</Celda>
                <Celda>{Object.entries(c.datos).map(([campo, v]) => `${CAMPOS_SENSIBLES[campo] ?? campo}: ${mostrar(campo, v)}`).join(' · ')}</Celda>
                <Celda>
                  <Etiqueta tono={c.estado === 'aprobado' ? 'exito' : 'peligro'}>{c.estado}</Etiqueta>
                  {c.motivo_rechazo && <span className="ml-2 text-texto-2">{c.motivo_rechazo}</span>}
                </Celda>
                <Celda className="text-texto-2">{c.resolutor} · {fechaHora(c.resuelto_at)}</Celda>
              </tr>
            ))}
          </Tabla>
        </Panel>
      )}
      <PanelAdjuntos tipo="proveedor" entidadId={id} usuario={u} className="mt-5" />
    </>
  );
}
