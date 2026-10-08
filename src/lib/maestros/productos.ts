import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from './terceros';

/**
 * Productos (§5.3). Almacén crea y modifica el catálogo; Gerencia y Supervisor de ventas fijan precios.
 * - El código lo escribe el usuario (suelen ser números de parte), en mayúsculas, único y fijo.
 * - Cada producto de marca pertenece a un código común (producto_base), que agrupa el mismo artículo
 *   en todas sus marcas: así se analiza por artículo y por artículo-marca (pronósticos, elasticidad).
 * - La alícuota de IVA es una categoría: el porcentaje sale de parametro_fiscal por fecha.
 * - Los precios de las listas A, B y D (USD) tienen vigencia y no se editan: se registra uno nuevo.
 * - Unidad, peso y empaque (unidades por empaque, peso bruto, largo×ancho×alto) alimentan el reparto de flete y gastos
 *   de importación por peso, volumen o cantidad (§7.2); el volumen lo calcula la base.
 * - El costo no es una lista de precio: sale del inventario (§8, Fase 2).
 */

export const ROLES_VEN_PRODUCTOS = [
  'ventas', 'supervisor_ventas', 'facturacion', 'cobranzas', 'compras', 'almacen', 'gerencia',
  'tesoreria', 'contabilidad', 'jefe_contabilidad', 'auditor',
] as const;
export const ROLES_PRECIOS = ['gerencia', 'supervisor_ventas'] as const;
export const LISTAS = ['A', 'B', 'D'] as const;

const CODIGO_PRODUCTO = /^[A-Z0-9][A-Z0-9\-./]{0,29}$/;
const CODIGO_CATALOGO = /^[A-Z0-9][A-Z0-9 ._-]{0,19}$/;
const UNIDAD = /^[A-Z]{1,10}$/;
const PESO = /^\d{1,7}(\.\d{1,3})?$/;
const CANTIDAD = /^\d{1,9}(\.\d{1,3})?$/;
const DIMENSION = /^\d{1,6}(\.\d{1,2})?$/;
const PRECIO = /^\d{1,12}(\.\d{1,2})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const LINEAS_CALIDAD = ['original', 'oem', 'alterna'] as const;
export const NOMBRE_LINEA_CALIDAD: Record<(typeof LINEAS_CALIDAD)[number], string> = {
  original: 'Original (marca del vehículo)',
  oem: 'OEM (fabricante de equipo original)',
  alterna: 'Alterna (aftermarket)',
};

export interface DatosProducto {
  descripcion: string;
  /** Código común al que pertenece (obligatorio: permite analizar el artículo en todas sus marcas). */
  productoBaseId: string;
  grupoId?: string | null;
  marcaId?: string | null;
  unidad: string;
  alicuotaIvaId: string;
  inventariable: boolean;
  codigoAlterno?: string;
  /** Texto decimal en kg, hasta 3 decimales. */
  pesoKg?: string;
  lineaCalidad?: string | null;
  paisOrigen?: string | null;
  /** Unidad de empaque (CJA, BLT, PQT…); vacío = se maneja suelto. */
  empaqueUnidad?: string;
  /** Unidades de venta por empaque (por defecto 1). */
  unidadesPorEmpaque?: string;
  /** Peso bruto del empaque completo en kg. */
  empaquePesoKg?: string;
  /** Dimensiones del empaque en cm: las tres juntas o ninguna. */
  empaqueLargoCm?: string;
  empaqueAnchoCm?: string;
  empaqueAltoCm?: string;
}

/** Normaliza un código: mayúsculas, sin espacios. */
export const normalizarCodigo = (c: string) => c.trim().toUpperCase().replace(/\s+/g, '');

function validar(d: DatosProducto): void {
  const errores: string[] = [];
  if (d.descripcion.trim().length < 3) errores.push('Indique la descripción del producto.');
  if (!d.productoBaseId) errores.push('Indique el código común del producto.');
  if (!d.marcaId) errores.push('Seleccione la marca: el código común agrupa el mismo artículo en varias marcas.');
  if (!UNIDAD.test(d.unidad.trim().toUpperCase())) errores.push('La unidad debe ser una abreviatura en letras (UND, JGO, PAR, LT…).');
  if (!d.alicuotaIvaId) errores.push('Seleccione la alícuota de IVA.');
  if (d.pesoKg?.trim() && !PESO.test(d.pesoKg.trim())) errores.push('El peso debe ser un número en kg con hasta 3 decimales.');
  if (d.empaqueUnidad?.trim() && !UNIDAD.test(d.empaqueUnidad.trim().toUpperCase())) errores.push('La unidad de empaque debe ser una abreviatura en letras (CJA, BLT, PQT…).');
  const porEmpaque = d.unidadesPorEmpaque?.trim();
  if (porEmpaque && (!CANTIDAD.test(porEmpaque) || Number(porEmpaque) <= 0)) errores.push('Las unidades por empaque deben ser un número mayor que cero, con hasta 3 decimales.');
  const pesoEmp = d.empaquePesoKg?.trim();
  if (pesoEmp && (!PESO.test(pesoEmp) || Number(pesoEmp) <= 0)) errores.push('El peso del empaque debe ser un número en kg mayor que cero, con hasta 3 decimales.');
  const dims = [d.empaqueLargoCm, d.empaqueAnchoCm, d.empaqueAltoCm].map((x) => x?.trim() ?? '');
  if (dims.some(Boolean)) {
    if (!dims.every(Boolean)) errores.push('Indique largo, ancho y alto del empaque, o deje las tres medidas vacías.');
    else if (!dims.every((x) => DIMENSION.test(x) && Number(x) > 0)) errores.push('Las medidas del empaque son números en cm mayores que cero, con hasta 2 decimales.');
  }
  if (d.codigoAlterno?.trim() && !CODIGO_PRODUCTO.test(normalizarCodigo(d.codigoAlterno))) {
    errores.push('El código alterno admite letras, números, guiones, puntos y barras.');
  }
  if (d.lineaCalidad && !(LINEAS_CALIDAD as readonly string[]).includes(d.lineaCalidad)) errores.push('Línea de calidad inválida.');
  if (d.paisOrigen && !/^[A-Z]{2}$/.test(d.paisOrigen)) errores.push('El país de origen debe ser un código de dos letras (CN, KR, JP…).');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

/** R-R: una sola marca por código común (mensaje claro antes que el índice único de la base). */
async function exigirMarcaUnica(tx: Db, d: DatosProducto, excluirId?: string): Promise<void> {
  const { rows } = await tx.query<{ codigo: string }>(
    `select codigo from producto where producto_base_id = $1 and marca_id = $2 and ($3::uuid is null or id <> $3::uuid)`,
    [d.productoBaseId, d.marcaId, excluirId ?? null]);
  if (rows[0]) throw new ErrorMaestro(`Ese código común ya tiene un producto de esa marca: ${rows[0].codigo}.`);
}

const valores = (d: DatosProducto) => [
  d.descripcion.trim(), d.productoBaseId, d.grupoId || null, d.marcaId || null, d.unidad.trim().toUpperCase(),
  d.alicuotaIvaId, d.inventariable, d.codigoAlterno?.trim() ? normalizarCodigo(d.codigoAlterno) : null,
  d.pesoKg?.trim() || null, d.lineaCalidad || null, d.paisOrigen || null,
  d.empaqueUnidad?.trim().toUpperCase() || null, d.unidadesPorEmpaque?.trim() || '1', d.empaquePesoKg?.trim() || null,
  d.empaqueLargoCm?.trim() || null, d.empaqueAnchoCm?.trim() || null, d.empaqueAltoCm?.trim() || null,
];

export async function crearProducto(tx: Db, usuarioId: string, codigo: string, d: DatosProducto): Promise<string> {
  const c = normalizarCodigo(codigo);
  if (!CODIGO_PRODUCTO.test(c)) {
    throw new ErrorMaestro('El código admite hasta 30 letras, números, guiones, puntos y barras, y empieza con letra o número.');
  }
  validar(d);
  const { rows: previo } = await tx.query('select 1 from producto where upper(codigo) = $1', [c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe un producto con el código ${c}.`);
  await exigirMarcaUnica(tx, d);
  const { rows } = await tx.query<{ id: string }>(
    `insert into producto (codigo, descripcion, producto_base_id, grupo_id, marca_id, unidad, alicuota_iva_id, inventariable,
                           codigo_alterno, peso_kg, linea_calidad, pais_origen,
                           empaque_unidad, unidades_por_empaque, empaque_peso_kg, empaque_largo_cm, empaque_ancho_cm, empaque_alto_cm, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
    [c, ...valores(d), usuarioId]);
  return rows[0].id;
}

export async function actualizarProducto(tx: Db, id: string, d: DatosProducto): Promise<void> {
  validar(d);
  await exigirMarcaUnica(tx, d, id);
  const { rows } = await tx.query<{ id: string }>(
    `update producto set descripcion = $2, producto_base_id = $3, grupo_id = $4, marca_id = $5, unidad = $6,
            alicuota_iva_id = $7, inventariable = $8, codigo_alterno = $9, peso_kg = $10, linea_calidad = $11, pais_origen = $12,
            empaque_unidad = $13, unidades_por_empaque = $14, empaque_peso_kg = $15,
            empaque_largo_cm = $16, empaque_ancho_cm = $17, empaque_alto_cm = $18
      where id = $1 returning id`,
    [id, ...valores(d)]);
  if (!rows[0]) throw new ErrorMaestro('El producto no existe.');
}

// ---------------------------------------------------------------------------
// Código común (producto_base), categorías y aplicación vehicular
// ---------------------------------------------------------------------------

export interface DatosProductoBase {
  descripcion: string;
  categoriaId?: string | null;
}

/**
 * Devuelve el código común; si no existe, lo crea con `nuevo` (descripción y categoría).
 * Sin `nuevo`, un código inexistente es un error.
 */
export async function resolverProductoBase(
  tx: Db, codigo: string, nuevo?: DatosProductoBase,
): Promise<{ id: string; creado: boolean }> {
  const c = normalizarCodigo(codigo);
  if (!CODIGO_PRODUCTO.test(c)) {
    throw new ErrorMaestro('El código común admite hasta 30 letras, números, guiones, puntos y barras.');
  }
  const { rows } = await tx.query<{ id: string }>('select id from producto_base where upper(codigo) = $1', [c]);
  if (rows[0]) return { id: rows[0].id, creado: false };
  if (!nuevo || nuevo.descripcion.trim().length < 3) {
    throw new ErrorMaestro(`El código común ${c} no existe: indique su descripción genérica para crearlo.`);
  }
  const { rows: r } = await tx.query<{ id: string }>(
    'insert into producto_base (codigo, descripcion, categoria_id) values ($1, $2, $3) returning id',
    [c, nuevo.descripcion.trim(), nuevo.categoriaId || null]);
  return { id: r[0].id, creado: true };
}

export async function actualizarProductoBase(tx: Db, id: string, d: DatosProductoBase): Promise<void> {
  if (d.descripcion.trim().length < 3) throw new ErrorMaestro('Indique la descripción genérica.');
  const { rows } = await tx.query('update producto_base set descripcion = $2, categoria_id = $3 where id = $1 returning id',
    [id, d.descripcion.trim(), d.categoriaId || null]);
  if (!rows[0]) throw new ErrorMaestro('El código común no existe.');
}

export async function crearCategoria(tx: Db, codigo: string, nombre: string, padreId?: string | null): Promise<string> {
  const c = codigo.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(c)) throw new ErrorMaestro('El código admite hasta 20 letras, números, puntos y guiones.');
  if (nombre.trim().length < 2) throw new ErrorMaestro('Indique el nombre de la categoría.');
  const { rows: previo } = await tx.query('select 1 from categoria_producto where codigo = $1', [c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe la categoría ${c}.`);
  const { rows } = await tx.query<{ id: string }>(
    'insert into categoria_producto (codigo, nombre, padre_id) values ($1, $2, $3) returning id', [c, nombre.trim(), padreId || null]);
  return rows[0].id;
}

export async function agregarAplicacion(
  tx: Db, productoBaseId: string, a: { grupoId: string; anioDesde?: string; anioHasta?: string; motor?: string },
): Promise<void> {
  if (!a.grupoId) throw new ErrorMaestro('Seleccione el modelo de vehículo.');
  const anio = (v?: string) => {
    if (!v?.trim()) return null;
    if (!/^\d{4}$/.test(v.trim())) throw new ErrorMaestro('Los años se escriben con 4 dígitos.');
    return Number(v.trim());
  };
  const desde = anio(a.anioDesde);
  const hasta = anio(a.anioHasta);
  if (desde !== null && hasta !== null && hasta < desde) throw new ErrorMaestro('El año final no puede ser menor que el inicial.');
  const motor = a.motor?.trim().toUpperCase() || null;
  const { rows } = await tx.query(
    `select 1 from producto_base_aplicacion where producto_base_id = $1 and grupo_id = $2
        and coalesce(anio_desde, 0) = coalesce($3::smallint, 0) and coalesce(motor, '') = coalesce($4, '')`,
    [productoBaseId, a.grupoId, desde, motor]);
  if (rows.length) throw new ErrorMaestro('Esa aplicación ya está registrada.');
  await tx.query(
    'insert into producto_base_aplicacion (producto_base_id, grupo_id, anio_desde, anio_hasta, motor) values ($1, $2, $3, $4, $5)',
    [productoBaseId, a.grupoId, desde, hasta, motor]);
}

export async function quitarAplicacion(tx: Db, productoBaseId: string, aplicacionId: string): Promise<void> {
  await tx.query('delete from producto_base_aplicacion where id = $1 and producto_base_id = $2', [aplicacionId, productoBaseId]);
}

/** Un producto no se borra: se inactiva (§5.5). */
export async function cambiarEstadoProducto(tx: Db, id: string, estado: 'activo' | 'inactivo'): Promise<void> {
  if (estado !== 'activo' && estado !== 'inactivo') throw new ErrorMaestro('Estado inválido.');
  const { rows } = await tx.query('update producto set estado = $2 where id = $1 returning id', [id, estado]);
  if (!rows[0]) throw new ErrorMaestro('El producto no existe.');
}

export async function agregarReferencia(
  tx: Db, productoId: string, r: { tipo: 'oem' | 'alterna'; fabricante: string; referencia: string },
): Promise<void> {
  if (r.tipo !== 'oem' && r.tipo !== 'alterna') throw new ErrorMaestro('Seleccione si la referencia es OEM o alterna.');
  if (!r.fabricante.trim()) throw new ErrorMaestro('Indique el fabricante.');
  const ref = r.referencia.trim().toUpperCase();
  if (!ref || ref.length > 40) throw new ErrorMaestro('Indique la referencia (hasta 40 caracteres).');
  const { rows } = await tx.query('select 1 from producto_referencia where producto_id = $1 and fabricante = $2 and referencia = $3',
    [productoId, r.fabricante.trim().toUpperCase(), ref]);
  if (rows.length) throw new ErrorMaestro('Esa referencia ya está registrada para este producto.');
  await tx.query('insert into producto_referencia (producto_id, tipo, fabricante, referencia) values ($1, $2, $3, $4)',
    [productoId, r.tipo, r.fabricante.trim().toUpperCase(), ref]);
}

export async function quitarReferencia(tx: Db, productoId: string, referenciaId: string): Promise<void> {
  await tx.query('delete from producto_referencia where id = $1 and producto_id = $2', [referenciaId, productoId]);
}

/** Crea un grupo (modelo de vehículo) o una marca. */
export async function crearCatalogo(tx: Db, tabla: 'grupo_producto' | 'marca', codigo: string, nombre: string): Promise<string> {
  const c = codigo.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!CODIGO_CATALOGO.test(c)) throw new ErrorMaestro('El código admite hasta 20 letras, números, espacios, puntos y guiones.');
  if (!nombre.trim()) throw new ErrorMaestro('Indique el nombre.');
  const { rows: previo } = await tx.query(`select 1 from ${tabla} where codigo = $1`, [c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe ${tabla === 'marca' ? 'la marca' : 'el grupo'} ${c}.`);
  const { rows } = await tx.query<{ id: string }>(`insert into ${tabla} (codigo, nombre) values ($1, $2) returning id`, [c, nombre.trim()]);
  return rows[0].id;
}

/** Registra un precio nuevo con su vigencia (no se editan los anteriores). */
export async function fijarPrecio(
  tx: Db, productoId: string, lista: string, precio: string, vigenteDesde: string,
): Promise<void> {
  if (!(LISTAS as readonly string[]).includes(lista)) throw new ErrorMaestro('Seleccione la lista de precio.');
  if (!PRECIO.test(precio.trim())) throw new ErrorMaestro('El precio debe ser un monto en USD con hasta 2 decimales.');
  if (!FECHA.test(vigenteDesde)) throw new ErrorMaestro('Indique la fecha desde la que rige el precio.');
  const { rows } = await tx.query('select 1 from precio where producto_id = $1 and lista = $2 and vigente_desde = $3',
    [productoId, lista, vigenteDesde]);
  if (rows.length) throw new ErrorMaestro(`Ya hay un precio de la lista ${lista} que rige desde esa fecha.`);
  await tx.query('insert into precio (producto_id, lista, precio, vigente_desde) values ($1, $2, $3, $4)',
    [productoId, lista, precio.trim(), vigenteDesde]);
}

export interface FilaProducto {
  id: string;
  codigo: string;
  codigo_comun: string | null;
  descripcion: string;
  grupo: string | null;
  marca: string | null;
  unidad: string;
  estado: string;
  precio_a: string | null;
  precio_b: string | null;
  precio_d: string | null;
}

/** Busca por código, código alterno, descripción o referencia cruzada (sin guiones ni espacios). */
export async function buscarProductos(db: Db, filtro: { texto?: string; estado?: string }, hoy: string, limite = 100): Promise<FilaProducto[]> {
  const texto = (filtro.texto ?? '').trim();
  const { rows } = await db.query<FilaProducto>(
    `select p.id, p.codigo, b.codigo as codigo_comun, p.descripcion, g.codigo as grupo, m.codigo as marca, p.unidad, p.estado,
            fn_precio(p.id, 'A', $3::date) as precio_a, fn_precio(p.id, 'B', $3::date) as precio_b,
            fn_precio(p.id, 'D', $3::date) as precio_d
       from producto p
       left join producto_base b on b.id = p.producto_base_id
       left join grupo_producto g on g.id = p.grupo_id
       left join marca m on m.id = p.marca_id
      where ($1 = '' or p.estado = $1)
        and ($2 = '' or upper(p.codigo) like '%' || upper($2) || '%'
                     or upper(coalesce(p.codigo_alterno, '')) like '%' || upper($2) || '%'
                     or upper(coalesce(b.codigo, '')) like '%' || upper($2) || '%'
                     or fn_nombre_normalizado(p.descripcion) like '%' || fn_nombre_normalizado($2) || '%'
                     or exists (select 1 from producto_referencia r where r.producto_id = p.id
                                  and upper(regexp_replace(r.referencia, '[^A-Za-z0-9]', '', 'g'))
                                      like '%' || upper(regexp_replace($2, '[^A-Za-z0-9]', '', 'g')) || '%'))
      order by b.codigo nulls last, p.codigo
      limit $4`,
    [filtro.estado ?? '', texto, hoy, limite]);
  return rows;
}
