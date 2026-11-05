import type { Db } from '@/lib/db/tipos';
import { crearProducto, fijarPrecio, resolverProductoBase, ROLES_PRECIOS, LISTAS } from './productos';
import { ErrorMaestro } from './terceros';

/**
 * Carga masiva de productos (spec §14.4). El personal prepara un CSV con el formato del ERP y el sistema lo valida fila por fila:
 * si hay errores se rechaza la carga completa y se informa cada fila con su problema; si no, se crea todo en una sola transacción.
 * Cada fila pasa por las mismas reglas que el alta manual (`crearProducto`): código único, marca única por código común, unidad, empaque, etc.
 * Los códigos comunes que no existen se crean con la descripción del producto. Las marcas, grupos y alícuotas deben existir (se refieren por su código).
 */

export const ROLES_CARGAN_PRODUCTOS = ['almacen', 'gerencia'] as const;
export const MAX_FILAS_CARGA = 5000;
export const MAX_BYTES_CARGA = 5 * 1024 * 1024;

export const COLUMNAS_PLANTILLA = [
  'codigo', 'descripcion', 'codigo_comun', 'marca', 'grupo', 'unidad', 'alicuota', 'inventariable', 'codigo_alterno', 'peso_kg', 'linea_calidad', 'pais_origen',
  'empaque_unidad', 'unidades_por_empaque', 'empaque_peso_kg', 'empaque_largo_cm', 'empaque_ancho_cm', 'empaque_alto_cm', 'precio_a', 'precio_b', 'precio_d',
] as const;
type Columna = (typeof COLUMNAS_PLANTILLA)[number];

export interface ErrorFila { fila: number; codigo: string; mensaje: string }
export interface ResultadoCarga { filas: number; creados: number; errores: ErrorFila[]; aplicada: boolean }

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '_');

/** Divide una línea CSV respetando comillas. */
function celdas(linea: string, sep: string): string[] {
  const r: string[] = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') { if (comillas && linea[i + 1] === '"') { actual += '"'; i++; } else comillas = !comillas; }
    else if (c === sep && !comillas) { r.push(actual); actual = ''; }
    else actual += c;
  }
  r.push(actual);
  return r.map((x) => x.trim());
}

/** La plantilla (encabezados y una fila de ejemplo) para que el personal la complete. */
export function plantillaCsv(): string {
  const ejemplo: Record<Columna, string> = {
    codigo: 'ABC-123', descripcion: 'Pastilla de freno delantera', codigo_comun: 'PF-0001', marca: 'GENERICA', grupo: '', unidad: 'JGO', alicuota: 'GENERAL', inventariable: 'SI',
    codigo_alterno: '', peso_kg: '1.2', linea_calidad: 'alterna', pais_origen: 'CN', empaque_unidad: 'CJA', unidades_por_empaque: '10', empaque_peso_kg: '12.5',
    empaque_largo_cm: '40', empaque_ancho_cm: '30', empaque_alto_cm: '20', precio_a: '', precio_b: '', precio_d: '',
  };
  return `﻿${COLUMNAS_PLANTILLA.join(';')}\r\n${COLUMNAS_PLANTILLA.map((c) => ejemplo[c]).join(';')}\r\n`;
}

interface FilaLeida { fila: number; v: Partial<Record<Columna, string>> }

/** Lee el CSV: encabezados por nombre (sin importar el orden ni los acentos), separador «;», «,» o tabulación. */
export function leerCsvProductos(contenido: string): FilaLeida[] {
  const lineas = contenido.replace(/^﻿/, '').split(/\r?\n/);
  const primera = lineas.findIndex((l) => l.trim());
  if (primera < 0) throw new ErrorMaestro('El archivo está vacío.');
  const sep = [';', '\t', ','].reduce((mejor, s) => (lineas[primera].split(s).length > lineas[primera].split(mejor).length ? s : mejor), ';');
  const enc = celdas(lineas[primera], sep).map(sinAcentos);
  const faltan = (['codigo', 'descripcion', 'codigo_comun', 'marca', 'unidad', 'alicuota'] as Columna[]).filter((c) => !enc.includes(c));
  if (faltan.length) throw new ErrorMaestro(`Faltan columnas obligatorias en el archivo: ${faltan.join(', ')}. Descargue la plantilla.`);
  const desconocidas = enc.filter((c) => c && !(COLUMNAS_PLANTILLA as readonly string[]).includes(c));
  if (desconocidas.length) throw new ErrorMaestro(`Columnas que no existen en la plantilla: ${desconocidas.join(', ')}.`);
  const filas: FilaLeida[] = [];
  for (let i = primera + 1; i < lineas.length; i++) {
    if (!lineas[i].trim()) continue;
    const c = celdas(lineas[i], sep);
    const v: Partial<Record<Columna, string>> = {};
    enc.forEach((nombre, j) => { if (nombre) v[nombre as Columna] = (c[j] ?? '').trim(); });
    filas.push({ fila: i + 1, v });
  }
  if (!filas.length) throw new ErrorMaestro('El archivo no trae productos.');
  if (filas.length > MAX_FILAS_CARGA) throw new ErrorMaestro(`El archivo trae ${filas.length} filas: el máximo por carga es ${MAX_FILAS_CARGA}.`);
  return filas;
}

const decimal = (s: string | undefined) => (s ?? '').trim().replace(',', '.');
const SI = new Set(['si', 'sí', 's', '1', 'true', 'verdadero', 'x']);
const NO = new Set(['no', 'n', '0', 'false', 'falso']);

/** Se lanza para que la transacción de quien llama se revierta (con errores, o en modo «validar»); lleva el resultado. */
export class CargaRevertida extends Error {
  constructor(readonly resultado: ResultadoCarga) { super('Carga revertida'); }
}

/**
 * Valida y, si `aplicar`, crea los productos dentro de la transacción `tx` de quien llama. Todo o nada: con un solo error —o en modo «validar»—
 * lanza `CargaRevertida` (con el resultado) para que esa transacción se revierta; si no, devuelve el resultado con `aplicada = true`.
 */
export async function cargarProductos(
  tx: Db, u: { id: string; roles: readonly string[] }, contenido: string, aplicar: boolean, vigentePrecios: string,
): Promise<ResultadoCarga> {
  if (!u.roles.some((r) => (ROLES_CARGAN_PRODUCTOS as readonly string[]).includes(r))) throw new ErrorMaestro('Solo Almacén o Gerencia cargan productos.');
  if (contenido.length > MAX_BYTES_CARGA) throw new ErrorMaestro('El archivo no puede pasar de 5 MB.');
  const filas = leerCsvProductos(contenido);
  const puedePrecios = u.roles.some((r) => (ROLES_PRECIOS as readonly string[]).includes(r));

  const mapa = async (sql: string) => new Map((await tx.query<{ codigo: string; id: string }>(sql)).rows.map((r) => [r.codigo.toUpperCase(), r.id]));
  const marcas = await mapa('select codigo, id from marca');
  const grupos = await mapa('select codigo, id from grupo_producto');
  const alicuotas = await mapa('select codigo, id from alicuota_iva where activa');

  const errores: ErrorFila[] = [];
  let creados = 0;
  for (const f of filas) {
    const v = f.v;
    const codigo = (v.codigo ?? '').trim();
    await tx.query('savepoint fila');
    try {
      const marca = marcas.get((v.marca ?? '').toUpperCase());
      if (!marca) throw new ErrorMaestro(`La marca «${v.marca ?? ''}» no existe: créela primero en Maestros → Productos → Catálogos.`);
      const grupo = v.grupo ? grupos.get(v.grupo.toUpperCase()) : null;
      if (v.grupo && !grupo) throw new ErrorMaestro(`El grupo «${v.grupo}» no existe.`);
      const alicuota = alicuotas.get((v.alicuota ?? '').toUpperCase());
      if (!alicuota) throw new ErrorMaestro(`La alícuota «${v.alicuota ?? ''}» no existe (use el código: GENERAL, REDUCIDA, EXENTO…).`);
      const invCrudo = (v.inventariable ?? '').trim().toLowerCase();
      if (invCrudo && !SI.has(invCrudo) && !NO.has(invCrudo)) throw new ErrorMaestro('«inventariable» debe ser SI o NO.');
      const precios = { A: decimal(v.precio_a), B: decimal(v.precio_b), D: decimal(v.precio_d) };
      if (Object.values(precios).some(Boolean) && !puedePrecios) throw new ErrorMaestro('Solo Gerencia o Supervisor de ventas fijan precios: deje vacías las columnas de precio.');
      const base = await resolverProductoBase(tx, v.codigo_comun ?? '', { descripcion: (v.descripcion ?? '').trim() });
      const id = await crearProducto(tx, u.id, codigo, {
        descripcion: v.descripcion ?? '', productoBaseId: base.id, grupoId: grupo ?? null, marcaId: marca, unidad: v.unidad ?? '', alicuotaIvaId: alicuota,
        inventariable: !invCrudo || SI.has(invCrudo), codigoAlterno: v.codigo_alterno, pesoKg: decimal(v.peso_kg), lineaCalidad: v.linea_calidad?.toLowerCase() || null,
        paisOrigen: v.pais_origen?.toUpperCase() || null, empaqueUnidad: v.empaque_unidad, unidadesPorEmpaque: decimal(v.unidades_por_empaque),
        empaquePesoKg: decimal(v.empaque_peso_kg), empaqueLargoCm: decimal(v.empaque_largo_cm), empaqueAnchoCm: decimal(v.empaque_ancho_cm), empaqueAltoCm: decimal(v.empaque_alto_cm),
      });
      for (const lista of LISTAS) if (precios[lista]) await fijarPrecio(tx, id, lista, precios[lista], vigentePrecios);
      await tx.query('release savepoint fila');
      creados++;
    } catch (e) {
      await tx.query('rollback to savepoint fila');
      const mensaje = e instanceof Error ? e.message.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean).join(' · ') : 'Error desconocido.';
      errores.push({ fila: f.fila, codigo, mensaje });
    }
  }
  const resultado: ResultadoCarga = { filas: filas.length, creados: errores.length ? 0 : creados, errores, aplicada: false };
  if (errores.length || !aplicar) throw new CargaRevertida(resultado);
  resultado.aplicada = true;
  return resultado;
}
