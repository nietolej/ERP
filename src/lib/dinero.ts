import Decimal from 'decimal.js';

/** Redondea un importe a 2 decimales (mitad hacia arriba). Nunca usa `float`. */
export const dos = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
