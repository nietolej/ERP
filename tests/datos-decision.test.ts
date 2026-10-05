import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearAlmacen } from '@/lib/maestros/almacenes';
import { aprobarCliente, crearCliente, actualizarDatosCliente } from '@/lib/maestros/clientes';
import { cambiarEstadoMotivo, crearMotivo, listarMotivos, motivoSistema, textoDeAnulacion } from '@/lib/maestros/motivos';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '@/lib/maestros/productos';
import { crearVendedor } from '@/lib/maestros/vendedores';
import { agregarLinea, anularPedido, crearPedido, emitirPedido, type Usuario } from '@/lib/ventas/pedidos';
import { listarVentasPerdidas, registrarVentaPerdida } from '@/lib/ventas/perdidas';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

describe('datos que se capturan para decidir (docs/catalogo_decisiones.md)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let gerente: string;
  let almacenista: string;
  let ventas: Usuario;
  let facturacion: string;
  let a01: string;
  let a02: string;
  let cliente: string;
  let vendedor1: string;
  let vendedor2: string;
  let pastilla: string;
  let aceite: string;
  const ids = { anulacionOtro: '' };

  const como = <T,>(usuario: string, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  const mover = (prod: string, almacen: string, tipo: string, cantidad: string, costo = '4.00') => como(almacenista, (tx) => tx.query(
    `insert into movimiento_inventario (tipo, producto_id, almacen_id, cantidad, costo_unitario_usd, origen_tipo, origen_id)
     values ($1, $2, $3, $4, $5, 'prueba', gen_random_uuid())`, [tipo, prod, almacen, cantidad, costo]));
  const motivo = async (tipo: string, codigo: string) =>
    (await db.query<{ id: string }>('select id from motivo where tipo = $1 and codigo = $2', [tipo, codigo])).rows[0].id;
  const hoy = async () => (await db.query<{ d: string }>(`select ((now() at time zone 'America/Caracas')::date)::text as d`)).rows[0].d;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    almacenista = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    facturacion = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    const idVentas = await usuarioDePrueba(db, 'ventas@prueba.test', ['ventas']);
    ventas = { id: idVentas, roles: ['ventas'] };
    await db.query(`insert into tasa_cambio (fecha, moneda, tasa) values (((now() at time zone 'America/Caracas')::date), 'USD', 40.000000)`);
    const sucursal = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('BQTO', 'Barquisimeto') returning id`)).rows[0].id;
    a01 = await db.transaction((tx) => crearAlmacen(tx, '01', { nombre: 'Principal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    a02 = await db.transaction((tx) => crearAlmacen(tx, '02', { nombre: 'Sucursal', sucursalId: sucursal, esComercial: true, permiteVenta: true }));
    vendedor1 = (await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Pedro Pérez', tipo: 'interno', usuarioId: idVentas }))).id;
    vendedor2 = (await db.transaction((tx) => crearVendedor(tx, gerente, { nombre: 'Ana Gómez', tipo: 'interno' }))).id;
    const c = await db.transaction((tx) => crearCliente(tx, facturacion, {
      rif: 'J-12345678-4', tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: { vendedorId: vendedor1 },
    }));
    cliente = c.id;
    const contado = (await db.query<{ id: string }>(`select id from condicion_pago where codigo = 'CONTADO'`)).rows[0].id;
    await db.transaction((tx) => aprobarCliente(tx, cliente, gerente, { condicionPagoId: contado, limiteCreditoUsd: '0', nivelPrecio: 'B', descuentoPct: '5' }));

    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const nuevo = async (codigo: string) => {
      const base = await db.transaction((tx) => resolverProductoBase(tx, `BASE-${codigo}`, { descripcion: `Artículo ${codigo}` }));
      return db.transaction((tx) => crearProducto(tx, almacenista, codigo, {
        descripcion: `Producto ${codigo}`, productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
      }));
    };
    pastilla = await nuevo('PF-001');
    aceite = await nuevo('AC-001');
    ids.anulacionOtro = await motivo('anulacion', 'OTRO');
    const fecha = await hoy();
    await db.transaction(async (tx) => {
      await fijarPrecio(tx, pastilla, 'B', '10.00', fecha);
      await fijarPrecio(tx, aceite, 'B', '20.00', fecha);
    });
  });
  afterAll(() => cerrar());

  describe('existencia y costo al cierre de cada día (R-AP)', () => {
    it('cada movimiento actualiza la fila de hoy y el último valor del día es el cierre', async () => {
      await mover(pastilla, a01, 'entrada_compra', '10', '4.00');
      await mover(pastilla, a01, 'entrada_compra', '5', '6.00');
      await mover(pastilla, a01, 'salida_venta', '-3', '0');
      const f = await hoy();
      const { rows } = await db.query<{ cantidad: string; reservado: string }>(
        'select cantidad::text, reservado::text from existencia_diaria where fecha = $1 and producto_id = $2 and almacen_id = $3', [f, pastilla, a01]);
      expect(rows).toEqual([{ cantidad: '12.0000', reservado: '0.0000' }]);
      const costo = await db.query<{ cantidad: string; valor_usd: string; costo_promedio_usd: string }>(
        'select cantidad::text, valor_usd::text, costo_promedio_usd::text from costo_diario where fecha = $1 and producto_id = $2', [f, pastilla]);
      expect(costo.rows).toEqual([{ cantidad: '12.0000', valor_usd: '56.00', costo_promedio_usd: '4.6667' }]);
    });

    it('una reserva también queda en la fila del día', async () => {
      const id = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: a01 }));
      await como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '2' }));
      await como(ventas.id, (tx) => emitirPedido(tx, ventas, id));
      const { rows } = await db.query<{ reservado: string }>(
        'select reservado::text from existencia_diaria where fecha = $1 and producto_id = $2 and almacen_id = $3', [await hoy(), pastilla, a01]);
      expect(rows[0].reservado).toBe('2.0000');
      await como(ventas.id, (tx) => anularPedido(tx, ventas, id, { motivoId: ids.anulacionOtro, detalle: 'Prueba' }));
    });

    it('el historial solo lo escribe el sistema: no se edita ni se borra a mano', async () => {
      await esperarError(db.query('update existencia_diaria set cantidad = 1'), 'lo escribe el sistema');
      await esperarError(db.query('delete from existencia_diaria'), 'lo escribe el sistema');
      await esperarError(db.query(`insert into existencia_diaria (fecha, producto_id, almacen_id, cantidad, reservado) values ('2020-01-01', $1, $2, 1, 0)`, [pastilla, a01]), 'lo escribe el sistema');
      await esperarError(db.query('update costo_diario set valor_usd = 1'), 'lo escribe el sistema');
      await esperarError(db.query('delete from costo_diario'), 'lo escribe el sistema');
    });

    it('fn_existencia_al y fn_dias_con_existencia conservan la existencia en los días sin movimientos', async () => {
      // Se simulan días pasados como lo haría el sistema (rol interno): aceite en dos almacenes.
      await db.query(`select set_config('app.inventario_interno', '1', false)`);
      await db.query(
        `insert into existencia_diaria (fecha, producto_id, almacen_id, cantidad, reservado) values
           ('2026-03-02', $1, $2, 10, 0),    -- entra en 01 el 02-03
           ('2026-03-05', $1, $2, 0, 0),     -- se agota el 05-03
           ('2026-03-08', $1, $3, 4, 0),     -- entra en 02 el 08-03
           ('2026-03-10', $1, $3, 0, 0)      -- se agota el 10-03`, [aceite, a01, a02]);
      await db.query(`select set_config('app.inventario_interno', '', false)`);

      const al = async (fecha: string) =>
        (await db.query<{ almacen_id: string; cantidad: string }>(
          'select almacen_id, cantidad::text from fn_existencia_al($1) where producto_id = $2 order by almacen_id', [fecha, aceite])).rows;
      expect(await al('2026-03-01')).toEqual([]);
      expect(await al('2026-03-04')).toEqual([{ almacen_id: a01, cantidad: '10.0000' }]);       // día sin movimientos: conserva
      expect(await al('2026-03-09')).toEqual(expect.arrayContaining([{ almacen_id: a01, cantidad: '0.0000' }, { almacen_id: a02, cantidad: '4.0000' }]));

      const dias = async (desde: string, hasta: string) =>
        (await db.query<{ n: number }>('select fn_dias_con_existencia($1, $2, $3) as n', [aceite, desde, hasta])).rows[0].n;
      expect(await dias('2026-03-01', '2026-03-12')).toBe(5);   // 02, 03, 04 (almacén 01) + 08, 09 (almacén 02); antes del 02 no hay dato
      expect(await dias('2026-03-05', '2026-03-07')).toBe(0);
      expect(await dias('2026-03-02', '2026-03-02')).toBe(1);
    });
  });

  describe('catálogos de motivos (R-AQ)', () => {
    it('trae un punto de partida por tipo y Gerencia lo amplía; un motivo no se borra ni cambia de código', async () => {
      const tipos = new Set((await listarMotivos(db)).map((m) => m.tipo));
      expect([...tipos].sort()).toEqual(['anulacion', 'descuento', 'devolucion', 'merma', 'venta_perdida']);
      const id = await db.transaction((tx) => crearMotivo(tx, 'descuento', 'liquidacion', 'Liquidación de temporada'));
      expect((await listarMotivos(db, { tipo: 'descuento' })).map((m) => m.codigo)).toContain('LIQUIDACION');
      await esperarError(db.transaction((tx) => crearMotivo(tx, 'descuento', 'LIQUIDACION', 'Otra vez')), 'Ya existe');
      await esperarError(db.transaction((tx) => crearMotivo(tx, 'otro', 'ABC', 'Tipo malo')), 'tipo de motivo');
      await esperarError(db.transaction((tx) => crearMotivo(tx, 'descuento', 'x', 'Corto')), 'código');
      await esperarError(db.query('delete from motivo where id = $1', [id]), 'no se borra');
      await esperarError(db.query(`update motivo set codigo = 'OTRO2' where id = $1`, [id]), 'no se cambian');
      await db.transaction((tx) => cambiarEstadoMotivo(tx, id, false));
      expect((await listarMotivos(db, { tipo: 'descuento', soloActivos: true })).map((m) => m.codigo)).not.toContain('LIQUIDACION');
    });

    it('los motivos que usa el sistema no se desactivan', async () => {
      const id = await motivoSistema(db, 'descuento', 'DESCUENTO_CLIENTE');
      await esperarError(db.transaction((tx) => cambiarEstadoMotivo(tx, id, false)), 'lo usa el sistema');
    });

    it('el descuento pactado con el cliente lleva su motivo automático; otro descuento exige elegir uno', async () => {
      const id = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: a01 }));
      await como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '1' }));         // 5 % del cliente
      await esperarError(como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: aceite, cantidad: '1', descuentoPct: '10' })), 'motivo del descuento');
      const competencia = await motivo('descuento', 'COMPETENCIA');
      await como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: aceite, cantidad: '1', descuentoPct: '10', motivoDescuentoId: competencia }));
      const { rows } = await db.query<{ codigo: string; descuento_pct: string; motivo: string }>(
        `select p.codigo, l.descuento_pct::text, m.codigo as motivo from documento_venta_linea l
           join producto p on p.id = l.producto_id join motivo m on m.id = l.motivo_descuento_id where l.documento_id = $1 order by l.linea`, [id]);
      expect(rows).toEqual([
        { codigo: 'PF-001', descuento_pct: '5.00', motivo: 'DESCUENTO_CLIENTE' },
        { codigo: 'AC-001', descuento_pct: '10.00', motivo: 'COMPETENCIA' },
      ]);
      await como(ventas.id, (tx) => tx.query('delete from documento_venta where id = $1', [id]));
    });

    it('la base rechaza un descuento sin motivo, con un motivo de otro tipo o con uno inactivo', async () => {
      const id = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: a01 }));
      const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
      const insertar = (motivoId: string | null) => db.query(
        `insert into documento_venta_linea (documento_id, linea, producto_id, descripcion, cantidad, precio_unitario, descuento_pct, alicuota_iva_id, motivo_descuento_id)
         values ($1, 1, $2, 'x', 1, 10, 7, $3, $4)`, [id, pastilla, general, motivoId]);
      await esperarError(insertar(null), 'violates check constraint');
      await esperarError(insertar(await motivo('devolucion', 'DEFECTO')), 'no corresponde');
      const inactivo = await db.transaction((tx) => crearMotivo(tx, 'descuento', 'VIEJO', 'Motivo viejo'));
      await db.transaction((tx) => cambiarEstadoMotivo(tx, inactivo, false));
      await esperarError(insertar(inactivo), 'inactivo');
      await db.query('delete from documento_venta where id = $1', [id]);
    });

    it('toda anulación lleva un motivo de anulación; "Otro" exige el detalle', async () => {
      const id = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: a01 }));
      await como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: pastilla, cantidad: '1' }));
      await como(ventas.id, (tx) => emitirPedido(tx, ventas, id));
      await esperarError(como(ventas.id, (tx) => anularPedido(tx, ventas, id, { motivoId: '00000000-0000-0000-0000-000000000000', detalle: '' })), 'motivo de la anulación');
      const deOtroTipo = await motivo('descuento', 'OTRO');
      await esperarError(como(ventas.id, (tx) => anularPedido(tx, ventas, id, { motivoId: deOtroTipo, detalle: 'x' })), 'motivo de la anulación');
      const otro = await motivo('anulacion', 'OTRO');
      await esperarError(como(ventas.id, (tx) => anularPedido(tx, ventas, id, { motivoId: otro, detalle: ' ' })), 'Explique');
      const cliDesistio = await motivo('anulacion', 'CLIENTE_DESISTIO');
      await como(ventas.id, (tx) => anularPedido(tx, ventas, id, { motivoId: cliDesistio, detalle: 'Llamó a las 3' }));
      const { rows } = await db.query<{ anulado_motivo: string; codigo: string }>(
        `select d.anulado_motivo, m.codigo from documento_venta d join motivo m on m.id = d.anulado_motivo_id where d.id = $1`, [id]);
      expect(rows[0]).toEqual({ anulado_motivo: 'El cliente desistió: Llamó a las 3', codigo: 'CLIENTE_DESISTIO' });
      // La base lo exige aunque alguien se salte la aplicación.
      const otroId = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: a01 }));
      await como(ventas.id, (tx) => agregarLinea(tx, ventas, otroId, { productoId: pastilla, cantidad: '1' }));
      await como(ventas.id, (tx) => emitirPedido(tx, ventas, otroId));
      await esperarError(db.query(`update documento_venta set estado = 'anulado', anulado_motivo = 'sin motivo' where id = $1`, [otroId]), 'no corresponde');
      expect((await textoDeAnulacion(db, { motivoId: cliDesistio }))).toBe('El cliente desistió');
    });
  });

  describe('ventas perdidas (R-AR)', () => {
    it('se registra una venta perdida con su motivo, sin documento, y aparece junto a lo que el sistema registra por falta de existencia', async () => {
      const precio = await motivo('venta_perdida', 'PRECIO');
      const otro = await motivo('venta_perdida', 'OTRO');
      await como(ventas.id, (tx) => registrarVentaPerdida(tx, ventas, { clienteId: cliente, productoId: aceite, almacenId: a01, cantidad: '12', motivoId: precio, observacion: 'Lo consiguió US$ 1 más barato' }));
      await esperarError(como(ventas.id, (tx) => registrarVentaPerdida(tx, ventas, { clienteId: cliente, productoId: aceite, almacenId: a01, cantidad: '0', motivoId: precio })), 'mayor que cero');
      await esperarError(como(ventas.id, (tx) => registrarVentaPerdida(tx, ventas, { clienteId: cliente, productoId: aceite, almacenId: a01, cantidad: '1', motivoId: otro })), 'Explique');
      const deOtroTipo = await motivo('descuento', 'OTRO');
      await esperarError(como(ventas.id, (tx) => registrarVentaPerdida(tx, ventas, { clienteId: cliente, productoId: aceite, almacenId: a01, cantidad: '1', motivoId: deOtroTipo })), 'motivo de la venta perdida');

      // Un pedido sin existencia genera su propio registro, con el motivo del sistema.
      const id = await como(ventas.id, (tx) => crearPedido(tx, ventas, { clienteId: cliente, almacenId: a01 }));
      await como(ventas.id, (tx) => agregarLinea(tx, ventas, id, { productoId: aceite, cantidad: '3' }));
      await como(ventas.id, (tx) => emitirPedido(tx, ventas, id));
      const filas = await listarVentasPerdidas(db, ventas);
      expect(filas.map((f) => [f.codigo, f.cantidad, f.motivo, f.registro])).toEqual(expect.arrayContaining([
        ['AC-001', '12.0000', 'Precio más alto que la competencia', 'manual'],
        ['AC-001', '3.0000', 'No había existencia', 'sistema'],
      ]));
      expect(filas.find((f) => f.registro === 'manual')!.observacion).toBe('Lo consiguió US$ 1 más barato');
    });

    it('quien solo vende registra ventas perdidas de su cartera; el registro no se edita', async () => {
      const ajeno = await db.transaction(async (tx) => {
        const c = await crearCliente(tx, facturacion, {
          rif: 'J-00000010-7', tercero: { razonSocial: 'Autopartes Sur, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
          comercial: { vendedorId: vendedor2 },
        });
        return c.id;
      });
      const porPrecio = await motivo('venta_perdida', 'PRECIO');
      await esperarError(como(ventas.id, (tx) => registrarVentaPerdida(tx, ventas, { clienteId: ajeno, productoId: aceite, almacenId: a01, cantidad: '1', motivoId: porPrecio })), 'no está en su cartera');
      expect((await listarVentasPerdidas(db, ventas)).every((f) => f.cliente !== 'Autopartes Sur, C.A.')).toBe(true);
      await esperarError(db.query('update demanda_no_atendida set cantidad = 1'), 'no se modifica ni se borra');
      await esperarError(db.query('delete from demanda_no_atendida'), 'no se modifica ni se borra');
    });
  });

  describe('historial de cartera (R-AS)', () => {
    it('un cliente nuevo abre su historial con su vendedor, y cada cambio cierra el tramo anterior', async () => {
      const abierto = async () => (await db.query<{ vendedor_id: string }>(
        'select vendedor_id from cliente_vendedor_historial where cliente_id = $1 and hasta is null', [cliente])).rows;
      expect(await abierto()).toEqual([{ vendedor_id: vendedor1 }]);

      await como(gerente, (tx) => actualizarDatosCliente(tx, cliente, {
        tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
        comercial: { vendedorId: vendedor2 },
      }));
      expect(await abierto()).toEqual([{ vendedor_id: vendedor2 }]);
      const { rows } = await db.query<{ vendedor_id: string; cerrado: boolean; cambiado_por: string | null }>(
        'select vendedor_id, (hasta is not null) as cerrado, cambiado_por from cliente_vendedor_historial where cliente_id = $1 order by desde, id', [cliente]);
      expect(rows).toEqual([
        { vendedor_id: vendedor1, cerrado: true, cambiado_por: null },
        { vendedor_id: vendedor2, cerrado: false, cambiado_por: gerente },
      ]);

      // Guardar sin cambiar de vendedor no abre otro tramo.
      await como(gerente, (tx) => actualizarDatosCliente(tx, cliente, {
        tercero: { razonSocial: 'Repuestos Lara, C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
        comercial: { vendedorId: vendedor2, zona: 'Centro' },
      }));
      expect((await db.query('select 1 from cliente_vendedor_historial where cliente_id = $1', [cliente])).rows).toHaveLength(2);
    });

    it('fn_vendedor_de_cliente responde quién lo atendía en cada momento; el historial no se reescribe', async () => {
      const { rows: t } = await db.query<{ desde: string; hasta: string }>(
        `select min(desde)::text as desde, min(hasta)::text as hasta from cliente_vendedor_historial where cliente_id = $1`, [cliente]);
      const v = async (momento: string) => (await db.query<{ v: string | null }>('select fn_vendedor_de_cliente($1, $2) as v', [cliente, momento])).rows[0].v;
      expect(await v('2000-01-01')).toBeNull();
      expect(await v(t[0].desde)).toBe(vendedor1);
      expect(await v(t[0].hasta)).toBe(vendedor2);
      expect(await v('2999-01-01')).toBe(vendedor2);
      await esperarError(db.query('delete from cliente_vendedor_historial'), 'no se borra');
      await esperarError(db.query(`update cliente_vendedor_historial set vendedor_id = $1`, [vendedor2]), 'solo se cierra');
    });

    it('quitar el vendedor cierra el tramo sin abrir otro', async () => {
      await db.query('update cliente set vendedor_id = null where tercero_id = $1', [cliente]);
      expect((await db.query('select 1 from cliente_vendedor_historial where cliente_id = $1 and hasta is null', [cliente])).rows).toHaveLength(0);
    });
  });
});
