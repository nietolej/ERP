import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro, vacioANull } from './terceros';

/**
 * Transportistas, vehículos y tarifas (§6.4, migración 0026).
 * - Flota propia: sin proveedor ni tarifas; sus vehículos llevan capacidad y costo por km y por hora.
 * - Carga y encomienda: son un proveedor de servicios ya aprobado (§5.1). La encomienda no tiene vehículos.
 * - Las tarifas no se editan: una nueva trae su vigencia y cierra la anterior del mismo destino y unidad.
 */

export const MODALIDADES = ['flota_propia', 'carga', 'encomienda'] as const;
export type Modalidad = (typeof MODALIDADES)[number];
export const NOMBRE_MODALIDAD: Record<Modalidad, string> = {
  flota_propia: 'Flota propia',
  carga: 'Transportista de carga',
  encomienda: 'Servicio de encomienda',
};

export const UNIDADES_COBRO = ['por_viaje', 'por_kg', 'por_m3', 'por_bulto'] as const;
export type UnidadCobro = (typeof UNIDADES_COBRO)[number];
export const NOMBRE_UNIDAD_COBRO: Record<UnidadCobro, string> = {
  por_viaje: 'Por viaje', por_kg: 'Por kg', por_m3: 'Por m³', por_bulto: 'Por bulto',
};

/** Registran transportistas y vehículos. */
export const ROLES_GESTIONAN_TRANSPORTISTAS = ['gerencia', 'compras', 'almacen'] as const satisfies readonly Rol[];
/** Cargan tarifas: es un dato comercial de Compras, aprobado por la lógica del proveedor. */
export const ROLES_GESTIONAN_TARIFAS = ['gerencia', 'compras'] as const satisfies readonly Rol[];
export const ROLES_VEN_TRANSPORTISTAS = ['gerencia', 'compras', 'almacen', 'supervisor_ventas', 'facturacion', 'tesoreria', 'auditor'] as const satisfies readonly Rol[];

type Usuario = { id: string; roles: readonly string[] };

const DECIMAL = (enteros: number, decimales: number) => new RegExp(`^\\d{1,${enteros}}(\\.\\d{1,${decimales}})?$`);

function decimalOpcional(valor: string | undefined, etiqueta: string, enteros: number, decimales: number, mayorQueCero: boolean): string | null {
  const v = (valor ?? '').trim().replace(',', '.');
  if (!v) return null;
  if (!DECIMAL(enteros, decimales).test(v) || (mayorQueCero && Number(v) <= 0)) {
    throw new ErrorMaestro(`${etiqueta}: indique un número${mayorQueCero ? ' mayor que cero' : ''} con hasta ${decimales} decimales.`);
  }
  return v;
}

// ---------------------------------------------------------------------
// Transportistas
// ---------------------------------------------------------------------

export interface DatosTransportista {
  nombre: string;
  modalidad: Modalidad;
  /** Obligatorio para carga y encomienda: un proveedor de servicios aprobado. */
  proveedorId?: string;
  contactoTelefono?: string;
  observaciones?: string;
}

export async function crearTransportista(tx: Db, d: DatosTransportista): Promise<{ id: string; codigo: string }> {
  if (d.nombre.trim().length < 2) throw new ErrorMaestro('Indique el nombre del transportista.');
  if (!MODALIDADES.includes(d.modalidad)) throw new ErrorMaestro('Seleccione la modalidad.');
  if (d.modalidad === 'flota_propia' && d.proveedorId) throw new ErrorMaestro('La flota propia no tiene proveedor.');
  if (d.modalidad !== 'flota_propia' && !d.proveedorId) {
    throw new ErrorMaestro('Un transportista de terceros es un proveedor de servicios: seleccione el proveedor (regístrelo y apruébelo antes en Maestros → Proveedores).');
  }
  const { rows: igual } = await tx.query<{ codigo: string }>(
    `select codigo from transportista
      where fn_nombre_normalizado(nombre) = fn_nombre_normalizado($1) or (proveedor_id = $2 and modalidad = $3)`,
    [d.nombre, d.proveedorId || null, d.modalidad]);
  if (igual[0]) throw new ErrorMaestro(`Ya existe el transportista ${igual[0].codigo} con ese nombre o con ese proveedor y modalidad.`);
  const { rows } = await tx.query<{ id: string; codigo: string }>(
    `insert into transportista (nombre, modalidad, proveedor_id, contacto_telefono, observaciones)
     values ($1, $2, $3, $4, $5) returning id, codigo`,
    [d.nombre.trim(), d.modalidad, d.proveedorId || null, vacioANull(d.contactoTelefono), vacioANull(d.observaciones)]);
  return rows[0];
}

export async function actualizarTransportista(
  tx: Db, id: string, d: { nombre: string; contactoTelefono?: string; observaciones?: string; activo: boolean },
): Promise<void> {
  if (d.nombre.trim().length < 2) throw new ErrorMaestro('Indique el nombre del transportista.');
  const { rows } = await tx.query(
    'update transportista set nombre = $2, contacto_telefono = $3, observaciones = $4, activo = $5 where id = $1 returning id',
    [id, d.nombre.trim(), vacioANull(d.contactoTelefono), vacioANull(d.observaciones), d.activo]);
  if (!rows[0]) throw new ErrorMaestro('El transportista no existe.');
}

export interface FilaTransportista {
  id: string;
  codigo: string;
  nombre: string;
  modalidad: Modalidad;
  proveedor: string | null;
  vehiculos: number;
  tarifas_vigentes: number;
  activo: boolean;
}

export async function buscarTransportistas(db: Db, filtro: { modalidad?: string; soloActivos?: boolean } = {}): Promise<FilaTransportista[]> {
  const { rows } = await db.query<FilaTransportista>(
    `select t.id, t.codigo, t.nombre, t.modalidad, p.codigo || ' · ' || te.razon_social as proveedor,
            (select count(*)::int from vehiculo v where v.transportista_id = t.id and v.activo) as vehiculos,
            (select count(*)::int from transportista_tarifa f
              where f.transportista_id = t.id and f.vigente_desde <= ((now() at time zone 'America/Caracas')::date)
                and (f.vigente_hasta is null or f.vigente_hasta >= ((now() at time zone 'America/Caracas')::date))) as tarifas_vigentes,
            t.activo
       from transportista t
       left join proveedor p on p.tercero_id = t.proveedor_id
       left join tercero te on te.id = t.proveedor_id
      where ($1 = '' or t.modalidad = $1) and (not $2 or t.activo)
      order by t.activo desc, t.codigo`,
    [filtro.modalidad ?? '', filtro.soloActivos ?? false]);
  return rows;
}

/** Proveedores de servicios aprobados que aún no son transportista de esa modalidad. */
export async function proveedoresDeServicio(db: Db): Promise<{ id: string; nombre: string }[]> {
  const { rows } = await db.query<{ id: string; nombre: string }>(
    `select p.tercero_id as id, p.codigo || ' · ' || t.razon_social as nombre
       from proveedor p join tercero t on t.id = p.tercero_id
      where p.tipo = 'servicios' and p.estado = 'activo' order by p.codigo`);
  return rows;
}

// ---------------------------------------------------------------------
// Vehículos
// ---------------------------------------------------------------------

export interface DatosVehiculo {
  placa: string;
  descripcion: string;
  capacidadKg?: string;
  capacidadM3?: string;
  costoKmUsd?: string;
  costoHoraUsd?: string;
}

function camposVehiculo(d: DatosVehiculo) {
  if (d.descripcion.trim().length < 2) throw new ErrorMaestro('Describa el vehículo (por ejemplo, "Camión 350").');
  return [
    d.descripcion.trim(),
    decimalOpcional(d.capacidadKg, 'Capacidad en kg', 8, 2, true),
    decimalOpcional(d.capacidadM3, 'Capacidad en m³', 5, 3, true),
    decimalOpcional(d.costoKmUsd, 'Costo por km', 6, 4, false),
    decimalOpcional(d.costoHoraUsd, 'Costo por hora', 8, 2, false),
  ];
}

export async function crearVehiculo(tx: Db, transportistaId: string, d: DatosVehiculo): Promise<string> {
  const placa = d.placa.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{5,10}$/.test(placa)) throw new ErrorMaestro('La placa debe tener entre 5 y 10 letras o números.');
  const { rows } = await tx.query<{ id: string }>(
    `insert into vehiculo (transportista_id, placa, descripcion, capacidad_kg, capacidad_m3, costo_km_usd, costo_hora_usd)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [transportistaId, placa, ...camposVehiculo(d)]);
  return rows[0].id;
}

export async function actualizarVehiculo(tx: Db, id: string, d: Omit<DatosVehiculo, 'placa'> & { activo: boolean }): Promise<void> {
  const { rows } = await tx.query(
    `update vehiculo set descripcion = $2, capacidad_kg = $3, capacidad_m3 = $4, costo_km_usd = $5, costo_hora_usd = $6, activo = $7
      where id = $1 returning id`,
    [id, ...camposVehiculo({ ...d, placa: '' }), d.activo]);
  if (!rows[0]) throw new ErrorMaestro('El vehículo no existe.');
}

// ---------------------------------------------------------------------
// Tarifas (solo transportistas de terceros)
// ---------------------------------------------------------------------

export interface DatosTarifa {
  entidadFederal?: string;
  ciudad?: string;
  unidadCobro: UnidadCobro;
  moneda: string;
  monto: string;
  minimo?: string;
  vigenteDesde: string;
}

/**
 * Carga una tarifa nueva. Si hay una abierta (o que cubre esas fechas) para el mismo destino y unidad, se cierra el día anterior.
 * La vigencia no puede empezar en el pasado.
 */
export async function agregarTarifa(tx: Db, transportistaId: string, d: DatosTarifa): Promise<string> {
  if (!UNIDADES_COBRO.includes(d.unidadCobro)) throw new ErrorMaestro('Seleccione la unidad de cobro.');
  if (!/^[A-Z]{3}$/.test(d.moneda)) throw new ErrorMaestro('Seleccione la moneda.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.vigenteDesde)) throw new ErrorMaestro('Indique desde cuándo rige la tarifa.');
  const monto = decimalOpcional(d.monto, 'Monto', 10, 4, false);
  if (monto === null) throw new ErrorMaestro('Indique el monto de la tarifa.');
  const minimo = decimalOpcional(d.minimo, 'Mínimo', 12, 2, false) ?? '0';
  const entidad = vacioANull(d.entidadFederal);
  const ciudad = vacioANull(d.ciudad);
  if (ciudad && !entidad) throw new ErrorMaestro('Si indica la ciudad, indique también el estado.');

  // Cierra la tarifa anterior del mismo destino y unidad que siga abierta al empezar la nueva.
  await tx.query(
    `update transportista_tarifa set vigente_hasta = ($5::date - 1)
      where transportista_id = $1 and unidad_cobro = $2
        and fn_nombre_normalizado(entidad_federal) = fn_nombre_normalizado($3::text)
        and fn_nombre_normalizado(ciudad) = fn_nombre_normalizado($4::text)
        and vigente_desde < $5::date and (vigente_hasta is null or vigente_hasta >= $5::date)`,
    [transportistaId, d.unidadCobro, entidad, ciudad, d.vigenteDesde]);
  const { rows } = await tx.query<{ id: string }>(
    `insert into transportista_tarifa (transportista_id, entidad_federal, ciudad, unidad_cobro, moneda, monto, minimo, vigente_desde)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [transportistaId, entidad, ciudad, d.unidadCobro, d.moneda, monto, minimo, d.vigenteDesde]);
  return rows[0].id;
}

/** Cierra la vigencia de una tarifa en la fecha indicada (inclusive). */
export async function cerrarTarifa(tx: Db, id: string, hasta: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new ErrorMaestro('Indique la fecha hasta la que rige la tarifa.');
  const { rows } = await tx.query('update transportista_tarifa set vigente_hasta = $2 where id = $1 returning id', [id, hasta]);
  if (!rows[0]) throw new ErrorMaestro('La tarifa no existe.');
}

export interface DetalleTransportista {
  id: string;
  codigo: string;
  nombre: string;
  modalidad: Modalidad;
  proveedor_id: string | null;
  proveedor: string | null;
  contacto_telefono: string | null;
  observaciones: string | null;
  activo: boolean;
  vehiculos: {
    id: string; placa: string; descripcion: string; capacidad_kg: string | null; capacidad_m3: string | null;
    costo_km_usd: string | null; costo_hora_usd: string | null; activo: boolean;
  }[];
  tarifas: {
    id: string; entidad_federal: string | null; ciudad: string | null; unidad_cobro: UnidadCobro; moneda: string;
    monto: string; minimo: string; vigente_desde: string; vigente_hasta: string | null; vigente: boolean;
  }[];
}

export async function detalleTransportista(db: Db, id: string): Promise<DetalleTransportista | null> {
  const { rows } = await db.query<Omit<DetalleTransportista, 'vehiculos' | 'tarifas'>>(
    `select t.id, t.codigo, t.nombre, t.modalidad, t.proveedor_id, p.codigo || ' · ' || te.razon_social as proveedor,
            t.contacto_telefono, t.observaciones, t.activo
       from transportista t
       left join proveedor p on p.tercero_id = t.proveedor_id
       left join tercero te on te.id = t.proveedor_id
      where t.id = $1`, [id]);
  if (!rows[0]) return null;
  const [v, f] = await Promise.all([
    db.query<DetalleTransportista['vehiculos'][number]>(
      `select id, placa, descripcion, capacidad_kg::text, capacidad_m3::text, costo_km_usd::text, costo_hora_usd::text, activo
         from vehiculo where transportista_id = $1 order by activo desc, placa`, [id]),
    db.query<DetalleTransportista['tarifas'][number]>(
      `select id, entidad_federal, ciudad, unidad_cobro, moneda, monto::text, minimo::text, vigente_desde::text, vigente_hasta::text,
              (vigente_desde <= ((now() at time zone 'America/Caracas')::date)
               and (vigente_hasta is null or vigente_hasta >= ((now() at time zone 'America/Caracas')::date))) as vigente
         from transportista_tarifa where transportista_id = $1
        order by entidad_federal nulls first, ciudad nulls first, unidad_cobro, vigente_desde desc`, [id]),
  ]);
  return { ...rows[0], vehiculos: v.rows, tarifas: f.rows };
}

export function puedeGestionarTransportistas(u: Usuario): boolean {
  return u.roles.some((r) => (ROLES_GESTIONAN_TRANSPORTISTAS as readonly string[]).includes(r));
}
