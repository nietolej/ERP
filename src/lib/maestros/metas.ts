import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { normalizarRif } from './rif';
import { ErrorMaestro } from './terceros';

/**
 * Metas de venta (§5.4, spec_reportes §10).
 * - Cada carga (Excel o manual) es un lote con versión, usuario y fecha; nace pendiente.
 * - Gerencia aprueba o rechaza, y no aprueba lo que ella misma cargó (lo exige la base de datos).
 * - Es todo o nada: si una fila tiene error, no se guarda nada y se informan las filas con problema.
 * - La meta vigente de cada clave es la del último lote aprobado (vista vw_meta_periodo).
 */

export const ROLES_CARGAN_METAS: Rol[] = ['gerencia', 'supervisor_ventas'];
export const ROLES_APRUEBAN_METAS: Rol[] = ['gerencia'];
export const ROLES_VEN_METAS: Rol[] = ['gerencia', 'supervisor_ventas', 'contabilidad', 'jefe_contabilidad', 'auditor'];

export const TIPOS_META = ['global', 'cliente', 'vendedor', 'producto', 'grupo'] as const;
export type TipoMeta = (typeof TIPOS_META)[number];

export const NOMBRE_TIPO_META: Record<TipoMeta, string> = {
  global: 'Global', cliente: 'Cliente', vendedor: 'Vendedor', producto: 'Producto', grupo: 'Grupo',
};

const MAX_FILAS = 5000;
const MAX_ERRORES_MOSTRADOS = 30;

export interface FilaMeta {
  /** Número de fila en el archivo o en la pantalla, para informar errores. */
  fila: number;
  tipo: TipoMeta;
  /** Código del ERP o, para clientes, también el RIF. Vacío en la meta global. */
  referencia?: string;
  /** Alternativa a `referencia` cuando ya se conoce la entidad (edición de una meta vigente). */
  entidadId?: string;
  anio: number;
  mes: number | null;
  monto: string | number | null | undefined;
}

/**
 * Convierte un monto escrito por una persona a texto decimal con 2 decimales, o null si no es válido.
 * Acepta 15000, 15000.50, 15.000, 15.000,50 y 15,000.50: el último separador es el decimal, salvo
 * que tenga exactamente 3 dígitos detrás y no haya otro separador (entonces es de miles: 15.000).
 */
export function parsearMonto(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    // Una celda numérica de Excel ya trae el decimal con punto: no se interpreta como miles.
    if (!Number.isFinite(v) || v < 0 || /e/i.test(String(v))) return null;
    const d = new Decimal(String(v));
    return d.decimalPlaces() > 2 ? null : d.toFixed(2);
  }
  const s = v.replace(/[\s$]|usd/gi, '');
  if (!/^[0-9]+([.,][0-9]+)*$/.test(s)) return null;
  const partes = s.split(/[.,]/);
  const separadores = s.match(/[.,]/g) ?? [];
  const cola = partes[partes.length - 1];
  let entero = partes.join('');
  let decimal = '';
  if (separadores.length > 0) {
    const mezclados = new Set(separadores).size > 1;
    const soloMiles = !mezclados && (separadores.length > 1 || cola.length === 3);
    const gruposDeMiles = partes.slice(1, soloMiles ? undefined : -1);
    if (soloMiles || mezclados) {
      // Los separadores de miles llevan siempre 3 dígitos detrás y el primer grupo tiene de 1 a 3.
      if (partes[0].length > 3 || partes[0] === '0' || gruposDeMiles.some((g) => g.length !== 3)) return null;
    }
    if (!soloMiles) {
      entero = partes.slice(0, -1).join('');
      decimal = cola;
    }
  }
  if (decimal.length > 2) return null;
  const d = new Decimal(`${entero}${decimal ? `.${decimal}` : ''}`);
  return d.toFixed(2);
}

/** Quita acentos, espacios sobrantes y pasa a mayúsculas. */
const clave = (v: unknown) =>
  String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/[\s_-]+/g, '_').toUpperCase();

/**
 * Convierte las filas de la hoja de Excel en filas de meta. La primera fila son los encabezados:
 * TIPO, CODIGO, ANIO (o AÑO), META_VENTA y, opcionalmente, MES. Lanza si faltan columnas.
 */
export function leerFilasExcel(datos: unknown[][]): FilaMeta[] {
  if (datos.length === 0) throw new ErrorMaestro('El archivo está vacío.');
  const encabezados = datos[0].map(clave);
  const col = (...nombres: string[]) => encabezados.findIndex((h) => nombres.includes(h));
  const iTipo = col('TIPO');
  const iCodigo = col('CODIGO');
  const iAnio = col('ANIO', 'ANO');
  const iMeta = col('META_VENTA', 'META', 'META_DE_VENTA');
  const iMes = col('MES');
  const faltan = [
    iTipo < 0 && 'TIPO', iCodigo < 0 && 'CODIGO', iAnio < 0 && 'ANIO', iMeta < 0 && 'META_VENTA',
  ].filter(Boolean);
  if (faltan.length) throw new ErrorMaestro(`Faltan las columnas: ${faltan.join(', ')}. La primera fila debe tener los encabezados TIPO, CODIGO, ANIO, META_VENTA y, si aplica, MES.`);

  const filas: FilaMeta[] = [];
  const errores: string[] = [];
  datos.slice(1).forEach((r, i) => {
    const fila = i + 2;
    if (r.every((c) => c === null || c === undefined || String(c).trim() === '')) return;
    const tipo = clave(r[iTipo]).toLowerCase();
    if (!(TIPOS_META as readonly string[]).includes(tipo)) {
      errores.push(`Fila ${fila}: el tipo "${String(r[iTipo] ?? '').trim()}" no es válido (CLIENTE, VENDEDOR, PRODUCTO, GRUPO o GLOBAL).`);
      return;
    }
    const anio = Number(String(r[iAnio] ?? '').trim());
    const mesTexto = iMes >= 0 ? String(r[iMes] ?? '').trim() : '';
    const mes = mesTexto === '' ? null : Number(mesTexto);
    filas.push({
      fila, tipo: tipo as TipoMeta, referencia: String(r[iCodigo] ?? '').trim(),
      anio, mes, monto: r[iMeta] as string | number | null,
    });
  });
  if (errores.length) throw new ErrorMaestro(informe(errores));
  return filas;
}

function informe(errores: string[]): string {
  const visibles = errores.slice(0, MAX_ERRORES_MOSTRADOS);
  const resto = errores.length - visibles.length;
  return `No se guardó nada. Corrija estas filas:\n${visibles.join('\n')}${resto > 0 ? `\n…y ${resto} más.` : ''}`;
}

type Resueltas = Map<string, string>; // clave de búsqueda (código o RIF en mayúsculas) → id

async function resolver(tx: Db, tipo: TipoMeta, referencias: string[]): Promise<Resueltas> {
  const mapa: Resueltas = new Map();
  if (referencias.length === 0) return mapa;
  const codigos = referencias.map((r) => r.toUpperCase());
  if (tipo === 'cliente') {
    const rifs = referencias.map((r) => normalizarRif(r) ?? '');
    const { rows } = await tx.query<{ id: string; codigo: string; rif: string }>(
      `select c.tercero_id as id, c.codigo, t.rif
         from cliente c join tercero t on t.id = c.tercero_id
        where c.estado in ('activo', 'bloqueado') and (upper(c.codigo) = any($1::text[]) or t.rif = any($2::text[]))`, [codigos, rifs]);
    for (const r of rows) { mapa.set(r.codigo.toUpperCase(), r.id); mapa.set(r.rif, r.id); }
    return mapa;
  }
  const consulta = {
    vendedor: `select id, codigo from vendedor where estado = 'activo' and upper(codigo) = any($1::text[])`,
    producto: `select id, codigo from producto where estado = 'activo' and upper(codigo) = any($1::text[])`,
    grupo: `select id, codigo from grupo_producto where activo and upper(codigo) = any($1::text[])`,
  }[tipo as 'vendedor' | 'producto' | 'grupo'];
  const { rows } = await tx.query<{ id: string; codigo: string }>(consulta, [codigos]);
  for (const r of rows) mapa.set(r.codigo.toUpperCase(), r.id);
  return mapa;
}

interface FilaResuelta { tipo: TipoMeta; entidadId: string | null; anio: number; mes: number | null; monto: string }

/** Valida todas las filas y las convierte a filas listas para guardar. Lanza con el informe de errores. */
export async function validarMetas(tx: Db, filas: FilaMeta[]): Promise<FilaResuelta[]> {
  if (filas.length === 0) throw new ErrorMaestro('No hay metas para guardar.');
  if (filas.length > MAX_FILAS) throw new ErrorMaestro(`Un lote admite hasta ${MAX_FILAS} filas.`);

  const porTipo = new Map<TipoMeta, Resueltas>();
  for (const tipo of TIPOS_META) {
    if (tipo === 'global') continue;
    const refs = [...new Set(filas.filter((f) => f.tipo === tipo && !f.entidadId && f.referencia).map((f) => f.referencia as string))];
    porTipo.set(tipo, await resolver(tx, tipo, refs));
  }

  const errores: string[] = [];
  const resueltas: FilaResuelta[] = [];
  const vistas = new Map<string, number>();
  for (const f of filas) {
    const problemas: string[] = [];
    if (!(TIPOS_META as readonly string[]).includes(f.tipo)) problemas.push('el tipo no es válido');
    if (!Number.isInteger(f.anio) || f.anio < 2000 || f.anio > 2100) problemas.push('el año debe estar entre 2000 y 2100');
    if (f.mes !== null && (!Number.isInteger(f.mes) || f.mes < 1 || f.mes > 12)) problemas.push('el mes debe estar entre 1 y 12 (o quedar vacío para la meta anual)');
    const monto = parsearMonto(f.monto);
    if (monto === null) problemas.push('la meta debe ser un monto en USD, positivo y con máximo 2 decimales');

    let entidadId: string | null = null;
    if (f.tipo !== 'global') {
      if (f.entidadId) {
        entidadId = f.entidadId;
      } else if (!f.referencia) {
        problemas.push('falta el código');
      } else {
        const id = porTipo.get(f.tipo)?.get(f.tipo === 'cliente' ? (normalizarRif(f.referencia) ?? f.referencia.toUpperCase()) : f.referencia.toUpperCase())
          ?? porTipo.get(f.tipo)?.get(f.referencia.toUpperCase());
        if (id) entidadId = id;
        else problemas.push(`no existe un ${f.tipo} activo con el código ${f.referencia}`);
      }
    }
    if (problemas.length) {
      errores.push(`Fila ${f.fila}: ${problemas.join('; ')}.`);
      continue;
    }
    const k = `${f.tipo}|${entidadId ?? ''}|${f.anio}|${f.mes ?? ''}`;
    const previa = vistas.get(k);
    if (previa !== undefined) {
      errores.push(`Fila ${f.fila}: repite la meta de la fila ${previa} (mismo tipo, código, año y mes).`);
      continue;
    }
    vistas.set(k, f.fila);
    resueltas.push({ tipo: f.tipo, entidadId, anio: f.anio, mes: f.mes, monto: monto as string });
  }
  if (errores.length) throw new ErrorMaestro(informe(errores));
  return resueltas;
}

/** Crea un lote pendiente con las filas ya validadas. Todo o nada. */
export async function crearLoteMetas(
  tx: Db, usuarioId: string, origen: 'excel' | 'manual', filas: FilaMeta[], archivo?: string,
): Promise<{ id: string; version: number; filas: number }> {
  const validas = await validarMetas(tx, filas);
  const { rows } = await tx.query<{ id: string; version: number }>(
    'insert into meta_lote (origen, archivo, creado_por) values ($1, $2, $3) returning id, version',
    [origen, archivo ? archivo.slice(0, 120) : null, usuarioId]);
  const lote = rows[0];
  await tx.query(
    `insert into meta_venta (lote_id, tipo, entidad_id, anio, mes, monto_usd)
     select $1, t, e, a, m, x from unnest($2::text[], $3::uuid[], $4::int[], $5::int[], $6::numeric[]) as u(t, e, a, m, x)`,
    [lote.id, validas.map((f) => f.tipo), validas.map((f) => f.entidadId), validas.map((f) => f.anio),
      validas.map((f) => f.mes), validas.map((f) => f.monto)]);
  return { id: lote.id, version: lote.version, filas: validas.length };
}

export async function aprobarLoteMetas(tx: Db, loteId: string, usuarioId: string): Promise<void> {
  const { rows } = await tx.query(
    `update meta_lote set estado = 'aprobado', resuelto_por = $2 where id = $1 and estado = 'pendiente' returning id`, [loteId, usuarioId]);
  if (!rows[0]) throw new ErrorMaestro('El lote no existe o ya fue resuelto.');
}

export async function rechazarLoteMetas(tx: Db, loteId: string, usuarioId: string, motivo: string): Promise<void> {
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo del rechazo.');
  const { rows } = await tx.query(
    `update meta_lote set estado = 'rechazado', resuelto_por = $2, motivo_rechazo = $3 where id = $1 and estado = 'pendiente' returning id`,
    [loteId, usuarioId, motivo.trim()]);
  if (!rows[0]) throw new ErrorMaestro('El lote no existe o ya fue resuelto.');
}

/** Meta global de un año: la fila GLOBAL, o la suma de las metas de los vendedores (se indica cuál). */
export async function metaGlobal(db: Db, anio: number): Promise<{ origen: 'global' | 'suma_vendedores'; monto: string } | null> {
  const { rows } = await db.query<{ origen: 'global' | 'suma_vendedores'; monto_usd: string }>('select origen, monto_usd from fn_meta_global($1)', [anio]);
  return rows[0] ? { origen: rows[0].origen, monto: rows[0].monto_usd } : null;
}
