import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BotonEnviar, Formulario } from '@/components/formulario';
import type { Opcion } from '@/components/formulario-cliente';
import { Campo, Encabezado, Etiqueta, Panel } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fechaHora, monto } from '@/lib/formato';
import { ROLES_VEN_CLIENTES, puedeVerCliente } from '@/lib/maestros/clientes';
import { actualizarCreditoAccion, aprobarClienteAccion, cambiarEstadoClienteAccion } from '../acciones';
import { UUID, condicionesDePago } from '../datos';

const TONO = { pendiente: 'advertencia', activo: 'exito', inactivo: 'info', bloqueado: 'peligro' } as const;

interface Cliente {
  codigo: string; rif: string; razon_social: string; nombre_comercial: string | null; tipo_persona: string;
  domiciliado: boolean; contribuyente_especial: boolean; agente_retencion_iva: boolean;
  direccion_fiscal: string | null; telefono: string | null; email: string | null;
  sucursal: string | null; vendedor: string | null; zona: string | null;
  estado: keyof typeof TONO; condicion_pago_id: string | null; condicion: string | null;
  limite_credito_usd: string; nivel_precio: string; descuento_pct: string;
  creador: string | null; created_at: Date; aprobador: string | null; aprobado_at: Date | null;
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (<><dt className="text-texto-2">{etiqueta}</dt><dd>{children || '—'}</dd></>);
}

function CamposCredito({ c, condiciones }: { c: Cliente; condiciones: Opcion[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Campo etiqueta="Condición de pago">
        <select name="condicion_pago_id" defaultValue={c.condicion_pago_id ?? ''} required className="campo">
          <option value="">Seleccione…</option>
          {condiciones.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Límite de crédito (USD)">
        <input name="limite_credito_usd" defaultValue={c.estado === 'pendiente' ? '' : c.limite_credito_usd} required
          inputMode="decimal" placeholder="0.00" className="campo text-right tabular-nums" />
      </Campo>
      <Campo etiqueta="Nivel de precio">
        <select name="nivel_precio" defaultValue={c.nivel_precio} className="campo">
          <option value="A">A</option><option value="B">B</option><option value="D">D</option>
        </select>
      </Campo>
      <Campo etiqueta="Descuento comercial (%)">
        <input name="descuento_pct" defaultValue={c.descuento_pct} inputMode="decimal" className="campo text-right tabular-nums" />
      </Campo>
    </div>
  );
}

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getDb();
  // Seguridad por fila: si no puede verlo, la página no existe para él.
  if (!(await puedeVerCliente(db, u, id))) notFound();

  const { rows } = await db.query<Cliente>(
    `select c.codigo, t.rif, t.razon_social, t.nombre_comercial, t.tipo_persona, t.domiciliado, t.contribuyente_especial,
            t.agente_retencion_iva, t.direccion_fiscal, t.telefono, t.email,
            s.nombre as sucursal, v.codigo || ' · ' || v.nombre as vendedor, c.zona,
            c.estado, c.condicion_pago_id, cp.nombre as condicion, c.limite_credito_usd, c.nivel_precio, c.descuento_pct,
            uc.nombre as creador, c.created_at, ua.nombre as aprobador, c.aprobado_at
       from cliente c
       join tercero t on t.id = c.tercero_id
       left join sucursal s on s.id = c.sucursal_id
       left join vendedor v on v.id = c.vendedor_id
       left join condicion_pago cp on cp.id = c.condicion_pago_id
       left join usuario uc on uc.id = c.created_by
       left join usuario ua on ua.id = c.aprobado_por
      where c.tercero_id = $1`, [id]);
  const c = rows[0];
  if (!c) notFound();

  const esGerencia = tieneRol(u, ['gerencia']);
  const puedeEditar = tieneRol(u, ['facturacion', 'gerencia']);
  const condiciones = esGerencia ? await condicionesDePago(db) : [];

  return (
    <>
      <Encabezado titulo={`${c.codigo} · ${c.razon_social}`} descripcion={`RIF ${c.rif}${c.nombre_comercial ? ` · ${c.nombre_comercial}` : ''}`}>
        <div className="flex items-center gap-3">
          <Etiqueta tono={TONO[c.estado]}>{c.estado}</Etiqueta>
          {puedeEditar && (
            <Link href={`/maestros/clientes/${id}/editar`}
              className="rounded-lg border border-borde bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10">Editar datos</Link>
          )}
          <Link href="/maestros/clientes" className="text-sm text-texto-2 hover:text-texto">← Clientes</Link>
        </div>
      </Encabezado>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Datos fiscales y de contacto">
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
            <Dato etiqueta="Tipo de persona">{c.tipo_persona === 'J' ? 'Jurídica' : 'Natural'}</Dato>
            <Dato etiqueta="Domiciliado">{c.domiciliado ? 'Sí' : 'No'}</Dato>
            <Dato etiqueta="Contribuyente especial">{c.contribuyente_especial ? 'Sí' : 'No'}</Dato>
            <Dato etiqueta="Agente de retención IVA">{c.agente_retencion_iva ? 'Sí' : 'No'}</Dato>
            <Dato etiqueta="Dirección fiscal">{c.direccion_fiscal}</Dato>
            <Dato etiqueta="Teléfono">{c.telefono}</Dato>
            <Dato etiqueta="Correo">{c.email}</Dato>
          </dl>
        </Panel>

        <Panel titulo="Datos comerciales">
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
            <Dato etiqueta="Sucursal">{c.sucursal}</Dato>
            <Dato etiqueta="Vendedor">{c.vendedor}</Dato>
            <Dato etiqueta="Zona">{c.zona}</Dato>
            <Dato etiqueta="Condición de pago">{c.condicion}</Dato>
            <Dato etiqueta="Límite de crédito">{c.estado === 'pendiente' ? 'Por asignar' : monto(c.limite_credito_usd, '$')}</Dato>
            <Dato etiqueta="Nivel de precio">{c.nivel_precio}</Dato>
            <Dato etiqueta="Descuento comercial">{`${c.descuento_pct} %`}</Dato>
            <Dato etiqueta="Registrado por">{c.creador ? `${c.creador} · ${fechaHora(c.created_at)}` : fechaHora(c.created_at)}</Dato>
            <Dato etiqueta="Aprobado por">{c.aprobador ? `${c.aprobador} · ${fechaHora(c.aprobado_at)}` : null}</Dato>
          </dl>
        </Panel>

        {esGerencia && c.estado === 'pendiente' && (
          <Panel titulo="Aprobar cliente">
            <Formulario accion={aprobarClienteAccion} className="space-y-4">
              <input type="hidden" name="id" value={id} />
              <CamposCredito c={c} condiciones={condiciones} />
              <BotonEnviar>Aprobar cliente</BotonEnviar>
            </Formulario>
          </Panel>
        )}

        {esGerencia && c.estado !== 'pendiente' && (
          <>
            <Panel titulo="Condiciones de crédito">
              <Formulario accion={actualizarCreditoAccion} className="space-y-4">
                <input type="hidden" name="id" value={id} />
                <CamposCredito c={c} condiciones={condiciones} />
                <BotonEnviar variante="secundario">Guardar condiciones</BotonEnviar>
              </Formulario>
            </Panel>
            <Panel titulo="Estado del cliente">
              <p className="mb-3 text-sm text-texto-2">Un cliente no se borra: se inactiva, o se bloquea para impedir nuevas ventas.</p>
              <div className="flex flex-wrap gap-2">
                {(['activo', 'inactivo', 'bloqueado'] as const).filter((e) => e !== c.estado).map((e) => (
                  <Formulario key={e} accion={cambiarEstadoClienteAccion}>
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="estado" value={e} />
                    <BotonEnviar variante={e === 'bloqueado' ? 'peligro' : 'secundario'}>
                      {e === 'activo' ? 'Reactivar' : e === 'inactivo' ? 'Inactivar' : 'Bloquear'}
                    </BotonEnviar>
                  </Formulario>
                ))}
              </div>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
