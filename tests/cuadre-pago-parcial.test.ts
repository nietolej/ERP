import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cuadreAuxiliares } from '@/lib/contabilidad/cierre';
import { ImprentaSimulada } from '@/lib/fiscal/imprenta';
import { asignarUsuarios, crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente } from '@/lib/maestros/clientes';
import { crearCuentaBancaria, listarInstrumentos } from '@/lib/maestros/cuentas-bancarias';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { registrarCobro } from '@/lib/ventas/cobros';
import { confirmarSalida } from '@/lib/ventas/despacho';
import { facturarNotas } from '@/lib/ventas/facturas';
import { agregarLinea, crearPedido, emitirPedido, generarNotaEntrega, type Usuario } from '@/lib/ventas/pedidos';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, usuarioDePrueba } from './apoyo';

/**
 * Hallazgo de la siembra de la empresa ficticia: un cobro parcial del 50 % de una factura cuyo valor en dólares deja la mitad en
 * medio centavo (US$ 421,55 → 210,775) hacía que el auxiliar de cuentas por cobrar en USD difiriera un centavo del mayor, porque
 * el cuadre recalculaba `monto_usd × saldo / monto_original` en vez de sumar el `saldo_usd` que mantiene la base (R-BR). Con eso,
 * el checklist del cierre mensual habría bloqueado un mes sin motivo.
 */
describe('cuadre del auxiliar de CxC con pagos parciales (R-BR)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let ventas: Usuario;
  let facturacion: Usuario;
  let almacenista: Usuario;
  let cobranzas: Usuario;
  let almacen: string;
  let cliente: string;
  let producto: string;
  let cuentaVes: string;
  let transferencia: string;
  let hoy = '';

  const como = <T,>(u: Usuario, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    const idGer = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    const idVen = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    const idFac = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idAlm = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    const idCob = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    ventas = { id: idVen, roles: ['ventas'] };
    facturacion = { id: idFac, roles: ['facturacion'] };
    almacenista = { id: idAlm, roles: ['almacen'] };
    cobranzas = { id: idCob, roles: ['cobranzas'] };

    await db.query(`insert into empresa (rif, razon_social, domicilio_fiscal) values ('J-12345678-4', 'Empresa de prueba, C.A.', 'Caracas')`);
    await db.query(`select fn_crear_periodos(extract(year from now())::int)`);
    hoy = (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values ($1, 'USD', 41.370000)`, [hoy]);

    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    almacen = await db.transaction((tx) => crearAlmacen(tx, 'MOS', { nombre: 'Mostrador', sucursalId: sucursal, esComercial: true, permiteVenta: true, usaPicking: false }));
    await db.transaction((tx) => asignarUsuarios(tx, almacen, [idAlm]));
    const vend = await db.transaction((tx) => crearVendedor(tx, idGer, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVen }));
    const c = await db.transaction((tx) => crearCliente(tx, idFac, {
      rif: 'J-00000010-7', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId: vend.id },
    }));
    const cr30 = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CR30'`)).rows[0].id;
    await db.transaction((tx) => aprobarCliente(tx, c.id, idGer, { condicionPagoId: cr30, limiteCreditoUsd: '100000', nivelPrecio: 'B', descuentoPct: '0' }));
    cliente = c.id;

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-PF-001', { descripcion: 'Pastilla' }));
    producto = await db.transaction((tx) => crearProducto(tx, idAlm, 'PF-001', {
      descripcion: 'Pastilla de freno', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
    await db.transaction((tx) => fijarPrecio(tx, producto, 'B', '10.01', hoy));
    await como(almacenista, (tx) => tx.query(
      `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
       values ('entrada_compra', $1, $2, 1000, 4, 'prueba', gen_random_uuid())`, [producto, almacen]));

    const banco = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BNC', 'Banco Nacional') returning id`)).rows[0].id;
    cuentaVes = (await como(cobranzas, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Nacional Bs', tipo: 'banco', moneda: 'VES', bancoId: banco, numero: '0102-0000-11' }))).id;
    transferencia = (await listarInstrumentos(db)).find((i) => i.codigo === 'TRANSFERENCIA')!.id;
  });
  afterAll(() => cerrar());

  it('con facturas de valores distintos pagadas a medias, todos los auxiliares cuadran con el mayor al centavo', async () => {
    let mitadEnMedioCentavo = 0;
    for (let cantidad = 1; cantidad <= 14; cantidad++) {
      const pedido = await como(ventas, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: almacen }));
      await como(ventas, (tx) => agregarLinea(tx, ventas, pedido, { productoId: producto, cantidad: String(cantidad) }));
      await como(ventas, (tx) => emitirPedido(tx, ventas, pedido));
      const nota = await como(ventas, (tx) => generarNotaEntrega(tx, ventas, pedido));
      await como(almacenista, (tx) => confirmarSalida(tx, almacenista, nota));
      const f = await como(facturacion, (tx) => facturarNotas(tx, facturacion, [nota], { servicio: new ImprentaSimulada() }));

      const { rows } = await db.query<{ id: string; saldo: string; monto_usd: string; monto_original: string }>(
        'select id, saldo::text, monto_usd::text, monto_original::text from partida_cxc where documento_id = $1', [f.facturaId]);
      const mitad = (Math.floor(Number(rows[0].saldo) * 100 / 2) / 100).toFixed(2);
      await como(cobranzas, (tx) => registrarCobro(tx, cobranzas, {
        clienteId: cliente, fecha: hoy, instrumentoId: transferencia, cuentaBancariaId: cuentaVes, monto: mitad,
        aplicaciones: [{ partidaId: rows[0].id, monto: mitad }],
      }));
      // ¿La parte en dólares de lo cobrado cae justo en medio centavo? (el caso que descuadraba)
      const proporcional = (Number(rows[0].monto_usd) * Number(mitad)) / Number(rows[0].monto_original) * 100;
      if (Math.abs(proporcional - Math.floor(proporcional) - 0.5) < 1e-6) mitadEnMedioCentavo++;
    }
    expect(mitadEnMedioCentavo).toBeGreaterThan(0);                       // la prueba sí ejerce el caso conflictivo
    // Solo CxC: el stock de esta prueba se inserta sin asiento, así que el auxiliar de inventario no aplica.
    const cxc = (await cuadreAuxiliares(db)).filter((c) => c.nombre.startsWith('Cuentas por cobrar'));
    expect(cxc.map((c) => c.moneda)).toEqual(['VES', 'USD']);
    expect(cxc.filter((c) => !c.ok)).toEqual([]);
  });
});
