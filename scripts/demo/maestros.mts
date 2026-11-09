/**
 * Maestros de la empresa ficticia: catálogo de repuestos (códigos comunes en varias marcas), precios, vendedores,
 * clientes con su condición de pago y proveedores. Todo pasa por las funciones y aprobaciones del ERP.
 */
import { resolverAprobacion } from '../../src/lib/flujo/objetos';
import { crearCliente } from '../../src/lib/maestros/clientes';
import { crearCatalogo, crearProducto, fijarPrecio, resolverProductoBase } from '../../src/lib/maestros/productos';
import { crearProveedor } from '../../src/lib/maestros/proveedores';
import { crearVendedor } from '../../src/lib/maestros/vendedores';
import type { Usuario } from '../../src/lib/ventas/pedidos';
import { como, type Cliente, type Ctx, type Producto, type Proveedor } from './base.mts';
import { rifDe } from './fundaciones.mts';

// Marcas ficticias (cada una la surte un proveedor) y su factor de costo.
const MARCAS = [
  { codigo: 'ANDINA', nombre: 'Andina', factor: 1.25, proveedor: 'Importadora Cordillera, C.A.', condicion: 'CR30', plazo: 30, pais: 'VE', tipo: 'mercancia_local' as const },
  { codigo: 'TRIBOX', nombre: 'Tribox', factor: 1.0, proveedor: 'Tribox Auto Parts Co. (DEMO)', condicion: 'CR45', plazo: 45, pais: 'CN', tipo: 'importacion' as const },
  { codigo: 'KORVEN', nombre: 'Korven', factor: 0.8, proveedor: 'Distribuciones Korven, C.A.', condicion: 'CR15', plazo: 15, pais: 'VE', tipo: 'mercancia_local' as const },
];

const GRUPOS = [
  ['FRENOS', 'Frenos'], ['SUSPENSION', 'Suspensión y dirección'], ['MOTOR', 'Motor'],
  ['ELECTRICO', 'Sistema eléctrico'], ['FILTROS', 'Filtros'], ['ACCESORIOS', 'Accesorios'],
] as const;

// [código común, descripción, grupo, costo base US$, alícuota]. Las alícuotas son datos de prueba: no reflejan la ley.
const BASES: readonly (readonly [string, string, string, number, 'GENERAL' | 'EXENTO'])[] = [
  ['PF-DEL', 'Pastillas de freno delanteras', 'FRENOS', 9.5, 'GENERAL'],
  ['PF-TRA', 'Pastillas de freno traseras', 'FRENOS', 8.0, 'GENERAL'],
  ['DI-DEL', 'Disco de freno delantero', 'FRENOS', 21.0, 'GENERAL'],
  ['AM-DEL', 'Amortiguador delantero', 'SUSPENSION', 26.0, 'GENERAL'],
  ['AM-TRA', 'Amortiguador trasero', 'SUSPENSION', 22.0, 'GENERAL'],
  ['RO-TER', 'Rótula de dirección', 'SUSPENSION', 7.5, 'GENERAL'],
  ['BU-TIJ', 'Buje de tijera', 'SUSPENSION', 3.2, 'GENERAL'],
  ['BB-AGU', 'Bomba de agua', 'MOTOR', 18.0, 'GENERAL'],
  ['CD-DIS', 'Correa de distribución', 'MOTOR', 12.5, 'GENERAL'],
  ['BU-IRI', 'Bujía de iridio (juego de 4)', 'ELECTRICO', 14.0, 'GENERAL'],
  ['BA-AUT', 'Batería 12V 45Ah', 'ELECTRICO', 48.0, 'GENERAL'],
  ['FI-ACE', 'Filtro de aceite', 'FILTROS', 2.8, 'GENERAL'],
  ['FI-AIR', 'Filtro de aire', 'FILTROS', 4.5, 'GENERAL'],
  ['FI-COM', 'Filtro de combustible', 'FILTROS', 5.2, 'GENERAL'],
  ['AC-LIM', 'Limpiaparabrisas (par)', 'ACCESORIOS', 6.0, 'EXENTO'],
  ['AC-ALF', 'Alfombras de goma (juego)', 'ACCESORIOS', 11.0, 'EXENTO'],
];

const NOMBRES_CLIENTE = ['Repuestos', 'Autopartes', 'Frenos y Suspensión', 'Distribuidora', 'Auto Servicio', 'Lubricantes y Filtros', 'Taller', 'Importadora'];
const APELLIDOS_CLIENTE = [
  'Lara', 'del Centro', 'Occidente', 'Los Andes', 'Capital', 'Oriente', 'Llanos', 'Costa Azul', 'La Ceiba', 'El Trébol', 'Santa Rosa',
  'San Jacinto', 'Barquisimeto', 'Cabudare', 'Carora', 'Valencia', 'Maracay', 'Mérida', 'Táchira', 'Zulia', 'Guayana', 'Falcón', 'Yaracuy', 'Portuguesa',
];
const ZONAS = ['Lara', 'Centro', 'Occidente', 'Andes', 'Capital'] as const;

const CLIENTES = 24;

export async function sembrarMaestros(
  ctx: Ctx, desde: string,
): Promise<Pick<Ctx, 'clientes' | 'proveedores' | 'productos' | 'proveedoresServicio' | 'productoIntereses'>> {
  const { db, azar, u } = ctx;
  const condiciones = new Map((await db.query<{ codigo: string; id: string }>('select codigo, id from condicion_pago')).rows.map((r) => [r.codigo, r.id]));
  const alicuotas = new Map((await db.query<{ codigo: string; id: string }>('select codigo, id from alicuota_iva')).rows.map((r) => [r.codigo, r.id]));
  const condicion = (c: string) => condiciones.get(c)!;

  // --- Catálogo ---
  const grupos = new Map<string, string>();
  for (const [codigo, nombre] of GRUPOS) grupos.set(codigo, await db.transaction((tx) => crearCatalogo(tx, 'grupo_producto', codigo, nombre)));
  const marcas = new Map<string, string>();
  for (const m of MARCAS) marcas.set(m.codigo, await db.transaction((tx) => crearCatalogo(tx, 'marca', m.codigo, m.nombre)));

  const productos: Producto[] = [];
  for (const [base, descripcion, grupo, costoBase, iva] of BASES) {
    const comun = await db.transaction((tx) => resolverProductoBase(tx, base, { descripcion }));
    for (const m of MARCAS) {
      const codigo = `${base}-${m.codigo}`;
      const costoUsd = Math.round(costoBase * m.factor * 100) / 100;
      const id = await db.transaction((tx) => crearProducto(tx, u.almacen.id, codigo, {
        descripcion: `${descripcion} ${m.nombre}`, productoBaseId: comun.id, grupoId: grupos.get(grupo), marcaId: marcas.get(m.codigo),
        unidad: 'und', alicuotaIvaId: alicuotas.get(iva)!, inventariable: true, paisOrigen: m.pais,
      }));
      const precio = (factor: number) => (Math.round(costoUsd * factor * 100) / 100).toFixed(2);
      await como(ctx, u.gerencia, async (tx) => {
        await fijarPrecio(tx, id, 'A', precio(1.6), desde);
        await fijarPrecio(tx, id, 'B', precio(1.45), desde);
        await fijarPrecio(tx, id, 'D', precio(1.3), desde);
      });
      productos.push({ id, codigo, marcaId: marcas.get(m.codigo)!, costoUsd, precioBUsd: Number(precio(1.45)) });
    }
  }

  // --- Vendedores (uno por usuario de ventas) ---
  const vendedores: { id: string; usuario: Usuario }[] = [];
  for (const [clave, nombre] of [['ventas1', 'Víctor Vendedor'], ['ventas2', 'Valeria Vendedora'], ['ventas3', 'Vicente Vendedor']] as const) {
    const v = await como(ctx, u.gerencia, (tx) => crearVendedor(tx, u.gerencia.id, { nombre, tipo: 'interno', usuarioId: u[clave].id }));
    vendedores.push({ id: v.id, usuario: u[clave] });
  }

  // --- Clientes: los registra Facturación y los aprueba Gerencia con su condición, límite y nivel de precio ---
  const clientes: Cliente[] = [];
  const usados = new Set<string>();
  for (let i = 0; i < CLIENTES; i++) {
    let nombre = '';
    do nombre = `${azar.elegir(NOMBRES_CLIENTE)} ${azar.elegir(APELLIDOS_CLIENTE)}, C.A.`; while (usados.has(nombre));
    usados.add(nombre);
    const v = vendedores[i % vendedores.length];
    const cond = azar.ponderado([['CONTADO', 25], ['CR15', 25], ['CR30', 35], ['CR45', 15]] as const);
    const c = await como(ctx, u.facturacion, (tx) => crearCliente(tx, u.facturacion.id, {
      rif: rifDe('J', 30_000_100 + i * 7),
      tercero: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false },
      comercial: { vendedorId: v.id, zona: azar.elegir(ZONAS), sucursalId: ctx.sucursalId },
    }));
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'cliente', c.id, u.gerencia.id, 'aprobada', {
      datos: {
        condicionPagoId: condicion(cond), limiteCreditoUsd: cond === 'CONTADO' ? '0' : String(azar.entero(8, 60) * 100),
        nivelPrecio: azar.ponderado([['A', 30], ['B', 50], ['D', 20]] as const), descuentoPct: azar.ponderado([['0', 60], ['2', 25], ['5', 15]] as const),
      },
    }));
    clientes.push({
      id: c.id, codigo: c.codigo, nombre, vendedorUsuario: v.usuario,
      condicionDias: { CONTADO: 0, CR15: 15, CR30: 30, CR45: 45 }[cond],
      // Cuántos días después del vencimiento paga: la mayoría puntual, algunos morosos.
      retrasoDias: cond === 'CONTADO' ? 0 : azar.ponderado([[0, 40], [3, 25], [10, 20], [25, 10], [50, 5]] as const),
      pagaEnDivisas: azar() < 0.25,
    });
  }

  // --- Proveedores: uno por marca; los registra Compras y los aprueba Gerencia con su condición de pago ---
  const proveedores: Proveedor[] = [];
  for (const [i, m] of MARCAS.entries()) {
    const p = await como(ctx, u.compras, (tx) => crearProveedor(tx, u.compras.id, {
      rif: rifDe('J', 29_000_500 + i * 11),
      sensibles: {
        razonSocial: m.proveedor, domiciliado: m.pais === 'VE', contribuyenteEspecial: false, agenteRetencionIva: false,
        tipo: m.tipo, pais: m.pais, conceptoIslrId: null,
      },
      contacto: { nombreComercial: m.nombre },
    }));
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'proveedor', p.id, u.gerencia.id, 'aprobada', { datos: { condicionPagoId: condicion(m.condicion) } }));
    proveedores.push({ id: p.id, nombre: m.proveedor, marcaId: marcas.get(m.codigo)!, plazoDias: m.plazo });
  }

  // --- Proveedores de servicios (facturan gastos: alquiler y electricidad) ---
  // La empresa ficticia es agente de retención: Contabilidad carga los conceptos y tarifas de ISLR (valores de demostración, no la
  // normativa) y el Jefe de contabilidad los valida. Sin tarifa vigente el ERP no contabiliza la factura de un proveedor con concepto.
  const conceptos = new Map<string, string>();
  for (const [codigo, descripcion, pct] of [['SERV-PJ', 'Servicios prestados por personas jurídicas', 2], ['ALQ-PJ', 'Alquiler de inmuebles a personas jurídicas', 5]] as const) {
    const id = (await como(ctx, u.contabilidad, (tx) => tx.query<{ id: string }>('insert into concepto_islr (codigo, descripcion) values ($1, $2) returning id', [codigo, descripcion]))).rows[0].id;
    await como(ctx, u.contabilidad, (tx) => tx.query(
      `insert into concepto_islr_tarifa (concepto_id, tipo_persona, domiciliado, porcentaje, base_minima_ut, sustraendo_ut, vigente_desde, fuente_normativa)
       values ($1, 'J', true, $2, 0, 0, $3::date, 'Valor de demostración (no es la normativa)')`, [id, pct, desde]));
    conceptos.set(codigo, id);
  }
  await como(ctx, u.jefe_contabilidad, (tx) => tx.query('update concepto_islr_tarifa set validado_por_contador = true where not validado_por_contador'));

  const proveedoresServicio: Proveedor[] = [];
  for (const [i, nombre] of ['Inmobiliaria Zona Industrial, C.A.', 'Corporación Eléctrica Regional, C.A.'].entries()) {
    const p = await como(ctx, u.compras, (tx) => crearProveedor(tx, u.compras.id, {
      rif: rifDe('J', 28_000_900 + i * 13),
      sensibles: { razonSocial: nombre, domiciliado: true, contribuyenteEspecial: false, agenteRetencionIva: false, tipo: 'servicios', pais: 'VE', conceptoIslrId: conceptos.get(i === 0 ? 'ALQ-PJ' : 'SERV-PJ')! },
      contacto: {},
    }));
    await como(ctx, u.gerencia, (tx) => resolverAprobacion(tx, 'proveedor', p.id, u.gerencia.id, 'aprobada', { datos: { condicionPagoId: condicion('CR15') } }));
    proveedoresServicio.push({ id: p.id, nombre, marcaId: '', plazoDias: 15 });
  }

  // --- Producto no inventariable para cobrar intereses por mora (nota de débito) ---
  const baseInt = await db.transaction((tx) => resolverProductoBase(tx, 'SERV-INT', { descripcion: 'Intereses por mora' }));
  const marcaServicios = await db.transaction((tx) => crearCatalogo(tx, 'marca', 'SERVICIOS', 'Servicios'));
  const productoIntereses = await db.transaction((tx) => crearProducto(tx, u.almacen.id, 'SERV-INT-MORA', {
    descripcion: 'Intereses por mora', productoBaseId: baseInt.id, marcaId: marcaServicios, unidad: 'und', alicuotaIvaId: alicuotas.get('EXENTO')!, inventariable: false,
  }));

  return { clientes, proveedores, productos, proveedoresServicio, productoIntereses };
}
