import Decimal from 'decimal.js';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Reparto de gastos de importación entre las líneas de una compra (§7.2, regla 3).
 *
 * El gasto (flete, seguro, aranceles, agente…) se reparte proporcionalmente a una base que elige quien compra:
 *   · valor     importe de la línea (FOB)
 *   · peso      cantidad × peso por unidad (kg)
 *   · volumen   cantidad × volumen por unidad (m³, calculado por la base con las medidas del empaque)
 *   · cantidad  unidades
 * El reparto es exacto a centavos: la suma de las partes es el gasto, sin diferencias de redondeo. Los centavos
 * que sobran del redondeo hacia abajo van a las líneas con mayor residuo (y, en empate, a la primera).
 */

export const CRITERIOS_REPARTO = ['valor', 'peso', 'volumen', 'cantidad'] as const;
export type CriterioReparto = (typeof CRITERIOS_REPARTO)[number];

export const NOMBRE_CRITERIO: Record<CriterioReparto, string> = {
  valor: 'Valor (FOB)', peso: 'Peso (kg)', volumen: 'Volumen (m³)', cantidad: 'Cantidad (unidades)',
};

export interface LineaReparto {
  id: string;
  codigo: string;
  cantidad: string;
  /** Importe de la línea (cantidad × precio), en la moneda del gasto. */
  valor: string;
  pesoUnitarioKg: string | null;
  volumenUnitarioM3: string | null;
}

/** Productos a los que les falta la medida que pide el criterio. Vacío si el criterio se puede aplicar. */
export function productosSinMedida(lineas: Pick<LineaReparto, 'codigo' | 'pesoUnitarioKg' | 'volumenUnitarioM3'>[], criterio: CriterioReparto): string[] {
  if (criterio === 'peso') return lineas.filter((l) => !l.pesoUnitarioKg || new Decimal(l.pesoUnitarioKg).lte(0)).map((l) => l.codigo);
  if (criterio === 'volumen') return lineas.filter((l) => !l.volumenUnitarioM3 || new Decimal(l.volumenUnitarioM3).lte(0)).map((l) => l.codigo);
  return [];
}

export function mensajeSinMedida(criterio: CriterioReparto, codigos: string[]): string {
  const medida = criterio === 'peso' ? 'el peso por unidad' : 'las medidas del empaque (largo, ancho y alto)';
  const lista = codigos.slice(0, 5).join(', ') + (codigos.length > 5 ? ` y ${codigos.length - 5} más` : '');
  return `Para repartir por ${criterio} todos los productos necesitan ${medida}. Falta en: ${lista}.`;
}

const base = (l: LineaReparto, criterio: CriterioReparto): Decimal => {
  switch (criterio) {
    case 'valor': return new Decimal(l.valor);
    case 'cantidad': return new Decimal(l.cantidad);
    case 'peso': return new Decimal(l.cantidad).times(l.pesoUnitarioKg ?? 0);
    case 'volumen': return new Decimal(l.cantidad).times(l.volumenUnitarioM3 ?? 0);
  }
};

/** Parte del gasto que le toca a cada línea (id → importe con 2 decimales). */
export function repartirCosto(lineas: LineaReparto[], monto: string, criterio: CriterioReparto): Map<string, string> {
  if (!(CRITERIOS_REPARTO as readonly string[]).includes(criterio)) throw new ErrorMaestro('Criterio de reparto inválido.');
  const total = new Decimal(monto);
  if (!total.isFinite() || total.lte(0)) throw new ErrorMaestro('El gasto a repartir debe ser mayor que cero.');
  if (!lineas.length) throw new ErrorMaestro('No hay líneas entre las que repartir el gasto.');
  const faltan = productosSinMedida(lineas, criterio);
  if (faltan.length) throw new ErrorMaestro(mensajeSinMedida(criterio, faltan));

  const bases = lineas.map((l) => base(l, criterio));
  const suma = bases.reduce((s, b) => s.plus(b), new Decimal(0));
  if (suma.lte(0)) throw new ErrorMaestro(`La base de reparto por ${criterio} es cero: no hay entre qué repartir.`);

  const partes = bases.map((b, i) => {
    const exacta = total.times(b).dividedBy(suma);
    const piso = exacta.toDecimalPlaces(2, Decimal.ROUND_DOWN);
    return { i, piso, residuo: exacta.minus(piso) };
  });
  let centavos = total.minus(partes.reduce((s, p) => s.plus(p.piso), new Decimal(0))).times(100).toNumber();
  const porResiduo = [...partes].sort((a, b) => b.residuo.comparedTo(a.residuo) || a.i - b.i);
  for (const p of porResiduo) {
    if (centavos <= 0) break;
    p.piso = p.piso.plus('0.01');
    centavos -= 1;
  }
  return new Map(lineas.map((l, i) => [l.id, partes[i].piso.toFixed(2)]));
}
