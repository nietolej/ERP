/**
 * Interfaz única de acceso a la base de datos.
 *
 * Reglas:
 * - `numeric` y `bigint` llegan como string: el dinero nunca pasa por float (AGENTS.md §3).
 * - `date` llega como string 'YYYY-MM-DD': sin corrimientos de zona horaria.
 */
export interface Resultado<T> {
  rows: T[];
}

export interface Db {
  /** Una sentencia con parámetros ($1, $2…). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Resultado<T>>;
  /** Varias sentencias sin parámetros (migraciones). */
  exec(sql: string): Promise<void>;
  /**
   * Ejecuta `fn` en una transacción. Si `fn` lanza, se revierte todo.
   * Dentro de una transacción, `transaction` reutiliza la misma (no anida).
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
