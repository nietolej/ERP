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
  cuenta_id: string;
  importe: string;
  glosa: string | null;
}

interface Linea {
  cuentaId: string;
  lado: 'D' | 'H';
  original: Decimal;
  ves: Decimal;
  usd: Decimal;
  glosa: string | null;
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
    `select orden, lado, cuenta_id, importe, glosa
       from regla_contable where evento = $1 and activa order by orden`,
    [ev.evento],
  );
  if (reglas.length === 0) {
    throw new ErrorContable(`No hay reglas contables activas para el evento "${ev.evento}"`);
  }

  const { rows: tasas } = await tx.query<{ tasa_moneda: string; tasa_usd: string }>(
    `select fn_tasa($1, $2::date) as tasa_moneda, fn_tasa('USD', $2::date) as tasa_usd`,
    [ev.moneda, ev.fecha],
  );
  const tasaMoneda = new Decimal(tasas[0].tasa_moneda);
  const tasaUsd = new Decimal(tasas[0].tasa_usd);

  const lineas: Linea[] = [];
  for (const r of reglas) {
    const texto = ev.importes[r.importe];
    if (texto === undefined) {
      throw new ErrorContable(`El evento "${ev.evento}" no trae el importe "${r.importe}" que pide la regla ${r.orden}`);
    }
    const original = new Decimal(texto);
    if (original.isNegative()) {
      throw new ErrorContable(`El importe "${r.importe}" es negativo (${texto}); las reglas usan importes positivos`);
    }
    if (original.isZero()) continue;
    const ves = dos(original.times(tasaMoneda));
    const usd = ev.moneda === 'USD' ? dos(original) : dos(ves.dividedBy(tasaUsd));
    lineas.push({ cuentaId: r.cuenta_id, lado: r.lado, original, ves, usd, glosa: r.glosa });
  }

  // Las reglas deben cuadrar en la moneda original: si no, están mal definidas.
  const suma = (lado: 'D' | 'H', campo: 'original' | 'ves' | 'usd') =>
    lineas.filter((l) => l.lado === lado).reduce((s, l) => s.plus(l[campo]), new Decimal(0));
  if (!suma('D', 'original').equals(suma('H', 'original'))) {
    throw new ErrorContable(
      `Las reglas del evento "${ev.evento}" no cuadran: debe ${suma('D', 'original')} ≠ haber ${suma('H', 'original')}`,
    );
  }

  // Redondeo: como máximo 1 centavo por línea; más que eso es un error de reglas.
  const tolerancia = new Decimal(lineas.length).times('0.01');
  const difVes = suma('D', 'ves').minus(suma('H', 'ves'));
  const difUsd = suma('D', 'usd').minus(suma('H', 'usd'));
  if (difVes.abs().greaterThan(tolerancia) || difUsd.abs().greaterThan(tolerancia)) {
    throw new ErrorContable(`Diferencia de conversión fuera de tolerancia (VES ${difVes}, USD ${difUsd})`);
  }

  const { rows: asientos } = await tx.query<{ id: string }>(
    `insert into asiento (fecha, tipo, descripcion, origen_tipo, origen_id, created_by)
     values ($1, 'automatico', $2, $3, $4, $5) returning id`,
    [ev.fecha, ev.descripcion, ev.origen.tipo, ev.origen.id, ev.usuarioId],
  );
  const asientoId = asientos[0].id;

  const insertar = (cuentaId: string, dv: Decimal, hv: Decimal, du: Decimal, hu: Decimal, original: Decimal, glosa: string | null) =>
    tx.query(
      `insert into asiento_linea (asiento_id, cuenta_id, centro_costo_id, tercero_id,
                                  debe_ves, haber_ves, debe_usd, haber_usd,
                                  moneda_original, monto_original, tasa, glosa)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [asientoId, cuentaId, ev.centroCostoId ?? null, ev.terceroId ?? null,
       dv.toFixed(2), hv.toFixed(2), du.toFixed(2), hu.toFixed(2),
       ev.moneda, original.toFixed(2), tasaMoneda.toString(), glosa],
    );

  const cero = new Decimal(0);
  for (const l of lineas) {
    if (l.lado === 'D') await insertar(l.cuentaId, l.ves, cero, l.usd, cero, l.original, l.glosa);
    else await insertar(l.cuentaId, cero, l.ves, cero, l.usd, l.original, l.glosa);
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

  const { rows: final } = await tx.query<{ numero: string }>(
    `update asiento set estado = 'contabilizado', contabilizado_por = $2 where id = $1 returning numero`,
    [asientoId, ev.usuarioId],
  );
  return { asientoId, numero: final[0].numero, yaExistia: false };
}
