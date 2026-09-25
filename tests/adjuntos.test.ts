import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { almacenEnDisco, type AlmacenArchivos } from '@/lib/adjuntos/almacen';
import {
  anularAdjunto, guardarAdjunto, leerAdjunto, listarAdjuntos, MAX_BYTES_ADJUNTO, nombreSeguro, puedeAgregarAdjuntos,
  puedeVerAdjuntos, tipoDeContenido,
} from '@/lib/adjuntos/adjuntos';
import { crearCliente } from '@/lib/maestros/clientes';
import { crearCatalogo, crearProducto, resolverProductoBase } from '@/lib/maestros/productos';
import { crearProveedor } from '@/lib/maestros/proveedores';
import type { Db } from '@/lib/db/tipos';
import { baseDePrueba, esperarError, usuarioDePrueba } from './apoyo';

const pdf = (extra = '') => new TextEncoder().encode(`%PDF-1.4\n${extra}\n%%EOF`);
const png = (extra = 0) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, extra, 1, 2, 3]);
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('adjuntos: reconocimiento de archivos', () => {
  it('reconoce PDF, PNG, JPEG y WebP por su contenido', () => {
    expect(tipoDeContenido(pdf())).toBe('application/pdf');
    expect(tipoDeContenido(png())).toBe('image/png');
    expect(tipoDeContenido(jpg)).toBe('image/jpeg');
    expect(tipoDeContenido(webp)).toBe('image/webp');
  });

  it('rechaza lo demás, aunque diga ser un PDF', () => {
    expect(tipoDeContenido(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(tipoDeContenido(new TextEncoder().encode('MZ\u0090\u0000 ejecutable'))).toBeNull();
    expect(tipoDeContenido(new TextEncoder().encode('%PDF'))).toBeNull(); // le falta el guion de la versión
    expect(tipoDeContenido(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull(); // WAV
    expect(tipoDeContenido(new Uint8Array())).toBeNull();
  });

  it('limpia el nombre: sin rutas ni caracteres peligrosos', () => {
    expect(nombreSeguro('C:\\Users\\yo\\comprobante.pdf')).toBe('comprobante.pdf');
    expect(nombreSeguro('../../etc/passwd')).toBe('passwd');
    expect(nombreSeguro('a"b<c>d|e:f*g?.png')).toBe('abcdefg.png');
    expect(nombreSeguro('  varios   espacios.pdf ')).toBe('varios espacios.pdf');
    expect(nombreSeguro('///')).toBe('archivo');
    expect(nombreSeguro('x'.repeat(300) + '.pdf').length).toBe(150);
  });
});

describe('adjuntos: guardado, permisos y anulación (§4.2)', () => {
  let db: Db;
  let cerrar: () => Promise<void>;
  let dir: string;
  let almacen: AlmacenArchivos;
  let gerente: string;
  let facturacion: string;
  let cobranzas: string;
  let compras: string;
  let almacenista: string;
  let auditor: string;
  let vendedorA: string;
  let vendedorB: string;
  let cliente: string;
  let clienteDeB: string;
  let proveedor: string;
  let producto: string;

  const u = (id: string, ...roles: string[]) => ({ id, roles });
  const subir = (usuario: string, tipo: 'cliente' | 'proveedor' | 'producto', entidad: string, bytes: Uint8Array, nombre = 'soporte.pdf') =>
    db.transaction((tx) => guardarAdjunto(tx, almacen, usuario, { tipo, entidadId: entidad, nombre, bytes }));
  const archivosEnDisco = async () => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;

  beforeAll(async () => {
    ({ db, cerrar } = await baseDePrueba());
    dir = await mkdtemp(path.join(tmpdir(), 'adjuntos-'));
    almacen = almacenEnDisco(dir);
    gerente = await usuarioDePrueba(db, 'gerente@prueba.test', ['gerencia']);
    facturacion = await usuarioDePrueba(db, 'facturacion@prueba.test', ['facturacion']);
    cobranzas = await usuarioDePrueba(db, 'cobranzas@prueba.test', ['cobranzas']);
    compras = await usuarioDePrueba(db, 'compras@prueba.test', ['compras']);
    almacenista = await usuarioDePrueba(db, 'almacen@prueba.test', ['almacen']);
    auditor = await usuarioDePrueba(db, 'auditor@prueba.test', ['auditor']);
    vendedorA = await usuarioDePrueba(db, 'va@prueba.test', ['ventas']);
    vendedorB = await usuarioDePrueba(db, 'vb@prueba.test', ['ventas']);

    const vend = async (usuario: string, nombre: string) =>
      (await db.query<{ id: string }>(`insert into vendedor (nombre, tipo, usuario_id) values ($1, 'interno', $2) returning id`, [nombre, usuario])).rows[0].id;
    const idA = await vend(vendedorA, 'Vendedor A');
    const idB = await vend(vendedorB, 'Vendedor B');
    const nuevo = (rif: string, nombre: string, vendedorId: string) => db.transaction((tx) => crearCliente(tx, facturacion, {
      rif, tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false }, comercial: { vendedorId },
    }));
    cliente = (await nuevo('J-12345678-4', 'Cliente de A', idA)).id;
    clienteDeB = (await nuevo('J-00002961-0', 'Cliente de B', idB)).id;
    proveedor = (await db.transaction((tx) => crearProveedor(tx, compras, {
      rif: 'G-20000303-0',
      sensibles: { razonSocial: 'Proveedor Uno', domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'mercancia_local', pais: 'VE', conceptoIslrId: null },
      contacto: {},
    }))).id;
    const marca = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'GENERICA', 'Genérica'));
    const general = (await db.query<{ id: string }>(`select id from alicuota_iva where codigo = 'GENERAL'`)).rows[0].id;
    const base = await db.transaction((tx) => resolverProductoBase(tx, 'BASE-1', { descripcion: 'Filtro de aceite' }));
    producto = await db.transaction((tx) => crearProducto(tx, almacenista, 'FIL-001', {
      descripcion: 'Filtro de aceite', productoBaseId: base.id, marcaId: marca, unidad: 'und', alicuotaIvaId: general, inventariable: true,
    }));
  });
  afterAll(async () => {
    await cerrar();
    await rm(dir, { recursive: true, force: true });
  });

  it('guarda el archivo con su huella y lo lee de vuelta idéntico', async () => {
    const bytes = pdf('comprobante de pago');
    const id = await subir(cobranzas, 'cliente', cliente, bytes, 'C:\\pagos\\comprobante 001.pdf');
    const { rows } = await db.query<{ nombre: string; tipo_contenido: string; tamano_bytes: number; hash_sha256: string }>(
      'select nombre, tipo_contenido, tamano_bytes, hash_sha256 from adjunto where id = $1', [id]);
    expect(rows[0]).toMatchObject({ nombre: 'comprobante 001.pdf', tipo_contenido: 'application/pdf', tamano_bytes: bytes.length });
    expect(rows[0].hash_sha256).toMatch(/^[0-9a-f]{64}$/);

    const leido = await leerAdjunto(db, almacen, u(gerente, 'gerencia'), id);
    expect(leido?.nombre).toBe('comprobante 001.pdf');
    expect(Buffer.compare(leido!.bytes, Buffer.from(bytes))).toBe(0);
    // El archivo va en disco con el id como nombre, nunca con el nombre que trajo el usuario.
    expect((await readdir(dir, { recursive: true })).some((f) => f.includes('comprobante'))).toBe(false);
  });

  it('rechaza archivos vacíos, muy grandes, de otro tipo y repetidos; y no deja huérfanos en disco', async () => {
    const antes = await archivosEnDisco();
    await esperarError(subir(cobranzas, 'cliente', cliente, new Uint8Array()), 'vacío');
    await esperarError(subir(cobranzas, 'cliente', cliente, new TextEncoder().encode('hola')), 'Solo se admiten');
    const grande = new Uint8Array(MAX_BYTES_ADJUNTO + 1);
    grande.set(pdf());
    await esperarError(subir(cobranzas, 'cliente', cliente, grande), 'no puede pasar de 5 MB');
    await esperarError(subir(cobranzas, 'cliente', cliente, pdf('comprobante de pago')), 'ya está adjunto');
    // Registro que no existe: la base rechaza y el archivo recién escrito se retira.
    await esperarError(subir(cobranzas, 'cliente', '00000000-0000-0000-0000-000000000000', png()), 'no existe');
    expect(await archivosEnDisco()).toBe(antes);
  });

  it('el mismo archivo puede ir en otro registro, y de nuevo si el anterior se anula', async () => {
    const bytes = png(7);
    const a = await subir(gerente, 'proveedor', proveedor, bytes, 'logo.png');
    await subir(gerente, 'cliente', cliente, bytes, 'logo.png');
    await esperarError(subir(gerente, 'proveedor', proveedor, bytes), 'ya está adjunto');
    await db.transaction((tx) => anularAdjunto(tx, a, gerente, 'Archivo equivocado'));
    await subir(gerente, 'proveedor', proveedor, bytes, 'logo.png');
  });

  it('permisos por rol y por fila al ver y agregar', async () => {
    // Cliente: Ventas ve y agrega solo en su cartera; Compras y Almacén no lo ven.
    expect(await puedeVerAdjuntos(db, u(vendedorA, 'ventas'), 'cliente', cliente)).toBe(true);
    expect(await puedeVerAdjuntos(db, u(vendedorB, 'ventas'), 'cliente', cliente)).toBe(false);
    expect(await puedeAgregarAdjuntos(db, u(vendedorA, 'ventas'), 'cliente', cliente)).toBe(true);
    expect(await puedeAgregarAdjuntos(db, u(vendedorB, 'ventas'), 'cliente', clienteDeB)).toBe(true);
    expect(await puedeAgregarAdjuntos(db, u(vendedorB, 'ventas'), 'cliente', cliente)).toBe(false);
    expect(await puedeVerAdjuntos(db, u(compras, 'compras'), 'cliente', cliente)).toBe(false);
    expect(await puedeVerAdjuntos(db, u(almacenista, 'almacen'), 'cliente', cliente)).toBe(false);
    expect(await puedeVerAdjuntos(db, u(cobranzas, 'cobranzas'), 'cliente', cliente)).toBe(true);
    // El Auditor solo lee.
    expect(await puedeVerAdjuntos(db, u(auditor, 'auditor'), 'cliente', cliente)).toBe(true);
    expect(await puedeAgregarAdjuntos(db, u(auditor, 'auditor'), 'cliente', cliente)).toBe(false);
    // Proveedor y producto.
    expect(await puedeAgregarAdjuntos(db, u(compras, 'compras'), 'proveedor', proveedor)).toBe(true);
    expect(await puedeVerAdjuntos(db, u(cobranzas, 'cobranzas'), 'proveedor', proveedor)).toBe(false);
    expect(await puedeAgregarAdjuntos(db, u(almacenista, 'almacen'), 'producto', producto)).toBe(true);
    expect(await puedeAgregarAdjuntos(db, u(cobranzas, 'cobranzas'), 'producto', producto)).toBe(false);
  });

  it('un adjunto solo se lee si el usuario puede ver su registro; sin permiso es igual que no existir', async () => {
    const id = await subir(gerente, 'cliente', cliente, jpg, 'foto.jpg');
    expect((await leerAdjunto(db, almacen, u(vendedorA, 'ventas'), id))?.tipo_contenido).toBe('image/jpeg');
    expect(await leerAdjunto(db, almacen, u(vendedorB, 'ventas'), id)).toBeNull();
    expect(await leerAdjunto(db, almacen, u(compras, 'compras'), id)).toBeNull();
    expect(await leerAdjunto(db, almacen, u(gerente, 'gerencia'), '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('un archivo alterado en disco no se entrega: la huella no coincide', async () => {
    const id = await subir(gerente, 'producto', producto, webp, 'foto.webp');
    await writeFile(path.join(dir, id.slice(0, 2), id), Buffer.from('contenido cambiado'));
    await expect(leerAdjunto(db, almacen, u(gerente, 'gerencia'), id)).rejects.toThrow('no coincide con su huella');
  });

  it('anular exige motivo; solo quien lo subió o Gerencia; el anulado solo lo ven Gerencia y Auditor', async () => {
    const id = await subir(cobranzas, 'cliente', cliente, pdf('otro comprobante'), 'otro.pdf');
    await esperarError(db.transaction((tx) => anularAdjunto(tx, id, cobranzas, ' ')), 'motivo de la anulación');
    await esperarError(db.transaction((tx) => anularAdjunto(tx, id, facturacion, 'No es mío')), 'Solo quien subió');
    await db.transaction((tx) => anularAdjunto(tx, id, cobranzas, 'Comprobante duplicado'));
    await esperarError(db.transaction((tx) => anularAdjunto(tx, id, gerente, 'Otra vez')), 'ya fue anulado');

    expect(await leerAdjunto(db, almacen, u(cobranzas, 'cobranzas'), id)).toBeNull();
    expect(await leerAdjunto(db, almacen, u(gerente, 'gerencia'), id)).not.toBeNull();
    expect(await leerAdjunto(db, almacen, u(auditor, 'auditor'), id)).not.toBeNull();
    // El archivo se conserva aunque se anule (retención de soportes).
    expect(await archivosEnDisco()).toBeGreaterThan(0);

    const vigentes = await listarAdjuntos(db, 'cliente', cliente, false);
    expect(vigentes.map((a) => a.id)).not.toContain(id);
    expect((await listarAdjuntos(db, 'cliente', cliente, true)).find((a) => a.id === id)?.motivo_anulacion).toBe('Comprobante duplicado');
  });

  it('la base no permite editar ni borrar adjuntos, ni reescribir una anulación (R-Y)', async () => {
    const id = await subir(gerente, 'proveedor', proveedor, pdf('contrato'), 'contrato.pdf');
    await esperarError(db.query(`update adjunto set nombre = 'otro.pdf' where id = $1`, [id]), 'no se edita');
    await esperarError(db.query(`update adjunto set hash_sha256 = repeat('a', 64) where id = $1`, [id]), 'no se edita');
    await esperarError(db.query(`update adjunto set entidad_id = $2 where id = $1`, [id, cliente]), 'no se edita');
    await esperarError(db.query('delete from adjunto where id = $1', [id]), 'no se borra');
    await db.transaction((tx) => anularAdjunto(tx, id, gerente, 'Reemplazado'));
    await esperarError(db.query(`update adjunto set motivo_anulacion = 'cambio' where id = $1`, [id]), 'anulado no se modifica');
    await esperarError(db.query(
      `insert into adjunto (entidad_tipo, entidad_id, nombre, tipo_contenido, tamano_bytes, hash_sha256, subido_por, anulado_por, anulado_at, motivo_anulacion)
       values ('cliente', $1, 'x.pdf', 'application/pdf', 1, repeat('b', 64), $2, $2, now(), 'nace anulado')`, [cliente, gerente]), 'nace vigente');
  });

  it('cada adjunto y cada anulación quedan en la auditoría', async () => {
    const { rows } = await db.query<{ accion: string; n: number }>(
      `select accion, count(*)::int as n from audit_log where entidad = 'adjunto' group by accion`);
    const n = Object.fromEntries(rows.map((r) => [r.accion, r.n]));
    expect(n.INSERT).toBeGreaterThan(3);
    expect(n.UPDATE).toBeGreaterThan(1);
  });
});
