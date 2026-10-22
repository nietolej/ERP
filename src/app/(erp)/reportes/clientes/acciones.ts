'use server';

import { autorizarSesion } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { buscarClientes } from '@/lib/maestros/clientes';
import type { ClienteSugerido } from '@/components/buscador-cliente';

/** Autocompletado del buscador de clientes de los reportes (hasta 10, con la misma seguridad por fila). */
export async function buscarClientesAutocompletar(texto: string): Promise<ClienteSugerido[]> {
  const u = await autorizarSesion();
  const db = await getDb();
  const filas = await buscarClientes(db, u, { texto }, 10);
  return filas.map((f) => ({ id: f.id, codigo: f.codigo, razon_social: f.razon_social }));
}
