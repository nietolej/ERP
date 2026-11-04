/**
 * Exportación a CSV de las tablas de los reportes (spec_reportes §1.4: "los mismos campos que se ven en pantalla").
 * Separador `;` y BOM UTF-8: es lo que Excel en configuración regional de Venezuela abre bien, con tildes y columnas separadas.
 */

const SEPARADOR = ';';

/** Escapa una celda: comillas si trae separador, comillas, saltos de línea; y neutraliza fórmulas (=, +, -, @) que Excel ejecutaría. */
export function celdaCsv(valor: string): string {
  const limpio = valor.replace(/\s+/g, ' ').trim();
  const seguro = /^[=+@]/.test(limpio) || /^-[^\d.,\s]/.test(limpio) ? `'${limpio}` : limpio;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

export function aCsv(filas: string[][]): string {
  return `﻿${filas.map((f) => f.map(celdaCsv).join(SEPARADOR)).join('\r\n')}\r\n`;
}

/** Lee una tabla HTML tal como se ve: texto de cada celda (el valor, si la celda es un campo) y sin columnas de casillas de selección. */
export function tablaAFilas(tabla: HTMLTableElement): string[][] {
  const texto = (c: HTMLTableCellElement): string => {
    const campo = c.querySelector('input:not([type=checkbox]):not([type=hidden]), select, textarea') as HTMLInputElement | null;
    return campo ? campo.value : (c.innerText ?? c.textContent ?? '');
  };
  const filas = Array.from(tabla.rows);
  const saltar = new Set<number>();
  filas.forEach((f) => Array.from(f.cells).forEach((c, i) => { if (c.querySelector('input[type=checkbox]')) saltar.add(i); }));
  return filas
    .filter((f) => !(f.cells.length === 1 && f.cells[0].colSpan > 1))
    .map((f) => Array.from(f.cells).map(texto).filter((_, i) => !saltar.has(i)));
}
