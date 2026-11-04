import { describe, expect, it } from 'vitest';
import { aCsv, celdaCsv } from '@/lib/csv';

describe('Exportación a CSV de reportes (spec_reportes §1.4)', () => {
  it('escapa separador, comillas y saltos de línea, y compacta espacios', () => {
    expect(celdaCsv('Repuestos Lara, C.A.')).toBe('Repuestos Lara, C.A.');
    expect(celdaCsv('a;b')).toBe('"a;b"');
    expect(celdaCsv('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(celdaCsv('  Código \n  PF-001 ')).toBe('Código PF-001');
  });

  it('neutraliza fórmulas pero conserva los negativos', () => {
    expect(celdaCsv('=SUMA(A1:A2)')).toBe("'=SUMA(A1:A2)");
    expect(celdaCsv('@cmd')).toBe("'@cmd");
    expect(celdaCsv('-US$ 5,00')).toBe("'-US$ 5,00");
    expect(celdaCsv('-12,5 %')).toBe('-12,5 %');
  });

  it('arma el archivo con BOM, separador ; y fin de línea CRLF', () => {
    expect(aCsv([['Producto', 'Monto ($)'], ['PF-001', '1.200,00']])).toBe('﻿Producto;Monto ($)\r\nPF-001;1.200,00\r\n');
  });
});
