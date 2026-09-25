import type { Rol } from '@/lib/auth/constantes';
import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from './terceros';

/**
 * Bancos (§5.4): catálogo de instituciones financieras. Los registra Tesorería o Gerencia.
 * Un banco no se borra: se inactiva. Las cuentas bancarias llegan en la Fase 3.
 */

export const ROLES_ADMIN_BANCOS: Rol[] = ['tesoreria', 'gerencia'];
export const ROLES_VEN_BANCOS: Rol[] = [
  'tesoreria', 'gerencia', 'compras', 'contabilidad', 'jefe_contabilidad', 'auditor',
];

export interface DatosBanco {
  nombre: string;
  pais: string;
}

function normalizar(d: DatosBanco): DatosBanco {
  const nombre = d.nombre.trim().replace(/\s+/g, ' ');
  const pais = d.pais.trim().toUpperCase();
  const errores: string[] = [];
  if (nombre.length < 2) errores.push('Indique el nombre del banco.');
  if (!/^[A-Z]{2}$/.test(pais)) errores.push('El país se indica con su código de 2 letras (p. ej. VE, US, PA).');
  if (errores.length) throw new ErrorMaestro(errores.join('\n'));
  return { nombre, pais };
}

async function nombreLibre(tx: Db, nombre: string, salvoId?: string): Promise<void> {
  const { rows } = await tx.query(
    'select 1 from banco where lower(trim(nombre)) = lower($1) and ($2::uuid is null or id <> $2)', [nombre, salvoId ?? null]);
  if (rows.length) throw new ErrorMaestro(`Ya existe un banco llamado ${nombre}.`);
}

export async function crearBanco(tx: Db, codigo: string, d: DatosBanco): Promise<string> {
  const c = codigo.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(c)) throw new ErrorMaestro('El código admite de 2 a 10 letras o números (p. ej. 0134 o CHASE).');
  const datos = normalizar(d);
  const { rows: previo } = await tx.query('select 1 from banco where upper(codigo) = $1', [c]);
  if (previo.length) throw new ErrorMaestro(`Ya existe el banco con código ${c}.`);
  await nombreLibre(tx, datos.nombre);
  const { rows } = await tx.query<{ id: string }>(
    'insert into banco (codigo, nombre, pais) values ($1, $2, $3) returning id', [c, datos.nombre, datos.pais]);
  return rows[0].id;
}

export async function actualizarBanco(tx: Db, id: string, d: DatosBanco & { activo: boolean }): Promise<void> {
  const datos = normalizar(d);
  await nombreLibre(tx, datos.nombre, id);
  const { rows } = await tx.query(
    'update banco set nombre = $2, pais = $3, activo = $4 where id = $1 returning id', [id, datos.nombre, datos.pais, d.activo]);
  if (!rows[0]) throw new ErrorMaestro('El banco no existe.');
}
