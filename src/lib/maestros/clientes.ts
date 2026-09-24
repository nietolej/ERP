import type { Db } from '@/lib/db/tipos';
import { normalizarRif, problemaDeRif, tipoPersona } from './rif';
import { ROLES_VEN_TODOS } from './roles';

/**
 * Clientes (§5.1, §5.5).
 * - Facturación registra el cliente; nace 'pendiente' con un código del numerador (C00001…).
 * - Gerencia lo aprueba asignándole condición de pago, límite de crédito y nivel de precio.
 * - Un RIF es un solo tercero: si ya existe (p. ej. es proveedor), el cliente se enlaza a él.
 * - Seguridad por fila: un usuario que solo tiene el rol Ventas ve únicamente su cartera.
 * La base de datos garantiza el RIF, el código y la aprobación (migración 0007).
 */

export class ErrorMaestro extends Error {}

/** Error que el usuario puede superar confirmando (p. ej. un nombre parecido a otro tercero). */
export class ErrorConfirmable extends ErrorMaestro {}

export interface DatosTercero {
  razonSocial: string;
  nombreComercial?: string;
  domiciliado: boolean;
  contribuyenteEspecial: boolean;
  agenteRetencionIva: boolean;
  direccionFiscal?: string;
  telefono?: string;
  email?: string;
}

export interface DatosComerciales {
  sucursalId?: string | null;
  vendedorId?: string | null;
  zona?: string;
}

export interface DatosCredito {
  condicionPagoId: string;
  /** Texto decimal, hasta 2 decimales. */
  limiteCreditoUsd: string;
  nivelPrecio: 'A' | 'B' | 'D';
  /** Texto decimal entre 0 y 100. */
  descuentoPct: string;
}

const MONTO = /^\d{1,12}(\.\d{1,2})?$/;
const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const vacioANull = (v?: string | null) => (v && v.trim() ? v.trim() : null);

function validarTercero(d: DatosTercero): void {
  const errores: string[] = [];
  if (d.razonSocial.trim().length < 2) errores.push('Indique la razón social o el nombre.');
  if (d.email?.trim() && !EMAIL.test(d.email.trim())) errores.push('El correo no tiene un formato válido.');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

function validarCredito(d: DatosCredito): void {
  const errores: string[] = [];
  if (!d.condicionPagoId) errores.push('Seleccione la condición de pago.');
  if (!MONTO.test(d.limiteCreditoUsd.trim())) errores.push('El límite de crédito debe ser un monto en USD con hasta 2 decimales.');
  if (!['A', 'B', 'D'].includes(d.nivelPrecio)) errores.push('Seleccione el nivel de precio (A, B o D).');
  if (!PORCENTAJE.test(d.descuentoPct.trim()) || Number(d.descuentoPct) > 100) {
    errores.push('El descuento debe ser un porcentaje entre 0 y 100.');
  }
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

/** Terceros con un nombre que, normalizado, coincide con el dado (posibles duplicados). */
export async function posiblesDuplicados(
  db: Db, razonSocial: string, excluirId?: string,
): Promise<{ id: string; rif: string; razon_social: string }[]> {
  const { rows } = await db.query<{ id: string; rif: string; razon_social: string }>(
    `select id, rif, razon_social from tercero
      where fn_nombre_normalizado(razon_social) = fn_nombre_normalizado($1)
        and ($2::uuid is null or id <> $2::uuid)
      order by rif limit 5`,
    [razonSocial, excluirId ?? null]);
  return rows;
}

/**
 * Registra un cliente pendiente de aprobación. Debe llamarse dentro de una transacción.
 * Devuelve el id (tercero_id) y el código asignado.
 */
export async function crearCliente(
  tx: Db, usuarioId: string,
  d: { rif: string; tercero: DatosTercero; comercial: DatosComerciales; confirmarNombreParecido?: boolean },
): Promise<{ id: string; codigo: string; terceroExistente: boolean }> {
  const problema = problemaDeRif(d.rif);
  if (problema) throw new ErrorMaestro(problema);
  const rif = normalizarRif(d.rif)!;

  const { rows: existente } = await tx.query<{ id: string; codigo: string | null }>(
    `select t.id, c.codigo from tercero t left join cliente c on c.tercero_id = t.id where t.rif = $1`, [rif]);

  let terceroId: string;
  if (existente[0]) {
    if (existente[0].codigo) {
      throw new ErrorMaestro(`El RIF ${rif} ya es el cliente ${existente[0].codigo}.`);
    }
    terceroId = existente[0].id; // ya existe como tercero (p. ej. proveedor): se reutiliza sin cambiar sus datos
  } else {
    validarTercero(d.tercero);
    const parecidos = await posiblesDuplicados(tx, d.tercero.razonSocial);
    if (parecidos.length && !d.confirmarNombreParecido) {
      throw new ErrorConfirmable(
        `Ya existe un tercero con un nombre igual o muy parecido:\n` +
        parecidos.map((p) => `• ${p.rif} · ${p.razon_social}`).join('\n') +
        `\nSi es una persona distinta, marque la confirmación y guarde de nuevo.`);
    }
    const t = d.tercero;
    const { rows } = await tx.query<{ id: string }>(
      `insert into tercero (rif, razon_social, nombre_comercial, tipo_persona, domiciliado, contribuyente_especial,
                            agente_retencion_iva, direccion_fiscal, telefono, email, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [rif, t.razonSocial.trim(), vacioANull(t.nombreComercial), tipoPersona(rif), t.domiciliado,
       t.contribuyenteEspecial, t.agenteRetencionIva, vacioANull(t.direccionFiscal), vacioANull(t.telefono),
       vacioANull(t.email)?.toLowerCase() ?? null, usuarioId]);
    terceroId = rows[0].id;
  }

  const c = d.comercial;
  const { rows } = await tx.query<{ codigo: string }>(
    `insert into cliente (tercero_id, sucursal_id, vendedor_id, zona, created_by)
     values ($1, $2, $3, $4, $5) returning codigo`,
    [terceroId, c.sucursalId || null, c.vendedorId || null, vacioANull(c.zona), usuarioId]);
  return { id: terceroId, codigo: rows[0].codigo, terceroExistente: !!existente[0] };
}

async function estadoCliente(tx: Db, id: string): Promise<string> {
  const { rows } = await tx.query<{ estado: string }>('select estado from cliente where tercero_id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El cliente no existe.');
  return rows[0].estado;
}

/** Gerencia aprueba un cliente pendiente y le asigna sus condiciones de crédito. */
export async function aprobarCliente(tx: Db, id: string, aprobadorId: string, d: DatosCredito): Promise<void> {
  validarCredito(d);
  if ((await estadoCliente(tx, id)) !== 'pendiente') throw new ErrorMaestro('El cliente ya fue aprobado.');
  await tx.query(
    `update cliente set estado = 'activo', aprobado_por = $2, condicion_pago_id = $3,
            limite_credito_usd = $4, nivel_precio = $5, descuento_pct = $6
      where tercero_id = $1`,
    [id, aprobadorId, d.condicionPagoId, d.limiteCreditoUsd.trim(), d.nivelPrecio, d.descuentoPct.trim()]);
}

/** Gerencia cambia las condiciones de crédito de un cliente ya aprobado. */
export async function actualizarCredito(tx: Db, id: string, d: DatosCredito): Promise<void> {
  validarCredito(d);
  if ((await estadoCliente(tx, id)) === 'pendiente') throw new ErrorMaestro('Primero apruebe el cliente.');
  await tx.query(
    `update cliente set condicion_pago_id = $2, limite_credito_usd = $3, nivel_precio = $4, descuento_pct = $5
      where tercero_id = $1`,
    [id, d.condicionPagoId, d.limiteCreditoUsd.trim(), d.nivelPrecio, d.descuentoPct.trim()]);
}

/** Gerencia activa, inactiva o bloquea un cliente aprobado. Un maestro no se borra (§5.5). */
export async function cambiarEstadoCliente(tx: Db, id: string, estado: 'activo' | 'inactivo' | 'bloqueado'): Promise<void> {
  if (!['activo', 'inactivo', 'bloqueado'].includes(estado)) throw new ErrorMaestro('Estado inválido.');
  if ((await estadoCliente(tx, id)) === 'pendiente') throw new ErrorMaestro('Un cliente pendiente primero se aprueba.');
  await tx.query('update cliente set estado = $2 where tercero_id = $1', [id, estado]);
}

/** Datos del tercero y datos comerciales (no de crédito). El RIF no se cambia. */
export async function actualizarDatosCliente(
  tx: Db, id: string, d: { tercero: DatosTercero; comercial: DatosComerciales; confirmarNombreParecido?: boolean },
): Promise<void> {
  validarTercero(d.tercero);
  await estadoCliente(tx, id);
  const parecidos = await posiblesDuplicados(tx, d.tercero.razonSocial, id);
  if (parecidos.length && !d.confirmarNombreParecido) {
    throw new ErrorConfirmable(
      `Ya existe otro tercero con un nombre igual o muy parecido:\n` +
      parecidos.map((p) => `• ${p.rif} · ${p.razon_social}`).join('\n') +
      `\nSi es una persona distinta, marque la confirmación y guarde de nuevo.`);
  }
  const t = d.tercero;
  await tx.query(
    `update tercero set razon_social = $2, nombre_comercial = $3, domiciliado = $4, contribuyente_especial = $5,
            agente_retencion_iva = $6, direccion_fiscal = $7, telefono = $8, email = $9
      where id = $1`,
    [id, t.razonSocial.trim(), vacioANull(t.nombreComercial), t.domiciliado, t.contribuyenteEspecial,
     t.agenteRetencionIva, vacioANull(t.direccionFiscal), vacioANull(t.telefono), vacioANull(t.email)?.toLowerCase() ?? null]);
  const c = d.comercial;
  await tx.query('update cliente set sucursal_id = $2, vendedor_id = $3, zona = $4 where tercero_id = $1',
    [id, c.sucursalId || null, c.vendedorId || null, vacioANull(c.zona)]);
}

export { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from './roles';

export interface FilaCliente {
  id: string;
  codigo: string;
  rif: string;
  razon_social: string;
  vendedor: string | null;
  sucursal: string | null;
  estado: string;
  limite_credito_usd: string;
}

/**
 * Busca clientes por código, RIF o nombre. Aplica la seguridad por fila:
 * sin un rol de ROLES_VEN_TODOS, solo devuelve los clientes del vendedor enlazado al usuario.
 */
export async function buscarClientes(
  db: Db, usuario: { id: string; roles: readonly string[] }, filtro: { texto?: string; estado?: string },
  limite = 100,
): Promise<FilaCliente[]> {
  const verTodos = usuario.roles.some((r) => (ROLES_VEN_TODOS as string[]).includes(r));
  if (!verTodos && !usuario.roles.includes('ventas')) return [];
  const texto = (filtro.texto ?? '').trim();
  const { rows } = await db.query<FilaCliente>(
    `select c.tercero_id as id, c.codigo, t.rif, t.razon_social, v.nombre as vendedor, s.nombre as sucursal,
            c.estado, c.limite_credito_usd
       from cliente c
       join tercero t on t.id = c.tercero_id
       left join vendedor v on v.id = c.vendedor_id
       left join sucursal s on s.id = c.sucursal_id
      where ($1 or v.usuario_id = $2)
        and ($3 = '' or c.estado = $3)
        and ($4 = '' or c.codigo ilike '%' || $4 || '%'
                     or replace(t.rif, '-', '') ilike '%' || replace($4, '-', '') || '%'
                     or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($4) || '%'
                     or fn_nombre_normalizado(t.nombre_comercial) like '%' || fn_nombre_normalizado($4) || '%')
      order by c.estado = 'pendiente' desc, c.codigo
      limit $5`,
    [verTodos, usuario.id, filtro.estado ?? '', texto, limite]);
  return rows;
}

/** ¿Puede el usuario ver este cliente? (misma regla de seguridad por fila que buscarClientes). */
export async function puedeVerCliente(db: Db, usuario: { id: string; roles: readonly string[] }, id: string): Promise<boolean> {
  if (usuario.roles.some((r) => (ROLES_VEN_TODOS as string[]).includes(r))) return true;
  if (!usuario.roles.includes('ventas')) return false;
  const { rows } = await db.query(
    `select 1 from cliente c join vendedor v on v.id = c.vendedor_id where c.tercero_id = $1 and v.usuario_id = $2`,
    [id, usuario.id]);
  return rows.length > 0;
}
