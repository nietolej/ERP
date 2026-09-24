import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro, vacioANull } from './terceros';

/**
 * Productos (§5.3). Almacén crea y modifica el catálogo; Gerencia y Supervisor de ventas fijan precios.
 * - El código lo escribe el usuario (suelen ser números de parte), en mayúsculas, único y fijo.
 * - La alícuota de IVA es una categoría: el porcentaje sale de parametro_fiscal por fecha.
 * - Los precios de las listas A, B y D (USD) tienen vigencia y no se editan: se registra uno nuevo.
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
const PRECIO = /^\d{1,12}(\.\d{1,2})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export interface DatosProducto {
  descripcion: string;
  grupoId?: string | null;
  marcaId?: string | null;
  familia?: string;
  unidad: string;
  alicuotaIvaId: string;
  inventariable: boolean;
  codigoAlterno?: string;
  /** Texto decimal en kg, hasta 3 decimales. */
  pesoKg?: string;
}

/** Normaliza un código: mayúsculas, sin espacios. */
export const normalizarCodigo = (c: string) => c.trim().toUpperCase().replace(/\s+/g, '');

function validar(d: DatosProducto): void {
  const errores: string[] = [];
  if (d.descripcion.trim().length < 3) errores.push('Indique la descripción del producto.');
  if (!UNIDAD.test(d.unidad.trim().toUpperCase())) errores.push('La unidad debe ser una abreviatura en letras (UND, JGO, PAR, LT…).');
  if (!d.alicuotaIvaId) errores.push('Seleccione la alícuota de IVA.');
  if (d.pesoKg?.trim() && !PESO.test(d.pesoKg.trim())) errores.push('El peso debe ser un número en kg con hasta 3 decimales.');
  if (d.codigoAlterno?.trim() && !CODIGO_PRODUCTO.test(normalizarCodigo(d.codigoAlterno))) {
    errores.push('El código alterno admite letras, números, guiones, puntos y barras.');
  }
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
}

const valores = (d: DatosProducto) => [
  d.descripcion.trim(), d.grupoId || null, d.marcaId || null, vacioANull(d.familia), d.unidad.trim().toUpperCase(),
  d.alicuotaIvaId, d.inventariable, d.codigoAlterno?.trim() ? normalizarCodigo(d.codigoAlterno) : null,
  d.pesoKg?.trim() || null,
];

export async function crearProducto(tx: Db, usuarioId: string, codigo: string, d: DatosProducto): Promise<string> {
  const c = normalizarCodigo(codigo);
  if (!CODIGO_PRODUCTO.test(c)) {
    throw new ErrorMaestro('El código admite hasta 30 letras, números, guiones, puntos y barras, y empieza con letra o número.');
  }
  validar(d);
  const { rows: previo } = await tx.query('select 1 from producto where upper(codigo) = $1', [c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe un producto con el código ${c}.`);
  const { rows } = await tx.query<{ id: string }>(
    `insert into producto (codigo, descripcion, grupo_id, marca_id, familia, unidad, alicuota_iva_id, inventariable,
                           codigo_alterno, peso_kg, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [c, ...valores(d), usuarioId]);
  return rows[0].id;
}

export async function actualizarProducto(tx: Db, id: string, d: DatosProducto): Promise<void> {
  validar(d);
  const { rows } = await tx.query<{ id: string }>(
    `update producto set descripcion = $2, grupo_id = $3, marca_id = $4, familia = $5, unidad = $6, alicuota_iva_id = $7,
            inventariable = $8, codigo_alterno = $9, peso_kg = $10
      where id = $1 returning id`,
    [id, ...valores(d)]);
  if (!rows[0]) throw new ErrorMaestro('El producto no existe.');
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
    `select p.id, p.codigo, p.descripcion, g.codigo as grupo, m.codigo as marca, p.unidad, p.estado,
            fn_precio(p.id, 'A', $3::date) as precio_a, fn_precio(p.id, 'B', $3::date) as precio_b,
            fn_precio(p.id, 'D', $3::date) as precio_d
       from producto p
       left join grupo_producto g on g.id = p.grupo_id
       left join marca m on m.id = p.marca_id
      where ($1 = '' or p.estado = $1)
        and ($2 = '' or upper(p.codigo) like '%' || upper($2) || '%'
                     or upper(coalesce(p.codigo_alterno, '')) like '%' || upper($2) || '%'
                     or fn_nombre_normalizado(p.descripcion) like '%' || fn_nombre_normalizado($2) || '%'
                     or exists (select 1 from producto_referencia r where r.producto_id = p.id
                                  and upper(regexp_replace(r.referencia, '[^A-Za-z0-9]', '', 'g'))
                                      like '%' || upper(regexp_replace($2, '[^A-Za-z0-9]', '', 'g')) || '%'))
      order by p.codigo
      limit $4`,
    [filtro.estado ?? '', texto, hoy, limite]);
  return rows;
}
