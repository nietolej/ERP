'use client';

import { useState } from 'react';
import { BotonEnviar, PendienteProvider, useEnvio } from '@/components/formulario';
import { Campo } from '@/components/ui';
import type { EstadoAccion } from '@/lib/acciones';
import { normalizarRif, problemaDeRif } from '@/lib/maestros/rif';

export interface Opcion {
  id: string;
  nombre: string;
}

export interface ValoresCliente {
  id?: string;
  rif: string;
  razonSocial: string;
  nombreComercial: string;
  domiciliado: boolean;
  contribuyenteEspecial: boolean;
  agenteRetencionIva: boolean;
  direccionFiscal: string;
  telefono: string;
  email: string;
  sucursalId: string;
  vendedorId: string;
  zona: string;
}

interface Props {
  accion: (estado: EstadoAccion, fd: FormData) => Promise<EstadoAccion>;
  sucursales: Opcion[];
  vendedores: Opcion[];
  inicial: ValoresCliente;
}

export const CLIENTE_VACIO: ValoresCliente = {
  rif: '', razonSocial: '', nombreComercial: '', domiciliado: true, contribuyenteEspecial: false,
  agenteRetencionIva: false, direccionFiscal: '', telefono: '', email: '', sucursalId: '', vendedorId: '', zona: '',
};

/** Alta y edición de clientes. En edición el RIF no se cambia: identifica al tercero. */
export function FormularioCliente({ accion, sucursales, vendedores, inicial }: Props) {
  const { estado, pendiente, alEnviar } = useEnvio(accion);
  const [rif, setRif] = useState(inicial.rif);
  const edicion = !!inicial.id;
  const problema = !edicion && rif.trim().length >= 3 ? problemaDeRif(rif) : null;
  const canonico = !edicion && !problema ? normalizarRif(rif) : null;

  return (
    <form onSubmit={alEnviar} className="space-y-6">
      <PendienteProvider value={pendiente}>
      {inicial.id && <input type="hidden" name="id" value={inicial.id} />}

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-texto-2">Datos fiscales</legend>
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <Campo etiqueta="RIF" ayuda={edicion ? 'El RIF identifica al tercero y no se cambia.' : 'Letra, 8 dígitos y el dígito verificador.'}>
            <input name="rif" value={rif} onChange={(e) => setRif(e.target.value)} readOnly={edicion} required
              autoComplete="off" placeholder="J-12345678-4" className="campo font-mono uppercase" />
            {problema && <span className="mt-1 block text-xs text-amber-300">{problema}</span>}
            {canonico && canonico !== rif && <span className="mt-1 block text-xs text-emerald-300">Se guardará como {canonico}</span>}
          </Campo>
          <Campo etiqueta="Razón social o nombre">
            <input name="razon_social" defaultValue={inicial.razonSocial} required maxLength={200} className="campo" />
          </Campo>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo etiqueta="Nombre comercial (opcional)">
            <input name="nombre_comercial" defaultValue={inicial.nombreComercial} maxLength={200} className="campo" />
          </Campo>
          <Campo etiqueta="Dirección fiscal">
            <input name="direccion_fiscal" defaultValue={inicial.direccionFiscal} maxLength={300} className="campo" />
          </Campo>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" name="domiciliado" defaultChecked={inicial.domiciliado} /> Domiciliado en Venezuela</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="contribuyente_especial" defaultChecked={inicial.contribuyenteEspecial} /> Contribuyente especial</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="agente_retencion_iva" defaultChecked={inicial.agenteRetencionIva} /> Agente de retención de IVA</label>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-texto-2">Contacto</legend>
        <Campo etiqueta="Teléfono">
          <input name="telefono" type="tel" defaultValue={inicial.telefono} maxLength={40} className="campo" />
        </Campo>
        <Campo etiqueta="Correo">
          <input name="email" type="email" defaultValue={inicial.email} maxLength={200} className="campo" />
        </Campo>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-texto-2">Datos comerciales</legend>
        <Campo etiqueta="Sucursal">
          <select name="sucursal_id" defaultValue={inicial.sucursalId} className="campo">
            <option value="">Sin asignar</option>
            {sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Vendedor" ayuda={vendedores.length ? undefined : 'Aún no hay vendedores registrados.'}>
          <select name="vendedor_id" defaultValue={inicial.vendedorId} className="campo">
            <option value="">Sin asignar</option>
            {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Zona">
          <input name="zona" defaultValue={inicial.zona} maxLength={60} className="campo" />
        </Campo>
      </fieldset>

      {estado?.confirmar && (
        <label className="flex items-start gap-2 rounded-lg border border-advertencia/40 bg-advertencia/10 px-3 py-2 text-sm text-amber-200">
          <input type="checkbox" name="confirmar_nombre" className="mt-1" />
          Confirmo que es una persona o empresa distinta, aunque su nombre se parezca al de otro tercero.
        </label>
      )}
      {estado?.error && (
        <p role="alert" className="whitespace-pre-line rounded-lg border border-peligro/40 bg-peligro/10 px-3 py-2 text-sm text-red-200">{estado.error}</p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-texto-2">{edicion ? '' : 'El cliente queda pendiente hasta que Gerencia le asigne condición de pago y límite de crédito.'}</p>
        <BotonEnviar>{edicion ? 'Guardar cambios' : 'Registrar cliente'}</BotonEnviar>
      </div>
      </PendienteProvider>
    </form>
  );
}
