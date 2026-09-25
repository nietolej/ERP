import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardarAdjunto } from '@/lib/adjuntos/adjuntos';
import { almacenEnDisco } from '@/lib/adjuntos/almacen';
import { crearBanco } from '@/lib/maestros/bancos';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearLoteMetas } from '@/lib/maestros/metas';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { crearProveedor } from '@/lib/maestros/proveedores';
import { crearVendedor } from '@/lib/maestros/vendedores';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

/**
 * Criterios de aceptación de la Fase 1 (§13):
 *  1. No se puede crear un tercero con RIF inválido o repetido.
 *  2. Ningún código duplicado.
 *  3. Un maestro con movimientos no se puede borrar.
 */
describe('Fase 1: criterios de aceptación', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let dir: string;
  let gerente: string;
  let facturacion: string;
  let compras: string;
  let almacenista: string;
  let supervisor: string;
  let marca: string;
  let alicuota: string;
  let base: string;

  const tercero = (razonSocial: string) => ({ razonSocial, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false });
  const proveedor = (rif: string, nombre: string) => db.transaction((tx) => crearProveedor(tx, compras, {
    rif, sensibles: { ...tercero(nombre), tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null }, contacto: {},
  }));
  const producto = (codigo: string) => db.transaction((tx) => crearProducto(tx, almacenista, codigo, {
    descripcion: 'Producto de prueba', productoBaseId: base, marcaId: marca, unidad: 'und', alicuotaIvaId: alicuota, inventariable: true,
  }));

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    dir = await mkdtemp(path.join(tmpdir(), 'fase1-'));
    gerente = await usuarioDePrueba(db, 'g@prueba.test', ['gerencia']);
    facturacion = await usuarioDePrueba(db, 'f@prueba.test', ['facturacion']);
    compras = await usuarioDePrueba(db, 'c@prueba.test', ['compras']);
    almacenista = await usuarioDePrueba(db, 'a@prueba.test', ['almacen']);
    supervisor = await usuarioDePrueba(db, 's@prueba.test', ['supervisor_ventas']);
    marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    alicuota = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    base = (await db.transaction((tx) => resolverProductoBase(tx, 'BASE-1', { descripcion: 'Artículo base' }))).id;
  });
  afterAll(async () => {
    await cerrar();
    await rm(dir, { recursive: true, force: true });
  });

  it('1. RIF inválido o repetido: cliente y proveedor lo rechazan; la base también', async () => {
    await esperarError(db.transaction((tx) => crearCliente(tx, facturacion, { rif: 'J-12345678-9', tercero: tercero('Malo'), comercial: {} })), 'dígito verificador');
    await db.transaction((tx) => crearCliente(tx, facturacion, { rif: 'J-12345678-4', tercero: tercero('Uno CA'), comercial: {} }));
    await esperarError(db.transaction((tx) => crearCliente(tx, facturacion, { rif: 'j123456784', tercero: tercero('Repetido'), comercial: {} })), 'ya es el cliente');

    await esperarError(proveedor('G-20000303-1', 'Malo'), 'dígito verificador');
    await proveedor('G-20000303-0', 'Prov Uno');
    await esperarError(proveedor('G-20000303-0', 'Repetido'), 'ya es el proveedor');

    // Por debajo de la aplicación, la base rechaza igual.
    await esperarError(db.query(`insert into tercero (rif, razon_social, tipo_persona) values ('J-12345678-9', 'Malo', 'J')`), 'check constraint');
    await esperarError(db.query(`insert into tercero (rif, razon_social, tipo_persona) values ('J-12345678-4', 'Repetido', 'J')`), 'duplicate key');
  });

  it('2. Ningún código duplicado en ningún maestro, sin importar mayúsculas', async () => {
    await producto('ABC-1');
    await esperarError(producto('abc-1'), 'Ya existe');
    await esperarError(
      db.query(`insert into producto (codigo, descripcion, alicuota_iva_id, producto_base_id, marca_id) values ('ABC-1', 'Otro producto', $1, $2, $3)`, [alicuota, base, marca]),
      'duplicate key');

    await esperarError(db.transaction((tx) => crearCatalogo(tx, 'marca', 'generica', 'Otra')), 'Ya existe');
    await esperarError(db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Otra')), 'Ya existe');

    await db.transaction((tx) => crearBanco(tx, '0134', { nombre: 'Banesco', pais: 'VE' }));
    await esperarError(db.transaction((tx) => crearBanco(tx, '0134', { nombre: 'Otro', pais: 'VE' })), 'Ya existe');

    // Los códigos de cliente y vendedor los asigna el numerador: no se pueden escribir a mano ni cambiar.
    const v = await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Pedro Pérez', tipo: 'interno' }));
    await esperarError(db.query(`insert into vendedor (codigo, nombre, tipo) values ('V777', 'Manual', 'interno')`), 'lo asigna el sistema');
    await esperarError(db.query(`update vendedor set codigo = 'V999' where id = $1`, [v.id]), 'no se cambia');
    const { rows } = await db.query<{ codigo: string }>('select codigo from cliente order by codigo');
    expect(new Set(rows.map((r) => r.codigo)).size).toBe(rows.length);
  });

  it('3. Un maestro con metas o adjuntos no se borra: se inactiva', async () => {
    const cliente = (await db.query<{ tercero_id: string; codigo: string }>('select tercero_id, codigo from cliente limit 1')).rows[0];
    const prov = (await db.query<{ tercero_id: string }>('select tercero_id from proveedor limit 1')).rows[0];
    const vendedor = (await db.query<{ id: string; codigo: string }>('select id, codigo from vendedor limit 1')).rows[0];
    const prod = (await db.query<{ id: string }>(`select id from producto where codigo = 'ABC-1'`)).rows[0];
    const grupo = await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', 'FRENOS', 'Frenos'));

    // Sin registros asociados se puede borrar (un error de digitación); con ellos, no.
    const libre = await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Sin nada', tipo: 'interno' }));
    await db.query('delete from vendedor where id = $1', [libre.id]);

    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    await db.transaction((tx) => aprobarCliente(tx, cliente.tercero_id, gerente, { condicionPagoId: contado, limiteCreditoUsd: '100', nivelPrecio: 'B', descuentoPct: '0' }));

    const lote = await db.transaction((tx) => crearLoteMetas(tx, supervisor, 'manual', [
      { fila: 1, tipo: 'vendedor', referencia: vendedor.codigo, anio: 2026, mes: null, monto: 1 },
      { fila: 2, tipo: 'cliente', referencia: cliente.codigo, anio: 2026, mes: null, monto: 1 },
      { fila: 3, tipo: 'producto', referencia: 'ABC-1', anio: 2026, mes: null, monto: 1 },
      { fila: 4, tipo: 'grupo', referencia: 'FRENOS', anio: 2026, mes: null, monto: 1 },
    ]));
    // Aunque el lote se rechace, la fila sigue existiendo como historial.
    await db.query(`update meta_lote set estado = 'rechazado', resuelto_por = $2, motivo_rechazo = 'Prueba' where id = $1`, [lote.id, gerente]);

    const sinBorrar = 'No se puede borrar: tiene metas o adjuntos';
    await esperarError(db.query('delete from vendedor where id = $1', [vendedor.id]), sinBorrar);
    await esperarError(db.query('delete from cliente where tercero_id = $1', [cliente.tercero_id]), sinBorrar);
    await esperarError(db.query('delete from producto where id = $1', [prod.id]), sinBorrar);
    await esperarError(db.query('delete from grupo_producto where id = $1', [grupo]), sinBorrar);

    await db.transaction((tx) => guardarAdjunto(tx, almacenEnDisco(dir), gerente, {
      tipo: 'proveedor', entidadId: prov.tercero_id, nombre: 'rif.pdf', bytes: new TextEncoder().encode('%PDF-1.4 rif'),
    }));
    await esperarError(db.query('delete from proveedor where tercero_id = $1', [prov.tercero_id]), sinBorrar);

    // Un tercero que ya es cliente o proveedor tampoco se borra (llave foránea), y todo sigue existiendo.
    await esperarError(db.query('delete from tercero where id = $1', [cliente.tercero_id]), 'foreign key');
    expect((await db.query('select 1 from cliente where tercero_id = $1', [cliente.tercero_id])).rows).toHaveLength(1);
  });
});
