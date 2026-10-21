export type TonoDocumento = 'info' | 'exito' | 'advertencia' | 'peligro';

/** Texto y color con que se muestra el estado de un pedido o una nota de entrega. */
export function etiquetaDocumento(estado: string, situacion: string | null, tipo: 'pedido' | 'nota_entrega' = 'pedido'): { texto: string; tono: TonoDocumento } {
  if (estado === 'emitido' && situacion === 'retenido_credito') return { texto: 'Retenido por crédito', tono: 'advertencia' };
  if (estado === 'emitido' && situacion === 'facturada') return { texto: 'Facturada', tono: 'exito' };
  if (estado === 'emitido' && situacion === 'despachada') return { texto: 'Despachada', tono: 'exito' };
  if (estado === 'emitido' && situacion === 'aprobado') return { texto: 'Aprobado', tono: 'exito' };
  if (estado === 'emitido') return { texto: tipo === 'pedido' ? 'Emitido' : 'Emitida', tono: 'exito' };
  if (estado === 'anulado') return { texto: tipo === 'pedido' ? 'Anulado' : 'Anulada', tono: 'peligro' };
  return { texto: 'Borrador', tono: 'info' };
}

const ESTADOS_ORDEN: Record<string, { texto: string; tono: TonoDocumento }> = {
  pendiente: { texto: 'Pendiente', tono: 'info' },
  asignada: { texto: 'Asignada', tono: 'info' },
  en_proceso: { texto: 'En proceso', tono: 'advertencia' },
  completa: { texto: 'Completa', tono: 'exito' },
  con_faltante: { texto: 'Con faltante', tono: 'peligro' },
  cancelada: { texto: 'Cancelada', tono: 'peligro' },
};

/** Texto y color de una orden de picking. */
export function etiquetaOrden(estado: string): { texto: string; tono: TonoDocumento } {
  return ESTADOS_ORDEN[estado] ?? { texto: estado, tono: 'info' };
}

/** Duración en segundos como "1 h 05 min" o "12 min". */
export function duracion(segundos: string | null | undefined): string {
  if (segundos === null || segundos === undefined || segundos === '') return '—';
  const total = Math.round(Number(segundos));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const ESTADOS_TRANSPORTE: Record<string, { texto: string; tono: TonoDocumento }> = {
  planificado: { texto: 'Planificado', tono: 'info' },
  cargado: { texto: 'Cargado', tono: 'advertencia' },
  en_ruta: { texto: 'En ruta', tono: 'advertencia' },
  entregado: { texto: 'Entregado', tono: 'exito' },
  cerrado: { texto: 'Cerrado', tono: 'exito' },
  anulado: { texto: 'Anulado', tono: 'peligro' },
};

/** Texto y color del estado de un transporte. */
export function etiquetaTransporte(estado: string): { texto: string; tono: TonoDocumento } {
  return ESTADOS_TRANSPORTE[estado] ?? { texto: estado, tono: 'info' };
}
