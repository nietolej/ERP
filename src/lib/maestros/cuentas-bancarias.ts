import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro, vacioANull } from './terceros';

/**
 * Cuentas bancarias y cajas de la empresa, donde entran los cobros (§5.4, §6.3, migración 0028).
 * Cada una tiene su subcuenta contable propia, que se crea con ella bajo la cuenta de agrupación que corresponde.
 * Una cuenta no se borra: se inactiva. La conciliación bancaria (Fase 3) se apoya en estas cuentas.
 */

export const ROLES_GESTIONAN_CUENTAS = ['tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_CUENTAS = ['tesoreria', 'gerencia', 'cobranzas', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

export const TIPOS_CUENTA = ['banco', 'caja', 'custodia', 'exterior', 'digital'] as const;
export type TipoCuenta = (typeof TIPOS_CUENTA)[number];
export const NOMBRE_TIPO_CUENTA: Record<TipoCuenta, string> = {
  banco: 'Banco nacional', caja: 'Caja', custodia: 'Custodia', exterior: 'Cuenta en el exterior', digital: 'Activo digital',
};

export interface DatosCuenta {
  nombre: string;
  tipo: TipoCuenta;
  moneda: string;
  bancoId?: string;
  numero?: string;
}

/** Cuenta de agrupación bajo la que se crea la subcuenta de cada cuenta bancaria (plan de cuentas, §12.1). */
function cuentaPadre(tipo: TipoCuenta, moneda: string): string {
  if (tipo === 'caja') return '1.1.01';
  if (tipo === 'digital') return '1.1.04';
  if (tipo === 'banco' && moneda === 'VES') return '1.1.02';
  return '1.1.03';
}

export async function crearCuentaBancaria(tx: Db, d: DatosCuenta): Promise<{ id: string; codigo: string; cuentaContable: string }> {
  if (d.nombre.trim().length < 3) throw new ErrorMaestro('Indique el nombre de la cuenta.');
  if (!TIPOS_CUENTA.includes(d.tipo)) throw new ErrorMaestro('Seleccione el tipo de cuenta.');
  if (!/^[A-Z]{3,4}$/.test(d.moneda)) throw new ErrorMaestro('Seleccione la moneda.');
  if (d.tipo === 'banco' && !d.bancoId) throw new ErrorMaestro('Seleccione el banco.');
  if (d.tipo === 'custodia' && d.moneda === 'VES') throw new ErrorMaestro('Una cuenta de custodia es en divisas.');
  const numero = vacioANull(d.numero);
  if (numero && d.bancoId) {
    const { rows } = await tx.query('select 1 from cuenta_bancaria where banco_id = $1 and numero = $2', [d.bancoId, numero]);
    if (rows.length) throw new ErrorMaestro('Ya existe una cuenta con ese número en ese banco.');
  }
  const { rows: m } = await tx.query('select 1 from moneda where codigo = $1', [d.moneda]);
  if (!m.length) throw new ErrorMaestro('La moneda no existe.');

  // Subcuenta contable: el siguiente código libre bajo la cuenta de agrupación (se bloquea el padre para que dos altas no choquen).
  const { rows: padre } = await tx.query<{ id: string; codigo: string }>(
    'select id, codigo from cuenta_contable where codigo = $1 and not imputable for update', [cuentaPadre(d.tipo, d.moneda)]);
  if (!padre[0]) throw new ErrorMaestro(`Falta la cuenta ${cuentaPadre(d.tipo, d.moneda)} en el plan de cuentas.`);
  const { rows: sig } = await tx.query<{ n: number }>(
    `select coalesce(max(split_part(codigo, '.', array_length(string_to_array($1, '.'), 1) + 1)::int), 0) + 1 as n
       from cuenta_contable where padre_id = $2`, [padre[0].codigo, padre[0].id]);
  const codigoContable = `${padre[0].codigo}.${String(sig[0].n).padStart(2, '0')}`;
  const { rows: cc } = await tx.query<{ id: string }>(
    `insert into cuenta_contable (codigo, nombre, tipo, naturaleza, padre_id, imputable, moneda, controlada_por)
     values ($1, $2, 'activo', 'D', $3, true, $4, 'banco') returning id`,
    [codigoContable, d.nombre.trim(), padre[0].id, d.moneda]);

  const { rows } = await tx.query<{ id: string; codigo: string }>(
    `insert into cuenta_bancaria (nombre, banco_id, numero, tipo, moneda, cuenta_contable_id)
     values ($1, $2, $3, $4, $5, $6) returning id, codigo`,
    [d.nombre.trim(), d.bancoId || null, numero, d.tipo, d.moneda, cc[0].id]);
  return { id: rows[0].id, codigo: rows[0].codigo, cuentaContable: codigoContable };
}

export async function actualizarCuentaBancaria(tx: Db, id: string, d: { nombre: string; activa: boolean }): Promise<void> {
  if (d.nombre.trim().length < 3) throw new ErrorMaestro('Indique el nombre de la cuenta.');
  const { rows } = await tx.query<{ cuenta_contable_id: string }>(
    'update cuenta_bancaria set nombre = $2, activa = $3 where id = $1 returning cuenta_contable_id', [id, d.nombre.trim(), d.activa]);
  if (!rows[0]) throw new ErrorMaestro('La cuenta no existe.');
  await tx.query('update cuenta_contable set nombre = $2, activa = $3 where id = $1', [rows[0].cuenta_contable_id, d.nombre.trim(), d.activa]);
}

export interface FilaCuenta {
  id: string; codigo: string; nombre: string; tipo: TipoCuenta; moneda: string; banco: string | null; numero: string | null;
  cuenta_contable: string; activa: boolean; saldo_ves: string; saldo_usd: string;
}

/** Cuentas con su saldo contable (lo que dice el mayor, en bolívares y en USD). */
export async function buscarCuentasBancarias(db: Db, opciones: { soloActivas?: boolean } = {}): Promise<FilaCuenta[]> {
  const { rows } = await db.query<FilaCuenta>(
    `select c.id, c.codigo, c.nombre, c.tipo, c.moneda, b.nombre as banco, c.numero, cc.codigo as cuenta_contable, c.activa,
            coalesce(s.ves, 0)::text as saldo_ves, coalesce(s.usd, 0)::text as saldo_usd
       from cuenta_bancaria c
       join cuenta_contable cc on cc.id = c.cuenta_contable_id
       left join banco b on b.id = c.banco_id
       left join lateral (select sum(l.debe_ves - l.haber_ves) as ves, sum(l.debe_usd - l.haber_usd) as usd
                            from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                           where l.cuenta_id = c.cuenta_contable_id) s on true
      where (not $1 or c.activa)
      order by c.activa desc, c.codigo`, [opciones.soloActivas ?? false]);
  return rows;
}

export async function listarInstrumentos(db: Db): Promise<{ id: string; codigo: string; nombre: string; genera_igtf: boolean }[]> {
  const { rows } = await db.query<{ id: string; codigo: string; nombre: string; genera_igtf: boolean }>(
    'select id, codigo, nombre, genera_igtf from instrumento_pago where activo order by nombre');
  return rows;
}
