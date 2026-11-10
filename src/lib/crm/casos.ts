import type { Db } from '@/lib/db/tipos';
import { ErrorMaestro } from '@/lib/errores';
import { soloLoSuyo, UUID, type Usuario } from './comun';

/**
 * Casos de postventa (§6.5 regla 5, migración 0058): reclamos, garantías, devoluciones y consultas de un cliente.
 * Un caso de devolución no mueve inventario: se resuelve con la nota de crédito por devolución de su factura (§6.2), que
 * se crea en Notas de crédito y débito y aprueba el Supervisor de ventas como cualquier otra.
 */

export const TIPOS_CASO = ['reclamo', 'garantia', 'devolucion', 'consulta'] as const;
export type TipoCaso = (typeof TIPOS_CASO)[number];
export const NOMBRE_TIPO_CASO: Record<TipoCaso, string> = { reclamo: 'Reclamo', garantia: 'Garantía', devolucion: 'Devolución', consulta: 'Consulta' };
export const ESTADOS_CASO = ['abierto', 'en_analisis', 'resuelto', 'cerrado'] as const;
export type EstadoCaso = (typeof ESTADOS_CASO)[number];
export const NOMBRE_ESTADO_CASO: Record<EstadoCaso, string> = { abierto: 'Abierto', en_analisis: 'En análisis', resuelto: 'Resuelto', cerrado: 'Cerrado' };

interface Caso { id: string; estado: EstadoCaso; tipo: TipoCaso; vendedor_usuario: string | null; documento_venta_id: string | null }

async function caso(tx: Db, u: Usuario, id: string): Promise<Caso> {
  if (!UUID.test(id)) throw new ErrorMaestro('El caso no existe.');
  const { rows } = await tx.query<Caso>(
    `select k.id, k.estado, k.tipo, v.usuario_id as vendedor_usuario, k.documento_venta_id
       from caso_postventa k join cliente c on c.tercero_id = k.tercero_id left join vendedor v on v.id = c.vendedor_id
      where k.id = $1 for update of k`, [id]);
  if (!rows[0]) throw new ErrorMaestro('El caso no existe.');
  if (soloLoSuyo(u) && rows[0].vendedor_usuario !== u.id) throw new ErrorMaestro('Ese caso es de un cliente de otro vendedor.');
  return rows[0];
}

export interface DatosCaso { clienteId: string; tipo: TipoCaso; facturaId?: string | null; descripcion: string; responsableId?: string | null }

export async function abrirCaso(tx: Db, u: Usuario, d: DatosCaso): Promise<{ id: string; numero: string }> {
  if (!TIPOS_CASO.includes(d.tipo)) throw new ErrorMaestro('Seleccione el tipo de caso.');
  if (!UUID.test(d.clienteId)) throw new ErrorMaestro('Seleccione el cliente.');
  const { rows: cli } = await tx.query<{ vendedor_usuario: string | null }>(
    `select v.usuario_id as vendedor_usuario from cliente c left join vendedor v on v.id = c.vendedor_id where c.tercero_id = $1`, [d.clienteId]);
  if (!cli[0]) throw new ErrorMaestro('Seleccione el cliente.');
  if (soloLoSuyo(u) && cli[0].vendedor_usuario !== u.id) throw new ErrorMaestro('Ese cliente no está en su cartera.');
  if (d.tipo === 'devolucion' && !d.facturaId) throw new ErrorMaestro('Una devolución se refiere a una factura: selecciónela.');
  if (d.facturaId && !UUID.test(d.facturaId)) throw new ErrorMaestro('Seleccione la factura.');
  if (d.descripcion.trim().length < 5) throw new ErrorMaestro('Describa el caso.');
  const { rows } = await tx.query<{ id: string; numero: string }>(
    `insert into caso_postventa (tercero_id, documento_venta_id, tipo, descripcion, responsable_id, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id, numero::text`,
    [d.clienteId, d.facturaId || null, d.tipo, d.descripcion.trim(), d.responsableId || u.id, u.id]);
  return rows[0];
}

/** Registra el análisis: responsable, causa y (si se resuelve) la solución. */
export async function actualizarCaso(tx: Db, u: Usuario, id: string, d: { responsableId?: string | null; causa?: string; solucion?: string }): Promise<void> {
  const k = await caso(tx, u, id);
  if (k.estado === 'cerrado') throw new ErrorMaestro('Un caso cerrado no se modifica.');
  if (d.responsableId && !UUID.test(d.responsableId)) throw new ErrorMaestro('Seleccione el responsable.');
  await tx.query(
    `update caso_postventa set responsable_id = coalesce($2, responsable_id), causa = $3, solucion = $4 where id = $1`,
    [id, d.responsableId || null, d.causa?.trim() || null, d.solucion?.trim() || null]);
}

export async function cambiarEstadoCaso(tx: Db, u: Usuario, id: string, estado: EstadoCaso, solucion?: string): Promise<void> {
  const k = await caso(tx, u, id);
  if (!ESTADOS_CASO.includes(estado) || estado === 'abierto') throw new ErrorMaestro('Estado inválido.');
  if (estado === 'resuelto') {
    if (solucion !== undefined) await tx.query('update caso_postventa set solucion = $2 where id = $1', [id, solucion.trim() || null]);
    const { rows } = await tx.query<{ solucion: string | null }>('select solucion from caso_postventa where id = $1', [id]);
    if ((rows[0].solucion ?? '').trim().length < 3) throw new ErrorMaestro('Escriba la solución antes de marcar el caso como resuelto.');
  }
  if (k.estado === estado) return;
  await tx.query('update caso_postventa set estado = $2 where id = $1', [id, estado]);
}

/** Enlaza la nota de crédito por devolución de la factura del caso. */
export async function enlazarNotaCredito(tx: Db, u: Usuario, id: string, notaId: string): Promise<void> {
  const k = await caso(tx, u, id);
  if (k.tipo !== 'devolucion') throw new ErrorMaestro('Solo un caso de devolución lleva nota de crédito.');
  if (!UUID.test(notaId)) throw new ErrorMaestro('Seleccione la nota de crédito.');
  await tx.query('update caso_postventa set nota_credito_id = $2 where id = $1', [id, notaId]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export interface FilaCaso {
  id: string; numero: string; tipo: TipoCaso; estado: EstadoCaso; cliente_id: string; cliente: string; factura: string | null;
  responsable: string | null; abierto: string; resuelto: string | null; dias: string;
}

export async function listarCasos(db: Db, u: Usuario, filtro: { estado?: string; clienteId?: string } = {}, limite = 200): Promise<FilaCaso[]> {
  const { rows } = await db.query<FilaCaso>(
    `select k.id, k.numero::text, k.tipo, k.estado, k.tercero_id as cliente_id, c.codigo || ' · ' || t.razon_social as cliente,
            d.numero::text as factura, r.nombre as responsable,
            to_char(k.abierto_at at time zone 'America/Caracas', 'DD-MM-YYYY') as abierto,
            to_char(k.resuelto_at at time zone 'America/Caracas', 'DD-MM-YYYY') as resuelto,
            round(extract(epoch from coalesce(k.resuelto_at, now()) - k.abierto_at) / 86400, 1)::text as dias
       from caso_postventa k
       join cliente c on c.tercero_id = k.tercero_id
       join tercero t on t.id = k.tercero_id
       left join vendedor v on v.id = c.vendedor_id
       left join documento_venta d on d.id = k.documento_venta_id
       left join usuario r on r.id = k.responsable_id
      where (not $1 or v.usuario_id = $2)
        and ($3 = '' or ($3 = 'pendientes' and k.estado in ('abierto', 'en_analisis')) or k.estado = $3)
        and ($4::uuid is null or k.tercero_id = $4)
      order by k.estado in ('abierto', 'en_analisis') desc, k.numero desc limit $5`,
    [soloLoSuyo(u), u.id, filtro.estado ?? '', filtro.clienteId || null, limite]);
  return rows;
}

export interface DetalleCaso extends FilaCaso {
  rif: string; descripcion: string; causa: string | null; solucion: string | null; responsable_id: string | null;
  documento_venta_id: string | null; nota_credito_id: string | null; nota_numero: string | null; nota_estado: string | null;
  cerrado: string | null; creado_por: string; vendedor_usuario: string | null;
}

export async function detalleCaso(db: Db, id: string): Promise<DetalleCaso | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<DetalleCaso>(
    `select k.id, k.numero::text, k.tipo, k.estado, k.tercero_id as cliente_id, c.codigo || ' · ' || t.razon_social as cliente, t.rif,
            d.numero::text as factura, r.nombre as responsable, k.responsable_id, k.descripcion, k.causa, k.solucion,
            to_char(k.abierto_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as abierto,
            to_char(k.resuelto_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as resuelto,
            to_char(k.cerrado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as cerrado,
            round(extract(epoch from coalesce(k.resuelto_at, now()) - k.abierto_at) / 86400, 1)::text as dias,
            k.documento_venta_id, k.nota_credito_id, n.numero::text as nota_numero, n.estado as nota_estado,
            us.nombre as creado_por, v.usuario_id as vendedor_usuario
       from caso_postventa k
       join cliente c on c.tercero_id = k.tercero_id
       join tercero t on t.id = k.tercero_id
       join usuario us on us.id = k.created_by
       left join vendedor v on v.id = c.vendedor_id
       left join documento_venta d on d.id = k.documento_venta_id
       left join documento_venta n on n.id = k.nota_credito_id
       left join usuario r on r.id = k.responsable_id
      where k.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Notas de crédito por devolución (no anuladas) de la factura del caso, para enlazarlas. */
export async function notasDevolucionDeFactura(db: Db, facturaId: string): Promise<{ id: string; etiqueta: string }[]> {
  const { rows } = await db.query<{ id: string; etiqueta: string }>(
    `select id, coalesce('NC ' || numero::text, 'NC en borrador') || ' · Bs. ' || total::text || ' · ' || estado as etiqueta
       from documento_venta where tipo = 'nota_credito' and motivo_nc = 'devolucion' and documento_origen_id = $1 and estado <> 'anulado'
      order by created_at`, [facturaId]);
  return rows;
}

/** Facturas emitidas de un cliente (las últimas), para abrir un caso. */
export async function facturasDeCliente(db: Db, clienteId: string, limite = 50): Promise<{ id: string; etiqueta: string }[]> {
  const { rows } = await db.query<{ id: string; etiqueta: string }>(
    `select id, 'Factura ' || numero::text || ' · ' || to_char(fecha_emision at time zone 'America/Caracas', 'DD-MM-YYYY') as etiqueta
       from documento_venta where tipo = 'factura' and estado = 'emitido' and cliente_id = $1
      order by fecha_emision desc limit $2`, [clienteId, limite]);
  return rows;
}
