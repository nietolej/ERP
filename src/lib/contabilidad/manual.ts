import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';
import {
  ErrorContable, cuadraEnOriginal, insertarLineasConvertidas, sumasOriginales, tasasDelDia, type LineaOriginal,
} from './motor';

/**
 * Asientos manuales de Contabilidad (§3.1): ajustes, provisiones y cierres.
 *
 * Flujo: Contabilidad registra un borrador (lo puede corregir o eliminar) → el jefe de
 * contabilidad, que no puede ser quien lo registró, lo aprueba y queda contabilizado
 * con su número. La base de datos garantiza la aprobación (R-F, migración 0006),
 * el cuadre, el periodo abierto y que las cuentas controladas por auxiliares no se usen.
 *
 * Los importes se escriben en una sola moneda por asiento y se convierten a VES y USD
 * con la tasa BCV de la fecha del asiento, igual que los asientos automáticos.
 */

export interface LineaManual {
  cuentaId: string;
  /** Texto decimal con hasta 2 decimales; '' o '0' si la línea va al haber. */
  debe: string;
  haber: string;
  glosa?: string;
}

export interface DatosAsientoManual {
  /** 'YYYY-MM-DD' */
  fecha: string;
  descripcion: string;
  moneda: string;
  lineas: LineaManual[];
}

const IMPORTE = /^\d{1,15}(\.\d{1,2})?$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const importe = (v: string) => (v.trim() === '' ? new Decimal(0) : new Decimal(v.trim()));

/** Valida los datos y los convierte a líneas en la moneda original. Lanza ErrorContable. */
export function validarAsientoManual(d: DatosAsientoManual): LineaOriginal[] {
  const errores: string[] = [];
  if (!FECHA.test(d.fecha)) errores.push('Indique la fecha del asiento.');
  if (!d.descripcion.trim()) errores.push('Indique la descripción del asiento.');
  if (!d.moneda) errores.push('Indique la moneda del asiento.');

  const lineas: LineaOriginal[] = [];
  d.lineas.forEach((l, i) => {
    const n = i + 1;
    const debe = l.debe.trim();
    const haber = l.haber.trim();
    if (!l.cuentaId) {
      errores.push(`Línea ${n}: seleccione la cuenta.`);
      return;
    }
    if ((debe && !IMPORTE.test(debe)) || (haber && !IMPORTE.test(haber))) {
      errores.push(`Línea ${n}: el importe debe ser un número positivo con hasta 2 decimales.`);
      return;
    }
    const d1 = importe(debe);
    const h1 = importe(haber);
    if (d1.isZero() === h1.isZero()) {
      errores.push(`Línea ${n}: indique un importe en el debe o en el haber, no en ambos.`);
      return;
    }
    lineas.push({
      cuentaId: l.cuentaId,
      lado: d1.isZero() ? 'H' : 'D',
      original: d1.isZero() ? h1 : d1,
      glosa: l.glosa?.trim() || null,
    });
  });

  if (d.lineas.length < 2) errores.push('El asiento necesita al menos dos líneas.');
  if (errores.length === 0 && !cuadraEnOriginal(lineas)) {
    const { debe, haber } = sumasOriginales(lineas);
    errores.push(`El asiento no cuadra: debe ${debe.toFixed(2)} ≠ haber ${haber.toFixed(2)} ${d.moneda}.`);
  }
  if (errores.length) throw new ErrorContable(errores.join('\n'));
  return lineas;
}

/**
 * Crea un borrador, o reemplaza uno existente (`id`) si lo registró el mismo usuario.
 * Debe llamarse dentro de una transacción. Devuelve el id del asiento.
 */
export async function guardarBorrador(
  tx: Db, usuarioId: string, d: DatosAsientoManual, id?: string,
): Promise<string> {
  const lineas = validarAsientoManual(d);

  // El periodo debe existir y admitir asientos manuales desde el borrador, no solo al aprobar.
  await tx.query(`select fn_validar_periodo(fn_periodo_de($1::date, 'manual'), 'manual')`, [d.fecha]);
  const tasas = await tasasDelDia(tx, d.moneda, d.fecha);

  let asientoId: string;
  if (id) {
    await exigirBorradorPropio(tx, id, usuarioId);
    await tx.query('delete from asiento_linea where asiento_id = $1', [id]);
    await tx.query('update asiento set fecha = $2, descripcion = $3 where id = $1', [id, d.fecha, d.descripcion.trim()]);
    asientoId = id;
  } else {
    const { rows } = await tx.query<{ id: string }>(
      `insert into asiento (fecha, tipo, descripcion, created_by) values ($1, 'manual', $2, $3) returning id`,
      [d.fecha, d.descripcion.trim(), usuarioId],
    );
    asientoId = rows[0].id;
  }
  await insertarLineasConvertidas(tx, asientoId, d.moneda, tasas, lineas);
  return asientoId;
}

/** Elimina un borrador propio. Un asiento contabilizado no se borra (lo impide la base). */
export async function eliminarBorrador(tx: Db, id: string, usuarioId: string): Promise<void> {
  await exigirBorradorPropio(tx, id, usuarioId);
  await tx.query('delete from asiento where id = $1', [id]);
}

async function exigirBorradorPropio(tx: Db, id: string, usuarioId: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string; tipo: string; created_by: string }>(
    'select estado, tipo, created_by from asiento where id = $1 for update', [id]);
  const a = rows[0];
  if (!a || a.tipo !== 'manual') throw new ErrorContable('El asiento manual no existe.');
  if (a.estado !== 'borrador') throw new ErrorContable('El asiento ya está contabilizado: se corrige con un reverso.');
  if (a.created_by !== usuarioId) throw new ErrorContable('Solo quien registró el borrador puede modificarlo o eliminarlo.');
}

/**
 * Huella del contenido del asiento (encabezado y líneas). La pantalla de aprobación la envía
 * y se compara al aprobar: si el borrador cambió después de que el jefe lo revisó, no se aprueba.
 */
export async function huellaAsiento(db: Db, id: string): Promise<string> {
  const { rows: a } = await db.query<{ fecha: string; descripcion: string }>(
    'select fecha, descripcion from asiento where id = $1', [id]);
  const { rows: l } = await db.query(
    `select cuenta_id, debe_ves, haber_ves, debe_usd, haber_usd, moneda_original, monto_original, tasa, glosa
       from asiento_linea where asiento_id = $1 order by id`, [id]);
  return createHash('sha256').update(JSON.stringify([a[0] ?? null, l])).digest('hex');
}

/** Aprueba y contabiliza. Devuelve el número asignado. */
export async function aprobarAsiento(tx: Db, id: string, aprobadorId: string, huella: string): Promise<string> {
  const { rows } = await tx.query<{ estado: string; tipo: string }>(
    'select estado, tipo from asiento where id = $1 for update', [id]);
  const a = rows[0];
  if (!a || a.tipo !== 'manual') throw new ErrorContable('El asiento manual no existe.');
  if (a.estado !== 'borrador') throw new ErrorContable('El asiento ya fue contabilizado.');
  if ((await huellaAsiento(tx, id)) !== huella) {
    throw new ErrorContable('El borrador cambió después de que lo abrió. Revíselo de nuevo antes de aprobarlo.');
  }
  const { rows: r } = await tx.query<{ numero: string }>(
    `update asiento set estado = 'contabilizado', aprobado_por = $2, contabilizado_por = $2
      where id = $1 returning numero`,
    [id, aprobadorId],
  );
  return r[0].numero;
}
