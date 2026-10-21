'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import {
  ROLES_GESTIONAN_CUENTAS, TIPOS_CUENTA, actualizarCuentaBancaria, crearCuentaBancaria, type TipoCuenta,
} from '@/lib/maestros/cuentas-bancarias';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function crearCuentaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_CUENTAS);
    const tipo = texto(fd, 'tipo');
    if (!(TIPOS_CUENTA as readonly string[]).includes(tipo)) return { error: 'Seleccione el tipo de cuenta.' };
    const banco = texto(fd, 'banco_id');
    const r = await conUsuario(u.id, (tx) => crearCuentaBancaria(tx, {
      nombre: texto(fd, 'nombre'), tipo: tipo as TipoCuenta, moneda: texto(fd, 'moneda').toUpperCase(),
      bancoId: UUID.test(banco) ? banco : undefined, numero: texto(fd, 'numero'),
    }));
    revalidatePath('/tesoreria/cuentas');
    return { ok: `Cuenta ${r.codigo} registrada con su subcuenta contable ${r.cuentaContable}.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarCuentaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_CUENTAS);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Cuenta inválida.' };
    await conUsuario(u.id, (tx) => actualizarCuentaBancaria(tx, id, { nombre: texto(fd, 'nombre'), activa: fd.get('activa') === 'on' }));
    revalidatePath('/tesoreria/cuentas');
    return { ok: 'Cuenta actualizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
