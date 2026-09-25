import { solicitarAprobacion } from '@/lib/flujo/flujo';
import type { Db } from '@/lib/db/tipos';
import {
  ErrorMaestro, exigirNombreDistinto, obtenerOCrearTercero, rifOError, vacioANull, validarTercero, type DatosTercero,
} from './terceros';

/**
 * Proveedores (§5.1, matriz de §4.3).
 * - Compras registra el proveedor ('pendiente', código P00001…). Gerencia, distinta de quien lo
 *   registró, lo aprueba y le asigna la condición de pago.
 * - Datos de contacto: Compras los cambia directamente.
 * - Datos sensibles (razón social, datos fiscales, tipo, país, concepto de ISLR): con un proveedor
 *   aprobado, Compras solicita el cambio y Gerencia lo aprueba o lo rechaza.
 * La base de datos garantiza todo lo anterior (migración 0009).
 */

export const TIPOS_PROVEEDOR = ['mercancia_local', 'importacion', 'servicios', 'gastos'] as const;
export type TipoProveedor = (typeof TIPOS_PROVEEDOR)[number];
export const NOMBRE_TIPO_PROVEEDOR: Record<TipoProveedor, string> = {
  mercancia_local: 'Mercancía local',
  importacion: 'Importación',
  servicios: 'Servicios',
  gastos: 'Gastos',
};

/** Roles que consultan proveedores. */
export const ROLES_VEN_PROVEEDORES = ['compras', 'gerencia', 'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const;

export interface DatosSensibles {
  razonSocial: string;
  domiciliado: boolean;
  contribuyenteEspecial: boolean;
  agenteRetencionIva: boolean;
  tipo: TipoProveedor;
  pais: string;
  conceptoIslrId: string | null;
}

export interface DatosContacto {
  nombreComercial?: string;
  direccionFiscal?: string;
  telefono?: string;
  email?: string;
}

/** Nombres de los campos sensibles, para mostrar una solicitud de cambio. */
export const CAMPOS_SENSIBLES: Record<string, string> = {
  razon_social: 'Razón social',
  domiciliado: 'Domiciliado',
  contribuyente_especial: 'Contribuyente especial',
  agente_retencion_iva: 'Agente de retención de IVA',
  tipo: 'Tipo de proveedor',
  pais: 'País',
  concepto_islr_id: 'Concepto de ISLR',
};

function validarSensibles(d: DatosSensibles): void {
  const errores: string[] = [];
  if (d.razonSocial.trim().length < 2) errores.push('Indique la razón social o el nombre.');
  if (!TIPOS_PROVEEDOR.includes(d.tipo)) errores.push('Seleccione el tipo de proveedor.');
  if (!/^[A-Z]{2}$/.test(d.pais)) errores.push('El país debe ser un código de dos letras (VE, CN, US…).');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

const tercero = (s: DatosSensibles, c: DatosContacto): DatosTercero => ({
  razonSocial: s.razonSocial, domiciliado: s.domiciliado, contribuyenteEspecial: s.contribuyenteEspecial,
  agenteRetencionIva: s.agenteRetencionIva, ...c,
});

async function estado(tx: Db, id: string): Promise<string> {
  const { rows } = await tx.query<{ estado: string }>('select estado from proveedor where tercero_id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El proveedor no existe.');
  return rows[0].estado;
}

export async function crearProveedor(
  tx: Db, usuarioId: string,
  d: { rif: string; sensibles: DatosSensibles; contacto: DatosContacto; confirmarNombreParecido?: boolean },
): Promise<{ id: string; codigo: string; terceroExistente: boolean }> {
  const rif = rifOError(d.rif);
  validarSensibles(d.sensibles);
  const { rows: previo } = await tx.query<{ codigo: string }>(
    'select p.codigo from tercero t join proveedor p on p.tercero_id = t.id where t.rif = $1', [rif]);
  if (previo[0]) throw new ErrorMaestro(`El RIF ${rif} ya es el proveedor ${previo[0].codigo}.`);
  // Si ya es cliente o vendedor externo, se reutiliza el tercero sin cambiar sus datos.
  const t = await obtenerOCrearTercero(tx, usuarioId, rif, tercero(d.sensibles, d.contacto), d.confirmarNombreParecido);
  const { rows } = await tx.query<{ codigo: string }>(
    `insert into proveedor (tercero_id, tipo, pais, concepto_islr_id, created_by) values ($1, $2, $3, $4, $5)
     returning codigo`,
    [t.id, d.sensibles.tipo, d.sensibles.pais, d.sensibles.conceptoIslrId || null, usuarioId]);
  await solicitarAprobacion(tx, { tipo: 'proveedor', objetoId: t.id, solicitanteId: usuarioId });
  return { id: t.id, codigo: rows[0].codigo, terceroExistente: t.existente };
}

/** Mientras está pendiente, Compras corrige libremente todos sus datos. */
export async function corregirPendiente(
  tx: Db, id: string, d: { sensibles: DatosSensibles; contacto: DatosContacto; confirmarNombreParecido?: boolean },
): Promise<void> {
  validarSensibles(d.sensibles);
  validarTercero(tercero(d.sensibles, d.contacto));
  if ((await estado(tx, id)) !== 'pendiente') {
    throw new ErrorMaestro('El proveedor ya fue aprobado: sus datos sensibles cambian con una solicitud de cambio.');
  }
  await exigirNombreDistinto(tx, d.sensibles.razonSocial, d.confirmarNombreParecido, id);
  const s = d.sensibles;
  await tx.query(
    `update tercero set razon_social = $2, domiciliado = $3, contribuyente_especial = $4, agente_retencion_iva = $5
      where id = $1`,
    [id, s.razonSocial.trim(), s.domiciliado, s.contribuyenteEspecial, s.agenteRetencionIva]);
  await tx.query('update proveedor set tipo = $2, pais = $3, concepto_islr_id = $4 where tercero_id = $1',
    [id, s.tipo, s.pais, s.conceptoIslrId || null]);
  await actualizarContacto(tx, id, d.contacto);
}

/** Datos de contacto: se cambian directamente, también con el proveedor aprobado. */
export async function actualizarContacto(tx: Db, id: string, c: DatosContacto): Promise<void> {
  if (c.email?.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) {
    throw new ErrorMaestro('El correo no tiene un formato válido.');
  }
  await tx.query(
    'update tercero set nombre_comercial = $2, direccion_fiscal = $3, telefono = $4, email = $5 where id = $1',
    [id, vacioANull(c.nombreComercial), vacioANull(c.direccionFiscal), vacioANull(c.telefono),
     vacioANull(c.email)?.toLowerCase() ?? null]);
}

/** Gerencia aprueba el alta y asigna la condición de pago. */
export async function aprobarProveedor(tx: Db, id: string, aprobadorId: string, condicionPagoId: string): Promise<void> {
  if (!condicionPagoId) throw new ErrorMaestro('Seleccione la condición de pago.');
  if ((await estado(tx, id)) !== 'pendiente') throw new ErrorMaestro('El proveedor ya fue aprobado.');
  await tx.query(
    `update proveedor set estado = 'activo', aprobado_por = $2, condicion_pago_id = $3 where tercero_id = $1`,
    [id, aprobadorId, condicionPagoId]);
}

/** Gerencia cambia la condición de pago de un proveedor aprobado. */
export async function cambiarCondicionProveedor(tx: Db, id: string, condicionPagoId: string): Promise<void> {
  if (!condicionPagoId) throw new ErrorMaestro('Seleccione la condición de pago.');
  if ((await estado(tx, id)) === 'pendiente') throw new ErrorMaestro('Primero apruebe el proveedor.');
  await tx.query('update proveedor set condicion_pago_id = $2 where tercero_id = $1', [id, condicionPagoId]);
}

export async function cambiarEstadoProveedor(tx: Db, id: string, nuevo: 'activo' | 'inactivo' | 'bloqueado'): Promise<void> {
  if (!['activo', 'inactivo', 'bloqueado'].includes(nuevo)) throw new ErrorMaestro('Estado inválido.');
  if ((await estado(tx, id)) === 'pendiente') throw new ErrorMaestro('Un proveedor pendiente primero se aprueba.');
  await tx.query('update proveedor set estado = $2 where tercero_id = $1', [id, nuevo]);
}

/**
 * Compras solicita cambiar datos sensibles de un proveedor aprobado. Se guarda solo lo que cambia.
 * Devuelve el id de la solicitud.
 */
export async function solicitarCambio(tx: Db, id: string, usuarioId: string, propuesta: DatosSensibles): Promise<string> {
  validarSensibles(propuesta);
  if ((await estado(tx, id)) === 'pendiente') {
    throw new ErrorMaestro('El proveedor aún está pendiente: corrija sus datos directamente.');
  }
  const { rows } = await tx.query<{
    razon_social: string; domiciliado: boolean; contribuyente_especial: boolean; agente_retencion_iva: boolean;
    tipo: string; pais: string; concepto_islr_id: string | null;
  }>(
    `select t.razon_social, t.domiciliado, t.contribuyente_especial, t.agente_retencion_iva, p.tipo, p.pais, p.concepto_islr_id
       from proveedor p join tercero t on t.id = p.tercero_id where p.tercero_id = $1`, [id]);
  const actual = rows[0];
  const nuevos: Record<string, string | boolean> = {
    razon_social: propuesta.razonSocial.trim(),
    domiciliado: propuesta.domiciliado,
    contribuyente_especial: propuesta.contribuyenteEspecial,
    agente_retencion_iva: propuesta.agenteRetencionIva,
    tipo: propuesta.tipo,
    pais: propuesta.pais,
    concepto_islr_id: propuesta.conceptoIslrId ?? '',
  };
  const datos: Record<string, string | boolean> = {};
  for (const [campo, valor] of Object.entries(nuevos)) {
    const previo = (actual as Record<string, unknown>)[campo] ?? '';
    if (previo !== valor) datos[campo] = valor;
  }
  if (Object.keys(datos).length === 0) throw new ErrorMaestro('No hay cambios en los datos sensibles.');

  const { rows: abierta } = await tx.query('select 1 from proveedor_cambio where proveedor_id = $1 and estado = $2', [id, 'pendiente']);
  if (abierta.length) throw new ErrorMaestro('Ya hay una solicitud de cambio pendiente para este proveedor.');
  const { rows: r } = await tx.query<{ id: string }>(
    'insert into proveedor_cambio (proveedor_id, datos, solicitado_por) values ($1, $2, $3) returning id',
    [id, JSON.stringify(datos), usuarioId]);
  await solicitarAprobacion(tx, { tipo: 'proveedor_cambio', objetoId: r[0].id, solicitanteId: usuarioId });
  return r[0].id;
}

export async function aprobarCambio(tx: Db, cambioId: string, aprobadorId: string): Promise<void> {
  await tx.query('select fn_aprobar_cambio_proveedor($1, $2)', [cambioId, aprobadorId]);
}

export async function rechazarCambio(tx: Db, cambioId: string, aprobadorId: string, motivo: string): Promise<void> {
  if (!motivo.trim()) throw new ErrorMaestro('Indique el motivo del rechazo.');
  const { rows } = await tx.query<{ estado: string; solicitado_por: string }>(
    'select estado, solicitado_por from proveedor_cambio where id = $1 for update', [cambioId]);
  if (!rows[0]) throw new ErrorMaestro('La solicitud de cambio no existe.');
  if (rows[0].estado !== 'pendiente') throw new ErrorMaestro('La solicitud de cambio ya fue resuelta.');
  if (rows[0].solicitado_por === aprobadorId) throw new ErrorMaestro('Quien solicitó el cambio no puede rechazarlo.');
  await tx.query(
    `update proveedor_cambio set estado = 'rechazado', resuelto_por = $2, resuelto_at = now(), motivo_rechazo = $3 where id = $1`,
    [cambioId, aprobadorId, motivo.trim()]);
}

export interface FilaProveedor {
  id: string;
  codigo: string;
  rif: string;
  razon_social: string;
  tipo: TipoProveedor;
  pais: string;
  estado: string;
  cambio_pendiente: boolean;
}

export async function buscarProveedores(db: Db, filtro: { texto?: string; estado?: string }, limite = 100): Promise<FilaProveedor[]> {
  const texto = (filtro.texto ?? '').trim();
  const { rows } = await db.query<FilaProveedor>(
    `select p.tercero_id as id, p.codigo, t.rif, t.razon_social, p.tipo, p.pais, p.estado,
            exists (select 1 from proveedor_cambio c where c.proveedor_id = p.tercero_id and c.estado = 'pendiente') as cambio_pendiente
       from proveedor p join tercero t on t.id = p.tercero_id
      where ($1 = '' or p.estado = $1)
        and ($2 = '' or p.codigo ilike '%' || $2 || '%'
                     or replace(t.rif, '-', '') ilike '%' || replace($2, '-', '') || '%'
                     or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($2) || '%'
                     or fn_nombre_normalizado(t.nombre_comercial) like '%' || fn_nombre_normalizado($2) || '%')
      order by p.estado = 'pendiente' desc, cambio_pendiente desc, p.codigo
      limit $3`,
    [filtro.estado ?? '', texto, limite]);
  return rows;
}
