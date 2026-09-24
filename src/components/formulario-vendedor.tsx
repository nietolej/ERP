'use client';

import { useState } from 'react';
import { BotonEnviar, PendienteProvider, useEnvio } from '@/components/formulario';
import { Campo } from '@/components/ui';
import type { EstadoAccion } from '@/lib/acciones';
import { problemaDeRif } from '@/lib/maestros/rif';

export interface OpcionSimple {
  id: string;
  nombre: string;
}

export interface ValoresVendedor {
  id?: string;
  nombre: string;
  tipo: string;
  sucursalId: string;
  usuarioId: string;
  rif: string;
}

interface Props {
  accion: (estado: EstadoAccion, fd: FormData) => Promise<EstadoAccion>;
  sucursales: OpcionSimple[];
  usuarios: OpcionSimple[];
  tipos: { valor: string; nombre: string }[];
  inicial: ValoresVendedor;
}

const AYUDA_TIPO: Record<string, string> = {
  interno: 'Empleado de la empresa: entra en rankings y comisiones.',
  externo: 'Comisionista con RIF propio: sus comisiones llevan retención de ISLR.',
  administrativo: 'Uso interno de la empresa: no entra en rankings ni comisiones.',
  casa: 'Ventas de mostrador o de la casa: no entra en rankings ni comisiones.',
};

export function FormularioVendedor({ accion, sucursales, usuarios, tipos, inicial }: Props) {
  const { estado, pendiente, alEnviar } = useEnvio(accion);
  const [tipo, setTipo] = useState(inicial.tipo || 'interno');
  const [rif, setRif] = useState(inicial.rif);
  const problema = tipo === 'externo' && rif.trim().length >= 3 ? problemaDeRif(rif) : null;

  return (
    <form onSubmit={alEnviar} className="space-y-5">
      <PendienteProvider value={pendiente}>
        {inicial.id && <input type="hidden" name="id" value={inicial.id} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo etiqueta="Nombre">
            <input name="nombre" defaultValue={inicial.nombre} required maxLength={120} className="campo" />
          </Campo>
          <Campo etiqueta="Tipo" ayuda={AYUDA_TIPO[tipo]}>
            <select name="tipo" value={tipo} onChange={(e) => setTipo(e.target.value)} className="campo">
              {tipos.map((t) => <option key={t.valor} value={t.valor}>{t.nombre}</option>)}
            </select>
          </Campo>
          {tipo === 'externo' && (
            <Campo etiqueta="RIF del comisionista">
              <input name="rif" value={rif} onChange={(e) => setRif(e.target.value)} required autoComplete="off"
                placeholder="V-12345678-9" className="campo font-mono uppercase" />
              {problema && <span className="mt-1 block text-xs text-amber-300">{problema}</span>}
            </Campo>
          )}
          <Campo etiqueta="Sucursal">
            <select name="sucursal_id" defaultValue={inicial.sucursalId} className="campo">
              <option value="">Sin asignar</option>
              {sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Usuario del ERP" ayuda="Con él, el vendedor ve solo su cartera de clientes. Debe tener el rol Ventas o Supervisor de ventas.">
            <select name="usuario_id" defaultValue={inicial.usuarioId} className="campo">
              <option value="">Sin usuario</option>
              {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
            </select>
          </Campo>
        </div>

        {estado?.confirmar && (
          <label className="flex items-start gap-2 rounded-lg border border-advertencia/40 bg-advertencia/10 px-3 py-2 text-sm text-amber-200">
            <input type="checkbox" name="confirmar_nombre" className="mt-1" />
            Confirmo que es una persona distinta, aunque su nombre se parezca al de otro tercero.
          </label>
        )}
        {estado?.error && (
          <p role="alert" className="whitespace-pre-line rounded-lg border border-peligro/40 bg-peligro/10 px-3 py-2 text-sm text-red-200">{estado.error}</p>
        )}
        <div className="flex justify-end">
          <BotonEnviar>{inicial.id ? 'Guardar cambios' : 'Registrar vendedor'}</BotonEnviar>
        </div>
      </PendienteProvider>
    </form>
  );
}
