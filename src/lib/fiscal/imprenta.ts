import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/maestros/terceros';

/**
 * Número de control de la factura (§11.1). Lo asigna una imprenta digital autorizada por el SENIAT; el proveedor todavía no
 * está elegido (decisión 13), así que el ERP habla con una interfaz y, por ahora, con un SIMULADOR.
 *
 * El simulador sirve para desarrollar y probar el flujo de punta a punta. Sus números NO tienen validez fiscal y los documentos
 * emitidos con él se marcan como prueba. Con NODE_ENV=production no hay simulador: sin un proveedor real configurado, la
 * factura se emite en contingencia (sin número de control) hasta que exista.
 */

export interface SolicitudControl {
  serie: string;
  numero: string;
  fechaEmision: string;
  emisorRif: string;
  receptorRif: string;
  totalVes: string;
  ivaVes: string;
}

export interface ServicioNumeroControl {
  /** Nombre del proveedor, tal como se guarda en la factura. */
  readonly proveedor: string;
  /** Indica si sus números tienen validez fiscal. El simulador no. */
  readonly esReal: boolean;
  solicitar(db: Db, s: SolicitudControl): Promise<{ numeroControl: string }>;
  /** Avisa al proveedor que la factura se anuló. */
  anular(db: Db, numeroControl: string): Promise<void>;
}

export const PROVEEDOR_SIMULADO = 'SIMULADOR (sin validez fiscal)';

/** Números correlativos de prueba con el formato 00-00000001. Corre dentro de la transacción de la factura. */
export class ImprentaSimulada implements ServicioNumeroControl {
  readonly proveedor = PROVEEDOR_SIMULADO;
  readonly esReal = false;

  async solicitar(db: Db): Promise<{ numeroControl: string }> {
    const { rows } = await db.query<{ n: string }>(`select fn_siguiente_numero('control_simulado', 'A')::text as n`);
    return { numeroControl: `00-${rows[0].n.padStart(8, '0')}` };
  }

  async anular(): Promise<void> {
    // El simulador no tiene nada que anular.
  }
}

/**
 * Servicio configurado. IMPRENTA_PROVEEDOR=simulada (por defecto en desarrollo). Cuando se elija el proveedor real se agrega aquí
 * su implementación de ServicioNumeroControl; mientras tanto, producción no tiene servicio y la factura va a contingencia.
 */
export function servicioImprenta(): ServicioNumeroControl {
  const proveedor = (process.env.IMPRENTA_PROVEEDOR ?? 'simulada').toLowerCase();
  if (proveedor === 'simulada' && process.env.NODE_ENV !== 'production') return new ImprentaSimulada();
  if (proveedor === 'simulada') {
    throw new ErrorMaestro('No hay un proveedor de imprenta digital configurado (el simulador no se usa en producción).');
  }
  throw new ErrorMaestro(`El proveedor de imprenta digital "${proveedor}" todavía no está integrado.`);
}
