import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actualizarDatosCliente, crearCliente } from '@/lib/maestros/clientes';
import {
  actualizarContacto, aprobarCambio, aprobarProveedor, cambiarCondicionProveedor, corregirPendiente, crearProveedor,
  rechazarCambio, solicitarCambio, type DatosSensibles,
} from '@/lib/maestros/proveedores';
import { digitoVerificador } from '@/lib/maestros/rif';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const rif = (letra: string, n: string) => `${letra}-${n}-${digitoVerificador(letra, n)}`;

describe('proveedores (§5.1, matriz de §4.3)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let compras: string;
  let gerente: string;
  let gerenteQueCompra: string;
  let facturacion: string;
  let contado: string;
  let cr30: string;
  let concepto: string;

  const sensibles = (razonSocial: string, extra: Partial<DatosSensibles> = {}): DatosSensibles => ({
    razonSocial, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false,
    tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null, ...extra,
  });
  /** Transacción identificando al usuario, como conUsuario en la aplicación. */
  const como = <T,>(usuario: string, fn: (tx: Db) => Promise<T>) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [usuario]);
    return fn(tx);
  });
  const crear = (r: string, nombre: string, usuario = compras, extra: Partial<DatosSensibles> = {}) =>
    como(usuario, (tx) => crearProveedor(tx, usuario, { rif: r, sensibles: sensibles(nombre, extra), contacto: { telefono: '0212-5550000' } }));
  const idDe = async (codigo: string) =>
    (await db.query<{ id: string }>('select tercero_id as id from proveedor where codigo = $1', [codigo])).rows[0].id;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    compras = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    gerenteQueCompra = await usuarioDePrueba(db, 'gc@prueba.test', ['gerencia', 'compras']);
    facturacion = await usuarioDePrueba(db, 'fact@prueba.test', ['facturacion']);
    const condicion = async (codigo: string) =>
      (await db.query<{ id: string }>('select id from condicion_pago where codigo = $1', [codigo])).rows[0].id;
    contado = await condicion('CONTADO');
    cr30 = await condicion('CR30');
    concepto = (await db.query<{ id: string }>(
      `insert into concepto_islr (codigo, descripcion) values ('SERV', 'Servicios (prueba)') returning id`)).rows[0].id;
  });
  afterAll(() => cerrar());

  it('Compras registra un proveedor pendiente con código del numerador; el RIF no se repite', async () => {
    const p = await crear(rif('J', '11111111'), 'Autopartes del Centro C.A.');
    expect(p.codigo).toBe('P00001');
    await esperarError(crear(rif('J', '11111111'), 'Otro'), 'ya es el proveedor P00001');
    await esperarError(crear(rif('J', '22222222'), 'X', compras, { pais: 'Venezuela' }), 'dos letras');
  });

  it('un cliente puede ser también proveedor: se reutiliza el mismo tercero', async () => {
    const r = rif('J', '33333333');
    const c = await como(facturacion, (tx) => crearCliente(tx, facturacion, {
      rif: r, tercero: { razonSocial: 'Cliente y Proveedor C.A.', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: {},
    }));
    const p = await crear(r, 'Nombre ignorado'); // P00002
    expect(p.id).toBe(c.id);
    expect(p.terceroExistente).toBe(true);
  });

  it('solo Gerencia aprueba, nunca quien lo registró, y asigna la condición de pago', async () => {
    const p = await crear(rif('J', '44444444'), 'Importadora Oriente', gerenteQueCompra); // P00003
    await esperarError(como(compras, (tx) => aprobarProveedor(tx, p.id, compras, contado)), 'rol Gerencia');
    await esperarError(como(gerenteQueCompra, (tx) => aprobarProveedor(tx, p.id, gerenteQueCompra, contado)), 'no puede aprobarlo');
    await como(gerente, (tx) => aprobarProveedor(tx, p.id, gerente, contado));
    const { rows } = await db.query<{ estado: string; condicion_pago_id: string }>(
      'select estado, condicion_pago_id from proveedor where tercero_id = $1', [p.id]);
    expect(rows[0]).toEqual({ estado: 'activo', condicion_pago_id: contado });
  });

  it('pendiente: Compras corrige todo; aprobado: solo el contacto cambia directo', async () => {
    const p = await crear(rif('J', '55555555'), 'Servicios Lara');
    await como(compras, (tx) => corregirPendiente(tx, p.id, {
      sensibles: sensibles('Servicios Lara C.A.', { tipo: 'servicios', conceptoIslrId: concepto }), contacto: { telefono: '0251-1' },
    }));
    await como(gerente, (tx) => aprobarProveedor(tx, p.id, gerente, contado));

    await como(compras, (tx) => actualizarContacto(tx, p.id, { telefono: '0251-2', email: 'Ventas@Lara.test' }));
    const { rows } = await db.query<{ telefono: string; email: string }>('select telefono, email from tercero where id = $1', [p.id]);
    expect(rows[0]).toEqual({ telefono: '0251-2', email: 'ventas@lara.test' });

    await esperarError(
      como(compras, (tx) => corregirPendiente(tx, p.id, { sensibles: sensibles('Otro nombre'), contacto: {} })), 'ya fue aprobado');
  });

  it('R-N: la base impide cambiar datos sensibles de un proveedor aprobado por fuera de una solicitud', async () => {
    const id = await idDe('P00003');
    await esperarError(db.query(`update proveedor set tipo = 'gastos' where tercero_id = $1`, [id]), 'solicitud aprobada');
    await esperarError(db.query(`update tercero set razon_social = 'Desvío C.A.' where id = $1`, [id]), 'solicitud aprobada');
    await esperarError(db.query('update tercero set contribuyente_especial = true where id = $1', [id]), 'solicitud aprobada');
    await esperarError(
      como(compras, (tx) => tx.query('update proveedor set condicion_pago_id = $2 where tercero_id = $1', [id, cr30])), 'Solo Gerencia');
    await como(gerente, (tx) => cambiarCondicionProveedor(tx, id, cr30));
  });

  it('R-N: tampoco desde la pantalla de clientes si el tercero es proveedor aprobado', async () => {
    const id = await idDe('P00002');
    await como(gerente, (tx) => aprobarProveedor(tx, id, gerente, contado));
    await esperarError(como(facturacion, (tx) => actualizarDatosCliente(tx, id, {
      tercero: { razonSocial: 'Nombre nuevo por clientes', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: {},
    })), 'solicitud aprobada por Gerencia');
  });

  it('solicitud de cambio: guarda solo lo que cambia; Gerencia (otra persona) la aprueba y se aplica', async () => {
    const id = await idDe('P00003');
    await esperarError(
      como(compras, (tx) => solicitarCambio(tx, id, compras, sensibles('Importadora Oriente'))), 'No hay cambios');

    const cambio = await como(compras, (tx) => solicitarCambio(tx, id, compras,
      sensibles('Importadora Oriente 2026 C.A.', { tipo: 'importacion', pais: 'CN', conceptoIslrId: concepto })));
    const { rows: c } = await db.query<{ datos: Record<string, unknown> }>('select datos from proveedor_cambio where id = $1', [cambio]);
    expect(c[0].datos).toEqual({ razon_social: 'Importadora Oriente 2026 C.A.', tipo: 'importacion', pais: 'CN', concepto_islr_id: concepto });

    await esperarError(como(compras, (tx) => solicitarCambio(tx, id, compras, sensibles('Otro'))), 'Ya hay una solicitud');
    await esperarError(como(compras, (tx) => aprobarCambio(tx, cambio, compras)), 'rol Gerencia');

    await como(gerente, (tx) => aprobarCambio(tx, cambio, gerente));
    const { rows: p } = await db.query<{ razon_social: string; tipo: string; pais: string; concepto_islr_id: string }>(
      `select t.razon_social, p.tipo, p.pais, p.concepto_islr_id from proveedor p join tercero t on t.id = p.tercero_id
        where p.tercero_id = $1`, [id]);
    expect(p[0]).toEqual({ razon_social: 'Importadora Oriente 2026 C.A.', tipo: 'importacion', pais: 'CN', concepto_islr_id: concepto });
    await esperarError(como(gerente, (tx) => aprobarCambio(tx, cambio, gerente)), 'ya fue resuelta');
  });

  it('quien solicita un cambio no lo aprueba ni lo rechaza; el rechazo exige motivo y no cambia nada', async () => {
    const id = await idDe('P00003');
    const cambio = await como(gerenteQueCompra, (tx) => solicitarCambio(tx, id, gerenteQueCompra,
      sensibles('Importadora Oriente 2026 C.A.', { tipo: 'gastos', pais: 'CN', conceptoIslrId: concepto })));
    await esperarError(como(gerenteQueCompra, (tx) => aprobarCambio(tx, cambio, gerenteQueCompra)), 'no puede aprobarlo');
    await esperarError(como(gerenteQueCompra, (tx) => rechazarCambio(tx, cambio, gerenteQueCompra, 'x')), 'no puede rechazarlo');
    await esperarError(como(gerente, (tx) => rechazarCambio(tx, cambio, gerente, '  ')), 'motivo');
    await como(gerente, (tx) => rechazarCambio(tx, cambio, gerente, 'El proveedor no es de gastos'));
    const { rows: p } = await db.query<{ tipo: string }>('select tipo from proveedor where tercero_id = $1', [id]);
    expect(p[0].tipo).toBe('importacion');
  });

  it('un proveedor no se borra', async () => {
    await esperarError(db.query('delete from tercero where id = $1', [await idDe('P00001')]), 'foreign key');
  });
});
