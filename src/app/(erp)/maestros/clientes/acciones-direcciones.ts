'use server';

import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { ErrorPermiso, autorizar } from '@/lib/auth/dal';
import { conUsuario, getDb } from '@/lib/db';
import {
  ROLES_EDITAN_DIRECCIONES, actualizarDireccion, crearDireccion, puedeEditarDirecciones, fijarVentanas,
  type DatosDireccion, type Ventana,
} from '@/lib/maestros/direcciones';
import { ErrorMaestro } from '@/lib/maestros/terceros';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leerDireccion(fd: FormData): DatosDireccion {
  return {
    nombre: texto(fd, 'nombre'),
    direccion: texto(fd, 'direccion'),
    ciudad: texto(fd, 'ciudad'),
    entidadFederal: texto(fd, 'entidad_federal'),
    coordenadas: texto(fd, 'coordenadas'),
    contactoNombre: texto(fd, 'contacto_nombre'),
    contactoTelefono: texto(fd, 'contacto_telefono'),
    minutosDescarga: Number(texto(fd, 'minutos_descarga') || '15'),
    ventanaTipo: texto(fd, 'ventana_tipo') === 'dura' ? 'dura' : 'blanda',
    observaciones: texto(fd, 'observaciones'),
    predeterminada: fd.get('predeterminada') === 'on',
  };
}

/** Horario de recepción: hasta dos rangos por día (campos v{día}_{1|2}_desde y _hasta). */
function leerVentanas(fd: FormData): Ventana[] {
  const ventanas: Ventana[] = [];
  for (let dia = 1; dia <= 7; dia++) {
    for (const n of [1, 2]) {
      const desde = texto(fd, `v${dia}_${n}_desde`);
      const hasta = texto(fd, `v${dia}_${n}_hasta`);
      if (!desde && !hasta) continue;
      if (!desde || !hasta) throw new ErrorMaestro('En cada horario de recepción indique la hora inicial y la final.');
      ventanas.push({ dia, desde, hasta });
    }
  }
  return ventanas;
}

async function exigirPuedeEditar(u: { id: string; roles: readonly string[] }, clienteId: string): Promise<void> {
  if (!(await puedeEditarDirecciones(await getDb(), u, clienteId))) throw new ErrorPermiso('No tiene permiso para cambiar las direcciones de este cliente.');
}

export async function crearDireccionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_EDITAN_DIRECCIONES);
    const clienteId = texto(fd, 'cliente_id');
    if (!UUID.test(clienteId)) return { error: 'Cliente inválido.' };
    await exigirPuedeEditar(u, clienteId);
    await conUsuario(u.id, (tx) => crearDireccion(tx, clienteId, leerDireccion(fd), leerVentanas(fd)));
    revalidatePath(`/maestros/clientes/${clienteId}`);
    return { ok: 'Dirección de entrega registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarDireccionAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_EDITAN_DIRECCIONES);
    const id = texto(fd, 'id');
    if (!UUID.test(id)) return { error: 'Dirección inválida.' };
    const { rows } = await (await getDb()).query<{ cliente_id: string }>('select cliente_id from cliente_direccion_entrega where id = $1', [id]);
    if (!rows[0]) return { error: 'La dirección no existe.' };
    await exigirPuedeEditar(u, rows[0].cliente_id);
    await conUsuario(u.id, async (tx) => {
      await actualizarDireccion(tx, id, { ...leerDireccion(fd), activa: fd.get('activa') === 'on' });
      await fijarVentanas(tx, id, leerVentanas(fd));
    });
    revalidatePath(`/maestros/clientes/${rows[0].cliente_id}`);
    return { ok: 'Dirección actualizada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
