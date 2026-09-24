'use client';

import { useState } from 'react';
import { BotonEnviar, PendienteProvider, useEnvio } from '@/components/formulario';
import { Campo } from '@/components/ui';
import type { EstadoAccion } from '@/lib/acciones';
import { normalizarRif, problemaDeRif } from '@/lib/maestros/rif';

export interface ValoresProveedor {
  id?: string;
  rif: string;
  razonSocial: string;
  domiciliado: boolean;
  contribuyenteEspecial: boolean;
  agenteRetencionIva: boolean;
  tipo: string;
  pais: string;
  conceptoIslrId: string;
  nombreComercial: string;
  direccionFiscal: string;
  telefono: string;
  email: string;
}

export const PROVEEDOR_VACIO: ValoresProveedor = {
  rif: '', razonSocial: '', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false,
  tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: '', nombreComercial: '', direccionFiscal: '', telefono: '', email: '',
};

interface Props {
  accion: (estado: EstadoAccion, fd: FormData) => Promise<EstadoAccion>;
  /** Qué partes del proveedor edita este formulario. */
  modo: 'alta' | 'pendiente' | 'solicitud' | 'contacto';
  tipos: { valor: string; nombre: string }[];
  conceptos: { id: string; nombre: string }[];
  inicial: ValoresProveedor;
  boton: string;
}

const PAISES = ['VE', 'CN', 'US', 'CO', 'PA', 'BR', 'TW', 'KR', 'JP', 'DE', 'IN', 'MX', 'ES', 'IT', 'TR'];

export function FormularioProveedor({ accion, modo, tipos, conceptos, inicial, boton }: Props) {
  const { estado, pendiente, alEnviar } = useEnvio(accion);
  const [rif, setRif] = useState(inicial.rif);
  const conSensibles = modo !== 'contacto';
  const conContacto = modo !== 'solicitud';
  const problema = modo === 'alta' && rif.trim().length >= 3 ? problemaDeRif(rif) : null;
  const canonico = modo === 'alta' && !problema ? normalizarRif(rif) : null;

  return (
    <form onSubmit={alEnviar} className="space-y-5">
      <PendienteProvider value={pendiente}>
        {inicial.id && <input type="hidden" name="id" value={inicial.id} />}

        {conSensibles && (
          <fieldset className="space-y-4">
            <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-texto-2">
              Datos fiscales y comerciales{modo === 'solicitud' ? ' (propuestos)' : ''}
            </legend>
            <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
              {modo === 'alta' ? (
                <Campo etiqueta="RIF" ayuda="Letra, 8 dígitos y el dígito verificador.">
                  <input name="rif" value={rif} onChange={(e) => setRif(e.target.value)} required autoComplete="off"
                    placeholder="J-12345678-4" className="campo font-mono uppercase" />
                  {problema && <span className="mt-1 block text-xs text-amber-300">{problema}</span>}
                  {canonico && canonico !== rif && <span className="mt-1 block text-xs text-emerald-300">Se guardará como {canonico}</span>}
                </Campo>
              ) : (
                <Campo etiqueta="RIF" ayuda="Identifica al tercero y no se cambia.">
                  <input value={inicial.rif} readOnly className="campo font-mono" />
                </Campo>
              )}
              <Campo etiqueta="Razón social">
                <input name="razon_social" defaultValue={inicial.razonSocial} required maxLength={200} className="campo" />
              </Campo>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Campo etiqueta="Tipo de proveedor">
                <select name="tipo" defaultValue={inicial.tipo} className="campo">
                  {tipos.map((t) => <option key={t.valor} value={t.valor}>{t.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="País (código de 2 letras)">
                <input name="pais" defaultValue={inicial.pais} required maxLength={2} list="paises" className="campo font-mono uppercase" />
                <datalist id="paises">{PAISES.map((p) => <option key={p} value={p} />)}</datalist>
              </Campo>
              <Campo etiqueta="Concepto de ISLR" ayuda={conceptos.length ? undefined : 'Contabilidad aún no ha registrado conceptos.'}>
                <select name="concepto_islr_id" defaultValue={inicial.conceptoIslrId} className="campo">
                  <option value="">Sin concepto</option>
                  {conceptos.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </Campo>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="domiciliado" defaultChecked={inicial.domiciliado} /> Domiciliado en Venezuela</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="contribuyente_especial" defaultChecked={inicial.contribuyenteEspecial} /> Contribuyente especial</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="agente_retencion_iva" defaultChecked={inicial.agenteRetencionIva} /> Agente de retención de IVA</label>
            </div>
          </fieldset>
        )}

        {conContacto && (
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-texto-2">Contacto</legend>
            <Campo etiqueta="Nombre comercial"><input name="nombre_comercial" defaultValue={inicial.nombreComercial} maxLength={200} className="campo" /></Campo>
            <Campo etiqueta="Dirección fiscal"><input name="direccion_fiscal" defaultValue={inicial.direccionFiscal} maxLength={300} className="campo" /></Campo>
            <Campo etiqueta="Teléfono"><input name="telefono" type="tel" defaultValue={inicial.telefono} maxLength={40} className="campo" /></Campo>
            <Campo etiqueta="Correo"><input name="email" type="email" defaultValue={inicial.email} maxLength={200} className="campo" /></Campo>
          </fieldset>
        )}

        {estado?.confirmar && (
          <label className="flex items-start gap-2 rounded-lg border border-advertencia/40 bg-advertencia/10 px-3 py-2 text-sm text-amber-200">
            <input type="checkbox" name="confirmar_nombre" className="mt-1" />
            Confirmo que es una empresa o persona distinta, aunque su nombre se parezca al de otro tercero.
          </label>
        )}
        {estado?.error && (
          <p role="alert" className="whitespace-pre-line rounded-lg border border-peligro/40 bg-peligro/10 px-3 py-2 text-sm text-red-200">{estado.error}</p>
        )}
        {estado?.ok && (
          <p role="status" className="rounded-lg border border-exito/40 bg-exito/10 px-3 py-2 text-sm text-emerald-200">{estado.ok}</p>
        )}
        <div className="flex justify-end"><BotonEnviar>{boton}</BotonEnviar></div>
      </PendienteProvider>
    </form>
  );
}
