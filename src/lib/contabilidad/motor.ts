import Decimal from 'decimal.js';
import type { Db } from '@/lib/db/tipos';

/**
 * Motor de contabilización (§12.3 de la especificación).
 *
 * Un documento de negocio describe su hecho económico como un EVENTO con importes
 * en su moneda original (p. ej. { base: '100.00', iva: '16.00', total: '116.00' }).
 * Las reglas de `regla_contable` dicen a qué cuenta y a qué lado va cada importe.
 *
 * Garantías:
 * - El asiento se crea y contabiliza en la transacción `tx` del documento.
 * - Idempotente: el mismo origen no genera dos asientos (devuelve el existente).
 * - Importes en VES y USD con decimales exactos; la tasa del día sale de `fn_tasa`.
 * - Si el redondeo a centavos deja una diferencia, se agrega una línea a la cuenta
 *   de redondeo configurada. Diferencias mayores indican reglas mal definidas y fallan.
 *
 * Dos extensiones para los cobros (migración 0028), donde los importes dependen de valores históricos:
 * - `cuentas`: una regla puede apuntar a una cuenta variable (p. ej. el banco donde entró el cobro).
 * - `importesDobles`: un importe puede traer su valor en VES y en USD ya calculado (la parte de una cuenta por cobrar
 *   cancelada vale lo que valía su factura, no lo que vale hoy). Esas líneas no se convierten a la tasa del día.
 */

export interface EventoContable {
  evento: string;
  /** Fecha contable 'YYYY-MM-DD'. */
  fecha: string;
  descripcion: string;
  origen: { tipo: string; id: string };
  /** Moneda de los importes (VES, USD, EUR…). */
  moneda: string;
  /** Importes en la moneda original, como texto decimal ('116.00'). */
  importes: Record<string, string>;
  /** Cuentas de las reglas con cuenta variable (`cuenta_variable`), por nombre. */
  cuentas?: Record<string, string>;
  /** Importes con su valor en VES y USD ya calculado, por la clave del importe. `original` es solo informativo. */
  importesDobles?: Record<string, { ves: string; usd: string; original?: string }>;
  terceroId?: string;
  centroCostoId?: string;
  usuarioId: string;
}

export interface ResultadoContable {
  asientoId: string;
  numero: string;
  yaExistia: boolean;
}

interface Regla {
  orden: number;
  lado: 'D' | 'H';
  cuenta_id: string | null;
  cuenta_variable: string | null;
  importe: string;
  glosa: string | null;
}

/** Línea en la moneda original, antes de convertirla a VES y USD. */
export interface LineaOriginal {
  cuentaId: string;
  lado: 'D' | 'H';
  original: Decimal;
  glosa: string | null;
  centroCostoId?: string | null;
  terceroId?: string | null;
  /** Valor ya calculado en VES y USD: no se convierte. */
  explicito?: { ves: Decimal; usd: Decimal };
}

export interface Tasas {
  /** VES por 1 unidad de la moneda original. */
  moneda: Decimal;
  /** VES por 1 USD. */
  usd: Decimal;
}

const dos = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export class ErrorContable extends Error {}

export async function contabilizar(tx: Db, ev: EventoContable): Promise<ResultadoContable> {
  // Idempotencia (R-E)
  const previo = await tx.query<{ id: string; numero: string }>(
    `select id, numero from asiento where origen_tipo = $1 and origen_id = $2 and tipo = 'automatico'`,
    [ev.origen.tipo, ev.origen.id],
  );
  if (previo.rows[0]) {
    return { asientoId: previo.rows[0].id, numero: previo.rows[0].numero, yaExistia: true };
  }

  const { rows: reglas } = await tx.query<Regla>(
    `select orden, lado, cuenta_id, cuenta_variable, importe, glosa
       from regla_contable where evento = $1 and activa order by orden`,
    [ev.evento],
  );
  if (reglas.length === 0) {
    throw new ErrorContable(`No hay reglas contables activas para el evento "${ev.evento}"`);
  }

  const tasas = await tasasDelDia(tx, ev.moneda, ev.fecha);
  const lineas: LineaOriginal[] = [];
  for (const r of reglas) {
    let cuentaId = r.cuenta_id;
    if (!cuentaId) {
      cuentaId = ev.cuentas?.[r.cuenta_variable ?? ''] ?? null;
      if (!cuentaId) throw new ErrorContable(`El evento "${ev.evento}" no trae la cuenta "${r.cuenta_variable}" que pide la regla ${r.orden}`);
    }
    const doble = ev.importesDobles?.[r.importe];
    if (doble) {
      const ves = new Decimal(doble.ves);
      const usd = new Decimal(doble.usd);
      if (ves.isNegative() || usd.isNegative()) {
        throw new ErrorContable(`El importe "${r.importe}" es negativo (VES ${doble.ves}, USD ${doble.usd}); las reglas usan importes positivos`);
      }
      if (ves.isZero() && usd.isZero()) continue;
      lineas.push({
        cuentaId, lado: r.lado, original: new Decimal(doble.original ?? '0'), glosa: r.glosa,
        centroCostoId: ev.centroCostoId, terceroId: ev.terceroId, explicito: { ves, usd },
      });
      continue;
    }
    const texto = ev.importes[r.importe];
    if (texto === undefined) {
      throw new ErrorContable(`El evento "${ev.evento}" no trae el importe "${r.importe}" que pide la regla ${r.orden}`);
    }
    const original = new Decimal(texto);
    if (original.isNegative()) {
      throw new ErrorContable(`El importe "${r.importe}" es negativo (${texto}); las reglas usan importes positivos`);
    }
    if (original.isZero()) continue;
    lineas.push({
      cuentaId, lado: r.lado, original, glosa: r.glosa,
      centroCostoId: ev.centroCostoId, terceroId: ev.terceroId,
    });
  }

  // Las reglas deben cuadrar en la moneda original: si no, están mal definidas. Con importes dobles (valores históricos
  // distintos de los del día) el cuadre se exige en VES y USD, que lo verifica insertarLineasConvertidas y la base de datos.
  if (!lineas.some((l) => l.explicito) && !cuadraEnOriginal(lineas)) {
    const { debe, haber } = sumasOriginales(lineas);
    throw new ErrorContable(`Las reglas del evento "${ev.evento}" no cuadran: debe ${debe} ≠ haber ${haber}`);
  }

  const { rows: asientos } = await tx.query<{ id: string }>(
    `insert into asiento (fecha, tipo, descripcion, origen_tipo, origen_id, created_by)
     values ($1, 'automatico', $2, $3, $4, $5) returning id`,
    [ev.fecha, ev.descripcion, ev.origen.tipo, ev.origen.id, ev.usuarioId],
  );
  const asientoId = asientos[0].id;
  await insertarLineasConvertidas(tx, asientoId, ev.moneda, tasas, lineas);

  const { rows: final } = await tx.query<{ numero: string }>(
    `update asiento set estado = 'contabilizado', contabilizado_por = $2 where id = $1 returning numero`,
    [asientoId, ev.usuarioId],
  );
  return { asientoId, numero: final[0].numero, yaExistia: false };
}

/** Tasas BCV de la fecha: la de la moneda del documento y la del USD. */
export async function tasasDelDia(tx: Db, moneda: string, fecha: string): Promise<Tasas> {
  const { rows } = await tx.query<{ tasa_moneda: string; tasa_usd: string }>(
    `select fn_tasa($1, $2::date) as tasa_moneda, fn_tasa('USD', $2::date) as tasa_usd`,
    [moneda, fecha],
  );
  return { moneda: new Decimal(rows[0].tasa_moneda), usd: new Decimal(rows[0].tasa_usd) };
}

export function sumasOriginales(lineas: LineaOriginal[]): { debe: Decimal; haber: Decimal } {
  const suma = (lado: 'D' | 'H') =>
    lineas.filter((l) => l.lado === lado).reduce((s, l) => s.plus(l.original), new Decimal(0));
  return { debe: suma('D'), haber: suma('H') };
}

export function cuadraEnOriginal(lineas: LineaOriginal[]): boolean {
  const { debe, haber } = sumasOriginales(lineas);
  return debe.equals(haber);
}

/**
 * Convierte las líneas a VES y USD con las tasas dadas y las inserta en el asiento.
 * Si el redondeo a centavos deja una diferencia (como máximo 1 centavo por línea),
 * agrega una línea a la cuenta de redondeo configurada. Más que eso es un error.
 */
export async function insertarLineasConvertidas(
  tx: Db, asientoId: string, moneda: string, tasas: Tasas, lineas: LineaOriginal[],
): Promise<void> {
  const convertidas = lineas.map((l) => {
    if (l.explicito) return { ...l, ves: l.explicito.ves, usd: l.explicito.usd };
    const ves = dos(l.original.times(tasas.moneda));
    const usd = moneda === 'USD' ? dos(l.original) : dos(ves.dividedBy(tasas.usd));
    return { ...l, ves, usd };
  });
  const suma = (lado: 'D' | 'H', campo: 'ves' | 'usd') =>
    convertidas.filter((l) => l.lado === lado).reduce((s, l) => s.plus(l[campo]), new Decimal(0));

  const tolerancia = new Decimal(lineas.length).times('0.01');
  const difVes = suma('D', 'ves').minus(suma('H', 'ves'));
  const difUsd = suma('D', 'usd').minus(suma('H', 'usd'));
  if (difVes.abs().greaterThan(tolerancia) || difUsd.abs().greaterThan(tolerancia)) {
    throw new ErrorContable(`Diferencia de conversión fuera de tolerancia (VES ${difVes}, USD ${difUsd})`);
  }

  const insertar = (
    cuentaId: string, dv: Decimal, hv: Decimal, du: Decimal, hu: Decimal, original: Decimal,
    glosa: string | null, centroCostoId: string | null = null, terceroId: string | null = null,
  ) =>
    tx.query(
      `insert into asiento_linea (asiento_id, cuenta_id, centro_costo_id, tercero_id,
                                  debe_ves, haber_ves, debe_usd, haber_usd,
                                  moneda_original, monto_original, tasa, glosa)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [asientoId, cuentaId, centroCostoId, terceroId,
       dv.toFixed(2), hv.toFixed(2), du.toFixed(2), hu.toFixed(2),
       moneda, original.toFixed(2), tasas.moneda.toString(), glosa],
    );

  const cero = new Decimal(0);
  for (const l of convertidas) {
    if (l.lado === 'D') await insertar(l.cuentaId, l.ves, cero, l.usd, cero, l.original, l.glosa, l.centroCostoId, l.terceroId);
    else await insertar(l.cuentaId, cero, l.ves, cero, l.usd, l.original, l.glosa, l.centroCostoId, l.terceroId);
  }

  if (!difVes.isZero() || !difUsd.isZero()) {
    const { rows } = await tx.query<{ cuenta_id: string }>(
      `select cuenta_id from configuracion_contable where clave = 'redondeo'`,
    );
    if (!rows[0]) throw new ErrorContable('Falta configurar la cuenta de redondeo');
    const cuentaRedondeo = rows[0].cuenta_id;
    // Si el debe supera al haber, la diferencia se compensa en el haber (y viceversa).
    if (!difVes.isZero()) {
      await insertar(cuentaRedondeo,
        difVes.isNegative() ? difVes.abs() : cero, difVes.isPositive() ? difVes : cero,
        cero, cero, cero, 'Redondeo de conversión (VES)');
    }
    if (!difUsd.isZero()) {
      await insertar(cuentaRedondeo, cero, cero,
        difUsd.isNegative() ? difUsd.abs() : cero, difUsd.isPositive() ? difUsd : cero,
        cero, 'Redondeo de conversión (USD)');
    }
  }
}
