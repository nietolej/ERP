'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { autorizar } from '@/lib/auth/dal';
import { conUsuario } from '@/lib/db';
import {
  MODALIDADES, ROLES_GESTIONAN_TARIFAS, ROLES_GESTIONAN_TRANSPORTISTAS, UNIDADES_COBRO, actualizarTransportista, actualizarVehiculo,
  agregarTarifa, cerrarTarifa, crearTransportista, crearVehiculo, type Modalidad, type UnidadCobro,
} from '@/lib/maestros/transportistas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (fd: FormData, campo = 'id') => (UUID.test(texto(fd, campo)) ? texto(fd, campo) : null);

export async function crearTransportistaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  let nuevo: string;
  try {
    const u = await autorizar(...ROLES_GESTIONAN_TRANSPORTISTAS);
    const modalidad = texto(fd, 'modalidad');
    if (!(MODALIDADES as readonly string[]).includes(modalidad)) return { error: 'Seleccione la modalidad.' };
    ({ id: nuevo } = await conUsuario(u.id, (tx) => crearTransportista(tx, {
      nombre: texto(fd, 'nombre'), modalidad: modalidad as Modalidad, proveedorId: id(fd, 'proveedor_id') ?? undefined,
      contactoTelefono: texto(fd, 'contacto_telefono'), observaciones: texto(fd, 'observaciones'),
    })));
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
  revalidatePath('/maestros/transportistas');
  redirect(`/maestros/transportistas/${nuevo}`);
}

export async function actualizarTransportistaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_TRANSPORTISTAS);
    const t = id(fd);
    if (!t) return { error: 'Transportista inválido.' };
    await conUsuario(u.id, (tx) => actualizarTransportista(tx, t, {
      nombre: texto(fd, 'nombre'), contactoTelefono: texto(fd, 'contacto_telefono'), observaciones: texto(fd, 'observaciones'),
      activo: fd.get('activo') === 'on',
    }));
    revalidatePath(`/maestros/transportistas/${t}`);
    revalidatePath('/maestros/transportistas');
    return { ok: 'Transportista actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

const leerVehiculo = (fd: FormData) => ({
  descripcion: texto(fd, 'descripcion'), capacidadKg: texto(fd, 'capacidad_kg'), capacidadM3: texto(fd, 'capacidad_m3'),
  costoKmUsd: texto(fd, 'costo_km_usd'), costoHoraUsd: texto(fd, 'costo_hora_usd'),
});

export async function crearVehiculoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_TRANSPORTISTAS);
    const t = id(fd, 'transportista_id');
    if (!t) return { error: 'Transportista inválido.' };
    await conUsuario(u.id, (tx) => crearVehiculo(tx, t, { placa: texto(fd, 'placa'), ...leerVehiculo(fd) }));
    revalidatePath(`/maestros/transportistas/${t}`);
    return { ok: 'Vehículo registrado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarVehiculoAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_TRANSPORTISTAS);
    const v = id(fd);
    const t = id(fd, 'transportista_id');
    if (!v || !t) return { error: 'Vehículo inválido.' };
    await conUsuario(u.id, (tx) => actualizarVehiculo(tx, v, { ...leerVehiculo(fd), activo: fd.get('activo') === 'on' }));
    revalidatePath(`/maestros/transportistas/${t}`);
    return { ok: 'Vehículo actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function agregarTarifaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_TARIFAS);
    const t = id(fd, 'transportista_id');
    const unidad = texto(fd, 'unidad_cobro');
    if (!t || !(UNIDADES_COBRO as readonly string[]).includes(unidad)) return { error: 'Revise el transportista y la unidad de cobro.' };
    await conUsuario(u.id, (tx) => agregarTarifa(tx, t, {
      entidadFederal: texto(fd, 'entidad_federal'), ciudad: texto(fd, 'ciudad'), unidadCobro: unidad as UnidadCobro,
      moneda: texto(fd, 'moneda'), monto: texto(fd, 'monto'), minimo: texto(fd, 'minimo'), vigenteDesde: texto(fd, 'vigente_desde'),
    }));
    revalidatePath(`/maestros/transportistas/${t}`);
    return { ok: 'Tarifa registrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function cerrarTarifaAccion(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar(...ROLES_GESTIONAN_TARIFAS);
    const tarifa = id(fd);
    const t = id(fd, 'transportista_id');
    if (!tarifa || !t) return { error: 'Tarifa inválida.' };
    await conUsuario(u.id, (tx) => cerrarTarifa(tx, tarifa, texto(fd, 'hasta')));
    revalidatePath(`/maestros/transportistas/${t}`);
    return { ok: 'Vigencia cerrada.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
