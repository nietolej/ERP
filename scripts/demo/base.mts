/**
 * Piezas comunes de la siembra de la empresa ficticia (reloj simulado, azar con semilla y contexto compartido).
 * Solo se usa desde scripts/sembrar-demo.mts: no forma parte de la aplicación.
 */
import type { Db } from '../../src/lib/db/tipos';
import type { AlmacenArchivos } from '../../src/lib/adjuntos/almacen';
import type { Usuario } from '../../src/lib/ventas/pedidos';

// ---------------------------------------------------------------------------------------------------------------------
// Reloj simulado. PGlite corre en este mismo proceso y toma la hora de Date.now(), así que adelantarlo mueve el now() de
// la base: cada documento queda con la fecha del día simulado y la base aplica sus reglas (periodos, tasa, numeración)
// exactamente igual que en el uso real.
// ---------------------------------------------------------------------------------------------------------------------
const ahoraReal = Date.now.bind(Date);
let desfase = 0;
Date.now = () => ahoraReal() + desfase;

/** Lleva el reloj a `fecha` (AAAA-MM-DD) a la `hora` de Caracas (UTC-4). */
export function fijarReloj(fecha: string, hora = 9): void {
  desfase = Date.parse(`${fecha}T${String(hora + 4).padStart(2, '0')}:00:00Z`) - ahoraReal();
}

export function restaurarReloj(): void {
  desfase = 0;
}

const DIA_MS = 86_400_000;

export const sumarDias = (fecha: string, n: number): string => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);

/** 0 = domingo … 6 = sábado. */
export const diaSemana = (fecha: string): number => new Date(`${fecha}T12:00:00Z`).getUTCDay();

export function* diasEntre(desde: string, hasta: string): Generator<string> {
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) yield f;
}

// ---------------------------------------------------------------------------------------------------------------------
// Azar con semilla: la misma semilla da siempre la misma empresa, los mismos documentos y las mismas cifras.
// ---------------------------------------------------------------------------------------------------------------------
export interface Azar {
  /** Número en [0, 1). */
  (): number;
  entero(min: number, max: number): number;
  elegir<T>(opciones: readonly T[]): T;
  /** Elige según pesos relativos. */
  ponderado<T>(opciones: readonly (readonly [T, number])[]): T;
  barajar<T>(lista: readonly T[]): T[];
}

export function crearAzar(semilla: number): Azar {
  let s = semilla >>> 0;
  const siguiente = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const azar = siguiente as Azar;
  azar.entero = (min, max) => min + Math.floor(siguiente() * (max - min + 1));
  azar.elegir = (opciones) => opciones[Math.floor(siguiente() * opciones.length)];
  azar.ponderado = (opciones) => {
    const total = opciones.reduce((a, [, p]) => a + p, 0);
    let x = siguiente() * total;
    for (const [valor, peso] of opciones) {
      x -= peso;
      if (x < 0) return valor;
    }
    return opciones[opciones.length - 1][0];
  };
  azar.barajar = (lista) => {
    const r = [...lista];
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(siguiente() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  };
  return azar;
}

// ---------------------------------------------------------------------------------------------------------------------
// Contexto de la siembra
// ---------------------------------------------------------------------------------------------------------------------
export interface Cliente {
  id: string; codigo: string; nombre: string; vendedorUsuario: Usuario; retrasoDias: number; pagaEnDivisas: boolean; condicionDias: number;
  /** Contribuyente especial agente de retención de IVA: entrega su comprobante al recibir cada factura (migración 0059). */
  agenteRetencion: boolean;
}
export interface Proveedor { id: string; nombre: string; marcaId: string; plazoDias: number }
export interface Producto { id: string; codigo: string; marcaId: string; costoUsd: number; precioBUsd: number }

/** Estado mutable de una siembra (en el contexto, no en variables de módulo: dos siembras en el mismo proceso no se pisan). */
export interface EstadoSiembra {
  secuencia: number;
  enCamino: Map<string, number>;
  fondoId: string | null;
  valesSinReponer: number;
  /** Activos fijos de apertura (el último se da de baja durante la simulación). */
  activoIds: string[];
  /** Kits que Almacén ensambla (se crean el día 0; entran a la venta cuando tienen existencia). */
  kits: { id: string; codigo: string; marcaId: string; costoUsd: number; precioBUsd: number; componentes: { productoId: string; cantidad: number }[]; enVenta: boolean }[];
  /** Azar propio del CRM (semilla derivada): sus flujos no alteran la secuencia de los demás. */
  azarCrm: Azar;
  /** Prospectos sembrados (para el RIF y el nombre de los siguientes). */
  prospectos: number;
  /** Comprobantes de retención que entregan los clientes agentes (para numerarlos). */
  comprobantesRecibidos: number;
}

export interface Ctx {
  db: Db;
  azar: Azar;
  /** Primer día de ventas. */
  desde: string;
  hasta: string;
  /** Simulación larga: estacionalidad, feriados, alzas de costo, mora y saltos cambiarios (ruido.mts). */
  ruido: boolean;
  /** Usuarios por clave (gerencia, ventas1…). */
  u: Record<string, Usuario>;
  sucursalId: string;
  almacenId: string;
  cuentaVesId: string;
  cuentaUsdId: string;
  /** Caja chica en bolívares (efectivo). */
  cuentaCajaId: string;
  /** Dónde se guardan los soportes (PDF) de gastos y vales. */
  archivos: AlmacenArchivos;
  instrumentos: { transferencia: string; zelle: string };
  clientes: Cliente[];
  proveedores: Proveedor[];
  productos: Producto[];
  /** Proveedores de servicios (alquiler, electricidad…): facturan gastos, no mercancía. */
  proveedoresServicio: Proveedor[];
  /** Producto no inventariable de los intereses por mora (notas de débito). */
  productoIntereses: string;
  /** Tareas para días futuros (recepciones, pagos, cobros): fecha → acciones. */
  agenda: Map<string, (() => Promise<void>)[]>;
  estado: EstadoSiembra;
  /** Contadores y avisos para el informe final. */
  resumen: Record<string, number>;
  avisos: Map<string, number>;
}

/** Ejecuta `fn` en una transacción identificando al usuario, como hace la aplicación. */
export function como<T>(ctx: Ctx, u: Usuario, fn: (tx: Db) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.query("select set_config('app.usuario_id', $1, true)", [u.id]);
    return fn(tx);
  });
}

export const contar = (ctx: Ctx, clave: string, n = 1): void => { ctx.resumen[clave] = (ctx.resumen[clave] ?? 0) + n; };

/** Un fallo esperado de negocio (sin existencia, límite de crédito…) se anota; los inesperados no pasan por aquí. */
export const avisar = (ctx: Ctx, mensaje: string): void => { ctx.avisos.set(mensaje, (ctx.avisos.get(mensaje) ?? 0) + 1); };

export function programar(ctx: Ctx, fecha: string, accion: () => Promise<void>): void {
  const l = ctx.agenda.get(fecha) ?? [];
  l.push(accion);
  ctx.agenda.set(fecha, l);
}

export const dinero = (n: number): string => n.toFixed(2);
