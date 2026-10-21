import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { puedeVerCliente } from './clientes';
import { ErrorMaestro, vacioANull } from './terceros';

/**
 * Direcciones de entrega del cliente con ubicación y horario de recepción (§5.1, migración 0026).
 * Una dirección no se borra: se inactiva. La primera vigente de un cliente es la predeterminada.
 * La base de datos rechaza coordenadas fuera de Venezuela y horarios solapados.
 */

/** Ven y cambian direcciones en cualquier cliente; Ventas solo en los de su cartera. */
export const ROLES_EDITAN_DIRECCIONES = ['facturacion', 'supervisor_ventas', 'gerencia', 'ventas'] as const satisfies readonly Rol[];

export const NOMBRE_DIA = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] as const;

export interface DatosDireccion {
  nombre: string;
  direccion: string;
  ciudad: string;
  entidadFederal: string;
  /** "10.0678, -69.3467" (latitud, longitud). Vacío = dirección sin ubicar. */
  coordenadas?: string;
  contactoNombre?: string;
  contactoTelefono?: string;
  minutosDescarga?: number;
  ventanaTipo?: 'blanda' | 'dura';
  observaciones?: string;
  predeterminada?: boolean;
}

export interface Ventana {
  dia: number;      // 1 = lunes … 7 = domingo
  desde: string;    // HH:MM, hora de Caracas
  hasta: string;
}

const DECIMAL = /^-?\d{1,3}(\.\d{1,8})?$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Lee las coordenadas como las copian las aplicaciones de mapas: "10.0678, -69.3467", "10.0678 -69.3467" o con coma
 * decimal y punto y coma ("10,0678; -69,3467"). Devuelve null si el texto está vacío.
 */
export function leerCoordenadas(entrada: string | undefined): { latitud: string; longitud: string } | null {
  const s = (entrada ?? '').trim();
  if (!s) return null;
  let partes: string[];
  if (s.includes(';')) partes = s.split(';');
  else if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s)) partes = s.split(',');
  else partes = s.split(/\s+/);
  partes = partes.map((p) => p.trim().replace(',', '.'));
  if (partes.length !== 2 || !partes.every((p) => DECIMAL.test(p))) {
    throw new ErrorMaestro('Las coordenadas deben ser latitud y longitud, por ejemplo: 10.0678, -69.3467');
  }
  const [latitud, longitud] = partes;
  if (Math.abs(Number(latitud)) > 90 || Math.abs(Number(longitud)) > 180) {
    throw new ErrorMaestro('La latitud va de -90 a 90 y la longitud de -180 a 180.');
  }
  // Venezuela está entre 0,5° y 12,5° de latitud norte: si vienen al revés, se avisa con claridad.
  if (Number(latitud) < 0.5 || Number(latitud) > 12.5 || Number(longitud) < -73.5 || Number(longitud) > -59.5) {
    throw new ErrorMaestro('Las coordenadas quedan fuera de Venezuela. Verifique que escribió primero la latitud (aprox. 0,5 a 12,5) y luego la longitud (aprox. -73,5 a -59,5).');
  }
  return { latitud, longitud };
}

function validar(d: DatosDireccion): void {
  const errores: string[] = [];
  if (d.nombre.trim().length < 2) errores.push('Indique el nombre de la dirección (por ejemplo, "Sede principal").');
  if (d.direccion.trim().length < 5) errores.push('Indique la dirección completa.');
  if (d.ciudad.trim().length < 2) errores.push('Indique la ciudad.');
  if (d.entidadFederal.trim().length < 2) errores.push('Indique el estado.');
  const minutos = d.minutosDescarga ?? 15;
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > 480) errores.push('El tiempo de descarga va de 1 a 480 minutos.');
  if (d.ventanaTipo && !['blanda', 'dura'].includes(d.ventanaTipo)) errores.push('El tipo de ventana debe ser blanda o dura.');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

async function exigirCliente(tx: Db, clienteId: string): Promise<void> {
  const { rows } = await tx.query('select 1 from cliente where tercero_id = $1', [clienteId]);
  if (!rows.length) throw new ErrorMaestro('El cliente no existe.');
}

/** Crea una dirección de entrega y, si se indican, sus ventanas de recepción. Devuelve su id. */
export async function crearDireccion(tx: Db, clienteId: string, d: DatosDireccion, ventanas: Ventana[] = []): Promise<string> {
  validar(d);
  const c = leerCoordenadas(d.coordenadas);
  await exigirCliente(tx, clienteId);
  const { rows } = await tx.query<{ id: string }>(
    `insert into cliente_direccion_entrega
       (cliente_id, nombre, direccion, ciudad, entidad_federal, latitud, longitud, contacto_nombre, contacto_telefono,
        minutos_descarga, ventana_tipo, observaciones, predeterminada)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [clienteId, d.nombre.trim(), d.direccion.trim(), d.ciudad.trim(), d.entidadFederal.trim(), c?.latitud ?? null, c?.longitud ?? null,
     vacioANull(d.contactoNombre), vacioANull(d.contactoTelefono), d.minutosDescarga ?? 15, d.ventanaTipo ?? 'blanda',
     vacioANull(d.observaciones), d.predeterminada ?? false]);
  if (ventanas.length) await fijarVentanas(tx, rows[0].id, ventanas);
  return rows[0].id;
}

export async function actualizarDireccion(tx: Db, id: string, d: DatosDireccion & { activa: boolean }): Promise<void> {
  validar(d);
  const c = leerCoordenadas(d.coordenadas);
  const { rows } = await tx.query(
    `update cliente_direccion_entrega
        set nombre = $2, direccion = $3, ciudad = $4, entidad_federal = $5, latitud = $6, longitud = $7,
            contacto_nombre = $8, contacto_telefono = $9, minutos_descarga = $10, ventana_tipo = $11, observaciones = $12,
            predeterminada = $13, activa = $14
      where id = $1 returning id`,
    [id, d.nombre.trim(), d.direccion.trim(), d.ciudad.trim(), d.entidadFederal.trim(), c?.latitud ?? null, c?.longitud ?? null,
     vacioANull(d.contactoNombre), vacioANull(d.contactoTelefono), d.minutosDescarga ?? 15, d.ventanaTipo ?? 'blanda',
     vacioANull(d.observaciones), d.predeterminada ?? false, d.activa]);
  if (!rows[0]) throw new ErrorMaestro('La dirección no existe.');
}

/** Reemplaza el horario de recepción de la dirección. Una lista vacía deja a la dirección sin ventana (recibe a cualquier hora). */
export async function fijarVentanas(tx: Db, direccionId: string, ventanas: Ventana[]): Promise<void> {
  for (const v of ventanas) {
    if (!Number.isInteger(v.dia) || v.dia < 1 || v.dia > 7) throw new ErrorMaestro('El día de la ventana debe ir de 1 (lunes) a 7 (domingo).');
    if (!HORA.test(v.desde) || !HORA.test(v.hasta)) throw new ErrorMaestro('Las horas de la ventana deben tener el formato HH:MM.');
    if (v.hasta <= v.desde) throw new ErrorMaestro(`${NOMBRE_DIA[v.dia]}: la hora final debe ser posterior a la inicial.`);
  }
  const { rows } = await tx.query('select 1 from cliente_direccion_entrega where id = $1 for update', [direccionId]);
  if (!rows.length) throw new ErrorMaestro('La dirección no existe.');
  await tx.query('delete from cliente_direccion_ventana where direccion_id = $1', [direccionId]);
  for (const v of ventanas) {
    await tx.query(
      'insert into cliente_direccion_ventana (direccion_id, dia_semana, hora_desde, hora_hasta) values ($1, $2, $3, $4)',
      [direccionId, v.dia, v.desde, v.hasta]);
  }
}

export interface FilaDireccion {
  id: string;
  nombre: string;
  direccion: string;
  ciudad: string;
  entidad_federal: string;
  latitud: string | null;
  longitud: string | null;
  contacto_nombre: string | null;
  contacto_telefono: string | null;
  minutos_descarga: number;
  ventana_tipo: 'blanda' | 'dura';
  observaciones: string | null;
  predeterminada: boolean;
  activa: boolean;
  ventanas: Ventana[];
}

export async function listarDirecciones(db: Db, clienteId: string, incluirInactivas = true): Promise<FilaDireccion[]> {
  const { rows } = await db.query<Omit<FilaDireccion, 'ventanas'>>(
    `select id, nombre, direccion, ciudad, entidad_federal, latitud::text, longitud::text, contacto_nombre, contacto_telefono,
            minutos_descarga, ventana_tipo, observaciones, predeterminada, activa
       from cliente_direccion_entrega
      where cliente_id = $1 and ($2 or activa)
      order by activa desc, predeterminada desc, nombre`, [clienteId, incluirInactivas]);
  if (!rows.length) return [];
  const { rows: v } = await db.query<{ direccion_id: string; dia: number; desde: string; hasta: string }>(
    `select direccion_id, dia_semana as dia, to_char(hora_desde, 'HH24:MI') as desde, to_char(hora_hasta, 'HH24:MI') as hasta
       from cliente_direccion_ventana where direccion_id = any($1::uuid[]) order by dia_semana, hora_desde`,
    [rows.map((r) => r.id)]);
  return rows.map((r) => ({
    ...r,
    ventanas: v.filter((x) => x.direccion_id === r.id).map(({ dia, desde, hasta }) => ({ dia, desde, hasta })),
  }));
}

/** Resumen legible del horario: "Lun-Vie 08:00-12:00, 14:00-17:00". Sin ventana: "Cualquier hora". */
export function resumenVentanas(ventanas: Ventana[]): string {
  if (!ventanas.length) return 'Cualquier hora';
  const porRango = new Map<string, number[]>();
  for (const v of ventanas) {
    const k = `${v.desde}-${v.hasta}`;
    porRango.set(k, [...(porRango.get(k) ?? []), v.dia]);
  }
  const dias = new Map<string, string[]>();
  for (const [rango, ds] of porRango) {
    const clave = [...ds].sort((a, b) => a - b).join(',');
    dias.set(clave, [...(dias.get(clave) ?? []), rango]);
  }
  return [...dias].map(([clave, rangos]) => {
    const ds = clave.split(',').map(Number);
    const texto = ds.length > 2 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1)
      ? `${NOMBRE_DIA[ds[0]].slice(0, 3)}-${NOMBRE_DIA[ds[ds.length - 1]].slice(0, 3)}`
      : ds.map((d) => NOMBRE_DIA[d].slice(0, 3)).join(', ');
    return `${texto} ${rangos.join(', ')}`;
  }).join(' · ');
}

/** ¿Puede el usuario cambiar las direcciones de este cliente? */
export async function puedeEditarDirecciones(db: Db, u: { id: string; roles: readonly string[] }, clienteId: string): Promise<boolean> {
  if (!u.roles.some((r) => (ROLES_EDITAN_DIRECCIONES as readonly string[]).includes(r))) return false;
  return puedeVerCliente(db, u, clienteId);
}
