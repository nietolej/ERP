'use server';

import Decimal from 'decimal.js';
import { revalidatePath } from 'next/cache';
import { mensajeDeError, texto, type EstadoAccion } from '@/lib/acciones';
import { claveTemporal, hashClave } from '@/lib/auth/clave';
import { ROLES, type Rol } from '@/lib/auth/constantes';
import { autorizar } from '@/lib/auth/dal';
import { eliminarSesionesDeUsuario } from '@/lib/auth/sesiones';
import { conUsuario } from '@/lib/db';

const RIF = /^[VEJPG]-[0-9]{8}-[0-9]$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Empresa y sucursales (administrador)
// ---------------------------------------------------------------------------
export async function guardarEmpresa(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('administrador');
    const rif = texto(fd, 'rif').toUpperCase();
    const razon = texto(fd, 'razon_social');
    if (!RIF.test(rif)) return { error: 'RIF inválido. Formato: J-12345678-9' };
    if (!razon) return { error: 'La razón social es obligatoria.' };
    const si = (c: string) => fd.get(c) === 'on';
    await conUsuario(u.id, (tx) => tx.query(
      `insert into empresa (id, rif, razon_social, domicilio_fiscal, contribuyente_especial,
                            agente_retencion_iva, agente_retencion_islr, agente_percepcion_igtf)
       values (1, $1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set rif = excluded.rif, razon_social = excluded.razon_social,
         domicilio_fiscal = excluded.domicilio_fiscal, contribuyente_especial = excluded.contribuyente_especial,
         agente_retencion_iva = excluded.agente_retencion_iva, agente_retencion_islr = excluded.agente_retencion_islr,
         agente_percepcion_igtf = excluded.agente_percepcion_igtf, updated_at = now()`,
      [rif, razon, texto(fd, 'domicilio_fiscal') || null, si('contribuyente_especial'),
       si('agente_retencion_iva'), si('agente_retencion_islr'), si('agente_percepcion_igtf')],
    ));
    revalidatePath('/', 'layout');
    return { ok: 'Datos de la empresa guardados.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function crearSucursal(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('administrador');
    const codigo = texto(fd, 'codigo').toUpperCase();
    const nombre = texto(fd, 'nombre');
    if (!/^[A-Z0-9]{2,6}$/.test(codigo)) return { error: 'Código: de 2 a 6 letras o números (p. ej. BQTO).' };
    if (!nombre) return { error: 'El nombre es obligatorio.' };
    await conUsuario(u.id, (tx) => tx.query(
      'insert into sucursal (codigo, nombre, direccion) values ($1, $2, $3)', [codigo, nombre, texto(fd, 'direccion') || null]));
    revalidatePath('/configuracion/empresa');
    return { ok: `Sucursal ${codigo} creada.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------------
// Tasas de cambio (tesorería, contabilidad)
// ---------------------------------------------------------------------------
export async function registrarTasa(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('tesoreria', 'contabilidad');
    const fecha = texto(fd, 'fecha');
    const moneda = texto(fd, 'moneda');
    const fuente = texto(fd, 'fuente');
    const valor = texto(fd, 'tasa').replace(',', '.');
    if (!FECHA.test(fecha)) return { error: 'Fecha inválida.' };
    if (!['USD', 'EUR', 'USDT'].includes(moneda)) return { error: 'Moneda inválida.' };
    if (!['BCV', 'PARALELO'].includes(fuente)) return { error: 'Fuente inválida.' };
    let d: Decimal;
    try { d = new Decimal(valor); } catch { return { error: 'La tasa debe ser un número (p. ej. 36.5123).' }; }
    if (d.lte(0) || d.decimalPlaces() > 6) return { error: 'La tasa debe ser mayor que cero y tener como máximo 6 decimales.' };
    await conUsuario(u.id, (tx) => tx.query(
      'insert into tasa_cambio (fecha, moneda, fuente, tasa, registrado_por) values ($1, $2, $3, $4, $5)',
      [fecha, moneda, fuente, d.toString(), u.id]));
    revalidatePath('/', 'layout');
    return { ok: `Tasa ${fuente} ${moneda} del ${fecha.split('-').reverse().join('-')} registrada.` };
  } catch (e) {
    const err = e as { code?: string };
    if (err?.code === '23505') return { error: 'Ya hay una tasa registrada para esa fecha, moneda y fuente. Las tasas no se reemplazan.' };
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------------
// Parámetros fiscales (contabilidad)
// ---------------------------------------------------------------------------
export async function validarParametro(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    await conUsuario(u.id, (tx) => tx.query(
      'update parametro_fiscal set validado_por_contador = true where id = $1', [texto(fd, 'id')]));
    revalidatePath('/configuracion/parametros-fiscales');
    return { ok: 'Parámetro marcado como validado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

/** Nueva vigencia: cierra la vigencia abierta el día anterior y crea la nueva (sin tocar el código). */
export async function nuevaVigencia(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('contabilidad');
    const codigo = texto(fd, 'codigo');
    const desde = texto(fd, 'vigente_desde');
    const valor = texto(fd, 'valor').replace(',', '.');
    if (!FECHA.test(desde)) return { error: 'Fecha de vigencia inválida.' };
    let d: Decimal;
    try { d = new Decimal(valor); } catch { return { error: 'El valor debe ser un número.' }; }
    if (d.isNegative()) return { error: 'El valor no puede ser negativo.' };
    await conUsuario(u.id, async (tx) => {
      const { rows } = await tx.query<{ descripcion: string; unidad: string; fuente_normativa: string | null }>(
        `select descripcion, unidad, fuente_normativa from parametro_fiscal
          where codigo = $1 order by vigente_desde desc limit 1`, [codigo]);
      if (!rows[0]) throw Object.assign(new Error(`El parámetro ${codigo} no existe.`), { code: 'P0001' });
      await tx.query(
        `update parametro_fiscal set vigente_hasta = ($2::date - 1)
          where codigo = $1 and vigente_hasta is null and vigente_desde < $2::date`, [codigo, desde]);
      await tx.query(
        `insert into parametro_fiscal (codigo, descripcion, valor, unidad, vigente_desde, fuente_normativa, validado_por_contador, created_by)
         values ($1, $2, $3, $4, $5, $6, true, $7)`,
        [codigo, rows[0].descripcion, d.toString(), rows[0].unidad, desde, texto(fd, 'fuente_normativa') || rows[0].fuente_normativa, u.id]);
    });
    revalidatePath('/configuracion/parametros-fiscales');
    return { ok: `Nueva vigencia de ${codigo} desde el ${desde.split('-').reverse().join('-')} registrada.` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

// ---------------------------------------------------------------------------
// Usuarios (administrador)
// ---------------------------------------------------------------------------
function rolesDe(fd: FormData): Rol[] {
  return fd.getAll('roles').filter((r): r is Rol => typeof r === 'string' && (ROLES as readonly string[]).includes(r));
}

export async function crearUsuario(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('administrador');
    const nombre = texto(fd, 'nombre');
    const email = texto(fd, 'email').toLowerCase();
    const roles = rolesDe(fd);
    if (!nombre) return { error: 'El nombre es obligatorio.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Correo inválido.' };
    if (roles.length === 0) return { error: 'Asigne al menos un rol.' };
    const clave = claveTemporal();
    const hash = await hashClave(clave);
    await conUsuario(u.id, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'insert into usuario (email, nombre, password_hash) values ($1, $2, $3) returning id', [email, nombre, hash]);
      for (const r of roles) {
        await tx.query('insert into usuario_rol (usuario_id, rol) values ($1, $2)', [rows[0].id, r]);
      }
    });
    revalidatePath('/configuracion/usuarios');
    return { ok: `Usuario ${email} creado.\nClave temporal (se muestra una sola vez): ${clave}\nDebe cambiarla en su primer ingreso.` };
  } catch (e) {
    const err = e as { code?: string };
    if (err?.code === '23505') return { error: 'Ya existe un usuario con ese correo.' };
    return { error: mensajeDeError(e) };
  }
}

export async function actualizarUsuario(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('administrador');
    const id = texto(fd, 'id');
    const roles = rolesDe(fd);
    const activo = fd.get('activo') === 'on';
    if (id === u.id && (!activo || !roles.includes('administrador'))) {
      return { error: 'No puede desactivarse ni quitarse el rol de administrador a sí mismo.' };
    }
    await conUsuario(u.id, async (tx) => {
      await tx.query('update usuario set activo = $2 where id = $1', [id, activo]);
      await tx.query('delete from usuario_rol where usuario_id = $1 and not (rol = any($2::text[]))', [id, roles]);
      for (const r of roles) {
        await tx.query('insert into usuario_rol (usuario_id, rol) values ($1, $2) on conflict do nothing', [id, r]);
      }
      if (!activo) await eliminarSesionesDeUsuario(tx, id);
    });
    revalidatePath('/configuracion/usuarios');
    return { ok: 'Usuario actualizado.' };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}

export async function restablecerClave(_: EstadoAccion, fd: FormData): Promise<EstadoAccion> {
  try {
    const u = await autorizar('administrador');
    const id = texto(fd, 'id');
    const clave = claveTemporal();
    const hash = await hashClave(clave);
    await conUsuario(u.id, async (tx) => {
      await tx.query('update usuario set password_hash = $2, debe_cambiar_password = true where id = $1', [id, hash]);
      await eliminarSesionesDeUsuario(tx, id);
    });
    return { ok: `Clave temporal (se muestra una sola vez): ${clave}` };
  } catch (e) {
    return { error: mensajeDeError(e) };
  }
}
