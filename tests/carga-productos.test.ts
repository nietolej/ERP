import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/tipos';
import {
  CargaRevertida, COLUMNAS_PLANTILLA, cargarProductos, leerCsvProductos, plantillaCsv, type ResultadoCarga,
} from '@/lib/maestros/carga-productos';
import { crearCatalogo } from '@/lib/maestros/productos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Carga masiva de productos (spec §14.4): todo o nada, con cada error en su fila.
 */
describe('carga masiva de productos', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let almacen: { id: string; roles: string[] };
  let gerente: { id: string; roles: string[] };
  let compras: { id: string; roles: string[] };

  let hoy = '';
  const ENC = COLUMNAS_PLANTILLA.join(';');
  /** Una fila a partir de los campos que se indican; el resto va vacío. */
  const fila = (campos: Record<string, string>) => COLUMNAS_PLANTILLA.map((c) => campos[c] ?? '').join(';');
  const archivo = (...filas: string[]) => `${ENC}\r\n${filas.join('\r\n')}\r\n`;
  const base = (codigo: string, extra: Record<string, string> = {}) => fila({
    codigo, descripcion: `Producto ${codigo}`, codigo_comun: `C-${codigo}`, marca: 'GENERICA', unidad: 'UND', alicuota: 'GENERAL', ...extra,
  });
  /** Ejecuta la carga como lo hace la acción: en una transacción que se revierte con CargaRevertida. */
  const cargar = async (contenido: string, aplicar = true, u = almacen): Promise<ResultadoCarga> => {
    try {
      return await db.transaction(async (tx) => {
        await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
        return cargarProductos(tx, u, contenido, aplicar, hoy);
      });
    } catch (e) {
      if (e instanceof CargaRevertida) return e.resultado;
      throw e;
    }
  };
  const productos = async () => Number((await db.query<{ n: string }>('select count(*)::text as n from producto')).rows[0].n);

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    almacen = { id: await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']), roles: ['almacen'] };
    gerente = { id: await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']), roles: ['gerencia'] };
    compras = { id: await usuarioDePrueba(db, 'compras@prueba.test', ['compras']), roles: ['compras'] };
    hoy = (await db.query<{ h: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as h`)).rows[0].h;
    await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    await db.transaction((tx) => crearCatalogo(tx, 'marca', 'OTRA', 'Otra marca'));
    await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'FRENOS', 'Frenos'));
  });
  afterAll(() => cerrar());

  it('la plantilla trae todas las columnas y su fila de ejemplo se carga sin errores', async () => {
    const p = plantillaCsv();
    expect(p.replace('﻿', '').split('\r\n')[0].split(';')).toEqual([...COLUMNAS_PLANTILLA]);
    const r = await cargar(p, false);
    expect(r.errores).toEqual([]);
    expect(r.creados).toBe(1);
    expect(r.aplicada).toBe(false);
  });

  it('validar no guarda nada', async () => {
    const r = await cargar(archivo(base('V-1'), base('V-2')), false);
    expect([r.filas, r.creados, r.errores.length, r.aplicada]).toEqual([2, 2, 0, false]);
    expect(await productos()).toBe(0);
  });

  it('con errores se rechaza la carga completa y cada error trae su fila', async () => {
    const r = await cargar(archivo(
      base('OK-1'),                                                  // fila 2: bien
      base('MAL-1', { marca: 'NOEXISTE' }),                          // fila 3
      base('MAL-2', { alicuota: 'RARA' }),                           // fila 4
      base('MAL-3', { unidad: '123' }),                              // fila 5
      base('MAL-4', { grupo: 'NOHAY' }),                             // fila 6
      base('MAL-5', { inventariable: 'quizás' }),                    // fila 7
      base('OK-1'),                                                  // fila 8: repetido en el archivo
    ));
    expect(r.aplicada).toBe(false);
    expect(r.creados).toBe(0);
    expect(r.errores.map((e) => e.fila)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(r.errores[0].mensaje).toContain('La marca «NOEXISTE» no existe');
    expect(r.errores[1].mensaje).toContain('La alícuota «RARA» no existe');
    expect(r.errores[2].mensaje).toContain('unidad');
    expect(r.errores[3].mensaje).toContain('El grupo «NOHAY» no existe');
    expect(r.errores[4].mensaje).toContain('SI o NO');
    expect(r.errores[5].mensaje).toContain('Ya existe un producto con el código OK-1');
    expect(await productos()).toBe(0);                               // ni siquiera la fila buena
  });

  it('una carga correcta crea los productos, sus códigos comunes y sus precios en una sola transacción', async () => {
    const r = await cargar(archivo(
      base('P-100', { grupo: 'FRENOS', precio_a: '12.50', precio_b: '11', peso_kg: '1,2', inventariable: 'si', linea_calidad: 'oem', pais_origen: 'cn' }),
      base('P-200', { inventariable: 'NO' }),
      fila({ codigo: 'P-300', descripcion: 'Misma pieza otra marca', codigo_comun: 'C-P-100', marca: 'OTRA', unidad: 'UND', alicuota: 'EXENTO' }),
    ), true, gerente);
    expect(r.errores).toEqual([]);
    expect([r.creados, r.errores.length, r.aplicada]).toEqual([3, 0, true]);
    const p = (await db.query<{ codigo: string; inventariable: boolean; peso_kg: string | null; linea_calidad: string | null; pais_origen: string | null }>(
      'select codigo, inventariable, peso_kg::text, linea_calidad, pais_origen from producto order by codigo')).rows;
    expect(p).toEqual([
      { codigo: 'P-100', inventariable: true, peso_kg: '1.200', linea_calidad: 'oem', pais_origen: 'CN' },
      { codigo: 'P-200', inventariable: false, peso_kg: null, linea_calidad: null, pais_origen: null },
      { codigo: 'P-300', inventariable: true, peso_kg: null, linea_calidad: null, pais_origen: null },
    ]);
    const bases = (await db.query<{ n: string }>('select count(*)::text as n from producto_base')).rows[0].n;
    expect(Number(bases)).toBe(2);                                    // C-P-100 (compartido por P-100 y P-300) y C-P-200
    const precios = (await db.query<{ lista: string; precio: string }>(
      `select lista, precio::text from precio pr join producto p on p.id = pr.producto_id where p.codigo = 'P-100' order by lista`)).rows;
    expect(precios).toEqual([{ lista: 'A', precio: '12.50' }, { lista: 'B', precio: '11.00' }]);
  });

  it('un código que ya existe en el catálogo y una marca repetida en el código común se rechazan con su fila', async () => {
    const r = await cargar(archivo(
      base('P-100'),                                                              // ya existe
      fila({ codigo: 'P-400', descripcion: 'Otra de la misma marca', codigo_comun: 'C-P-100', marca: 'GENERICA', unidad: 'UND', alicuota: 'GENERAL' }),
    ));
    expect(r.errores.map((e) => [e.fila, e.mensaje.includes('Ya existe un producto con el código P-100') || e.mensaje.includes('ya tiene un producto de esa marca')])).toEqual([[2, true], [3, true]]);
    expect(await productos()).toBe(3);
  });

  it('solo Gerencia o Supervisor de ventas fijan precios, aunque vengan en la carga', async () => {
    const r = await cargar(archivo(base('P-500', { precio_a: '9.99' })), true, almacen);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0].mensaje).toContain('Solo Gerencia o Supervisor de ventas fijan precios');
    expect(await productos()).toBe(3);
  });

  it('solo Almacén o Gerencia cargan', async () => {
    await esperarError(cargar(archivo(base('P-600')), true, compras), 'Solo Almacén o Gerencia');
  });

  it('el archivo se lee con cualquier orden de columnas, acentos, comas y comillas, y se rechazan columnas ajenas o faltantes', () => {
    const f = leerCsvProductos('Descripción,Código,codigo_comun,Marca,Unidad,Alícuota\n"Bujía, iridio",B-1,CB-1,GENERICA,UND,GENERAL\n');
    expect(f[0].v).toMatchObject({ codigo: 'B-1', descripcion: 'Bujía, iridio', codigo_comun: 'CB-1', marca: 'GENERICA', unidad: 'UND', alicuota: 'GENERAL' });
    expect(f[0].fila).toBe(2);
    expect(() => leerCsvProductos('codigo;descripcion\nX;Y')).toThrow('Faltan columnas obligatorias');
    expect(() => leerCsvProductos(`${ENC};color\r\n`)).toThrow('Columnas que no existen');
    expect(() => leerCsvProductos(`${ENC}\r\n`)).toThrow('no trae productos');
    expect(() => leerCsvProductos('')).toThrow('vacío');
  });
});
