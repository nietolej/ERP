/**
 * Día 0 de la empresa ficticia: empresa (marcada como demostración), periodos, sucursal, almacén, usuarios por rol y
 * cuentas bancarias. Todo por las mismas funciones del ERP, salvo los insertos de configuración que la pantalla de
 * Configuración también hace directamente (empresa, sucursal, usuarios).
 */
import { hashClave } from '../../src/lib/auth/clave';
import type { Db } from '../../src/lib/db/tipos';
import { asignarUsuarios, crearAlmacen } from '../../src/lib/maestros/almacenes';
import { crearCuentaBancaria, listarInstrumentos } from '../../src/lib/maestros/cuentas-bancarias';
import { digitoVerificador } from '../../src/lib/maestros/rif';
import type { Usuario } from '../../src/lib/ventas/pedidos';
import { como, type Ctx } from './base.mts';

/** Clave de TODOS los usuarios de la empresa ficticia. Solo vale en la base de demostración (se marca con empresa.es_demo). */
export const CLAVE_DEMO = 'Demo-ERP-2026';

export const rifDe = (letra: string, numero: number): string => {
  const n = String(numero).padStart(8, '0');
  return `${letra}-${n}-${digitoVerificador(letra, n)}`;
};

const RAZON_SOCIAL = 'Distribuidora Andina de Repuestos, C.A. (DEMO)';

export async function sembrarFundaciones(
  db: Db, anios: number[],
): Promise<Pick<Ctx, 'u' | 'sucursalId' | 'almacenId' | 'cuentaVesId' | 'cuentaUsdId' | 'cuentaCajaId' | 'instrumentos'>> {
  await db.query(
    `insert into empresa (rif, razon_social, domicilio_fiscal, es_demo, contribuyente_especial, agente_retencion_iva, agente_retencion_islr)
     values ($1, $2, $3, true, true, true, true)`,
    [rifDe('J', 40_000_001), RAZON_SOCIAL, 'Zona Industrial, Barquisimeto, estado Lara (dirección ficticia)']);
  for (const a of anios) await db.query('select fn_crear_periodos($1)', [a]);
  const sucursalId = (await db.query<{ id: string }>(`insert into sucursal (codigo, nombre) values ('PRINC', 'Sede principal') returning id`)).rows[0].id;

  // Un usuario por rol (y tres vendedores), todos con la clave de demostración y sin obligación de cambiarla.
  const hash = await hashClave(CLAVE_DEMO);
  const roles = (await db.query<{ codigo: string }>('select codigo from rol order by codigo')).rows.map((r) => r.codigo);
  const u: Record<string, Usuario> = {};
  const crear = async (clave: string, rol: string, nombre: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into usuario (email, nombre, password_hash, debe_cambiar_password) values ($1, $2, $3, false) returning id`,
      [`${clave}@demo.test`, nombre, hash]);
    await db.query('insert into usuario_rol (usuario_id, rol) values ($1, $2)', [rows[0].id, rol]);
    u[clave] = { id: rows[0].id, roles: [rol] };
  };
  const nombres: Record<string, string> = {
    administrador: 'Ana Administradora', gerencia: 'Gabriel Gerente', supervisor_ventas: 'Sofía Supervisora', facturacion: 'Fernando Facturación',
    cobranzas: 'Carla Cobranzas', compras: 'Camilo Compras', almacen: 'Alberto Almacén', tesoreria: 'Teresa Tesorería',
    contabilidad: 'Constanza Contadora', jefe_contabilidad: 'Julián Jefe de Contabilidad', auditor: 'Aurora Auditora',
  };
  for (const rol of roles) {
    if (rol === 'ventas') continue;
    await crear(rol, rol, nombres[rol] ?? `Usuario ${rol}`);
  }
  await crear('ventas1', 'ventas', 'Víctor Vendedor');
  await crear('ventas2', 'ventas', 'Valeria Vendedora');
  await crear('ventas3', 'ventas', 'Vicente Vendedor');

  const almacenId = await db.transaction((tx) => crearAlmacen(tx, 'PRINC', {
    nombre: 'Almacén principal', sucursalId, esComercial: true, permiteVenta: true, usaPicking: false,
  }));
  await db.transaction((tx) => asignarUsuarios(tx, almacenId, [u.almacen.id]));

  // Bancos y cuentas: una en bolívares y una en dólares (la tesorería de la empresa).
  const bancoId = (await db.query<{ id: string }>(`insert into banco (codigo, nombre) values ('BDEMO', 'Banco Demo') returning id`)).rows[0].id;
  const base = { db } as Ctx;
  const cuentaVes = await como(base, u.tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Demo Bs', tipo: 'banco', moneda: 'VES', bancoId, numero: '0000-0000-00-0000000001' }));
  const cuentaUsd = await como(base, u.tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Banco Demo US$', tipo: 'banco', moneda: 'USD', bancoId, numero: '0000-0000-00-0000000002' }));
  const cuentaCaja = await como(base, u.tesoreria, (tx) => crearCuentaBancaria(tx, { nombre: 'Caja chica Bs', tipo: 'caja', moneda: 'VES' }));
  const instrumentos = await listarInstrumentos(db);
  const id = (codigo: string) => instrumentos.find((i) => i.codigo === codigo)!.id;

  return {
    u, sucursalId, almacenId, cuentaVesId: cuentaVes.id, cuentaUsdId: cuentaUsd.id, cuentaCajaId: cuentaCaja.id,
    instrumentos: { transferencia: id('TRANSFERENCIA'), zelle: id('ZELLE') },
  };
}
