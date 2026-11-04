import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { solicitarAprobacion } from '@/lib/flujo/flujo';
import { textoDeAnulacion, type MotivoDocumento } from '@/lib/maestros/motivos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import type { Usuario } from './ordenes';

/**
 * Pagos a proveedores (spec §7.3, §12.3; migración 0038).
 *
 *   solicitar → (Gerencia, distinta de quien solicitó) aprobar → aplicar a las facturas, salir del banco y contabilizar
 *
 * Un pago solicitado no mueve nada. Al aprobarse, en la misma transacción: las aplicaciones (los importes de cada una los calcula la base
 * de datos al insertarla), los saldos de las facturas y el asiento `pago_proveedor`. Lo que no se aplica queda como anticipo a proveedor
 * (1.2.02), que se aplica después con `aplicarAnticipoPago` (asiento `aplicacion_anticipo_pago`). La diferencia entre lo que sale de
 * cuentas por pagar (valor de la factura) y lo que sale del banco es diferencial cambiario.
 */

/** Solicitan pagos y aplican anticipos; aprueba Gerencia (§4.3: Pago a proveedor → Tesorería crea, Gerencia aprueba). */
export const ROLES_PAGAN = ['tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_PAGOS = ['tesoreria', 'gerencia', 'compras', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^\d{1,14}(\.\d{1,2})?$/;
const dos = (v: Decimal.Value) => new Decimal(v).toFixed(2);

export const NOMBRE_ESTADO_PAGO: Record<string, string> = {
  solicitado: 'Solicitado: pendiente de Gerencia', pagado: 'Pagado', rechazado: 'Rechazado', anulado: 'Anulado',
};

export interface AplicacionPagoEntrada {
  partidaId: string;
  /** Cuánto del pago se aplica a esa factura, en la moneda del pago. */
  monto: string;
  /** El pago liquida el saldo de la factura (con un centavo de tolerancia por la conversión entre monedas). */
  liquida?: boolean;
}

export interface DatosPago {
  proveedorId: string;
  /** 'AAAA-MM-DD'; hoy o anterior. */
  fecha: string;
  instrumentoId: string;
  cuentaBancariaId: string;
  referencia?: string;
  monto: string;
  observaciones?: string;
  /** A qué facturas se aplica; lo que quede sin aplicar es un anticipo al proveedor. */
  aplicaciones?: AplicacionPagoEntrada[];
}

function normalizarMonto(texto: string, etiqueta: string): string {
  const v = texto.trim().replace(',', '.');
  if (!MONTO.test(v) || new Decimal(v).lte(0)) throw new ErrorMaestro(`${etiqueta}: indique un monto mayor que cero con hasta 2 decimales.`);
  return new Decimal(v).toFixed(2);
}

function validarAplicaciones(aplicaciones: AplicacionPagoEntrada[]): AplicacionPagoEntrada[] {
  const vistas = new Set<string>();
  return aplicaciones.map((a) => {
    if (vistas.has(a.partidaId)) throw new ErrorMaestro('Una factura no puede aparecer dos veces en el mismo pago.');
    vistas.add(a.partidaId);
    return { partidaId: a.partidaId, monto: normalizarMonto(a.monto, 'Monto a aplicar'), liquida: a.liquida ?? false };
  });
}

/** Solicita un pago: no mueve nada hasta que Gerencia lo apruebe. Devuelve su id y su número. */
export async function solicitarPago(tx: Db, u: Usuario, d: DatosPago): Promise<{ id: string; numero: string }> {
  if (!FECHA.test(d.fecha)) throw new ErrorMaestro('Indique la fecha del pago.');
  const monto = normalizarMonto(d.monto, 'Monto del pago');
  const aplicaciones = validarAplicaciones(d.aplicaciones ?? []);
  const aplicado = aplicaciones.reduce((s, a) => s.plus(a.monto), new Decimal(0));
  if (aplicado.gt(monto)) throw new ErrorMaestro(`Lo que se aplica (${dos(aplicado)}) supera el monto del pago (${monto}).`);

  const { rows: cuenta } = await tx.query<{ moneda: string }>('select moneda from cuenta_bancaria where id = $1', [d.cuentaBancariaId]);
  if (!cuenta[0]) throw new ErrorMaestro('Seleccione la cuenta de donde sale el pago.');

  const { rows } = await tx.query<{ id: string; numero: string; monto_usd: string }>(
    // La tasa BCV, los valores en VES y USD y lo que falta por aplicar los fija la base de datos al insertar.
    `insert into pago (proveedor_id, fecha, instrumento_id, cuenta_bancaria_id, referencia, moneda, monto, observaciones, created_by)
     values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) returning id, numero::text, monto_usd::text`,
    [d.proveedorId, d.fecha, d.instrumentoId, d.cuentaBancariaId, d.referencia ?? null, cuenta[0].moneda, monto, d.observaciones?.trim() || null, u.id]);
  const pago = rows[0];
  for (const a of aplicaciones) {
    await tx.query('insert into pago_linea (pago_id, partida_id, monto, liquida) values ($1, $2, $3, $4)', [pago.id, a.partidaId, a.monto, a.liquida ?? false]);
  }
  await solicitarAprobacion(tx, { tipo: 'pago_proveedor', objetoId: pago.id, solicitanteId: u.id, contexto: { valor_usd: Number(pago.monto_usd) } });
  return { id: pago.id, numero: pago.numero };
}

interface Calculada { id: string; monto_pago: string; monto_partida: string; ves_partida: string; usd_partida: string; base_ves: string; base_usd: string }

/** Asiento de un pago o de la aplicación de un anticipo, con importes dobles (VES y USD ya calculados). */
async function asentar(
  tx: Db, u: { id: string },
  p: {
    evento: 'pago_proveedor' | 'aplicacion_anticipo_pago'; fecha: string; moneda: string; descripcion: string; origen: { tipo: string; id: string };
    proveedorId: string; cuentaBanco?: string; aplicadas: Calculada[];
    banco?: { original: string; ves: string; usd: string }; anticipo: { original: string; ves: string; usd: string };
  },
): Promise<string> {
  const suma = (campo: keyof Calculada) => p.aplicadas.reduce((s, a) => s.plus(a[campo]), new Decimal(0));
  const cxp = { original: suma('monto_partida'), ves: suma('ves_partida'), usd: suma('usd_partida') };
  // Lo que sale de cuentas por pagar (valor de la factura) menos el valor en los libros de lo pagado: positivo = se pagó menos de lo que se debía.
  const difVes = cxp.ves.minus(suma('base_ves'));
  const difUsd = cxp.usd.minus(suma('base_usd'));
  const positivo = (d: Decimal) => (d.isPositive() ? d : new Decimal(0));
  const negativo = (d: Decimal) => (d.isNegative() ? d.abs() : new Decimal(0));
  const par = (ves: Decimal, usd: Decimal) => ({ ves: dos(ves), usd: dos(usd) });
  const cero = new Decimal(0);

  const dobles: Record<string, { ves: string; usd: string; original?: string }> = {
    cxp: { ...par(cxp.ves, cxp.usd), original: dos(cxp.original) },
    anticipo: p.anticipo,
    dif_ganancia_ves: par(positivo(difVes), cero), dif_ganancia_usd: par(cero, positivo(difUsd)),
    dif_perdida_ves: par(negativo(difVes), cero), dif_perdida_usd: par(cero, negativo(difUsd)),
  };
  if (p.banco) dobles.banco = p.banco;
  const r = await contabilizar(tx, {
    evento: p.evento, fecha: p.fecha, descripcion: p.descripcion, origen: p.origen, moneda: p.moneda, importes: {},
    importesDobles: dobles, cuentas: p.cuentaBanco ? { banco: p.cuentaBanco } : undefined, terceroId: p.proveedorId, usuarioId: u.id,
  });
  return r.numero;
}

async function insertarAplicaciones(
  tx: Db, pagoId: string, origen: 'registro' | 'anticipo', fecha: string, aplicaciones: AplicacionPagoEntrada[],
): Promise<Calculada[]> {
  const calculadas: Calculada[] = [];
  for (const a of aplicaciones) {
    const { rows } = await tx.query<Calculada>(
      `insert into aplicacion_pago (pago_id, partida_id, origen, fecha, liquida, monto_pago) values ($1, $2, $3, $4::date, $5, $6)
       returning id, monto_pago::text, monto_partida::text, ves_partida::text, usd_partida::text, base_ves::text, base_usd::text`,
      [pagoId, a.partidaId, origen, fecha, a.liquida ?? false, a.monto]);
    calculadas.push(rows[0]);
  }
  return calculadas;
}

export interface ResultadoPago { asiento: string; anticipo: string }

/**
 * Lo llama el motor de flujo cuando Gerencia aprueba el pago: lo marca pagado (la base exige que apruebe Gerencia y no quien lo solicitó),
 * lo aplica a las facturas pedidas, lo que sobre queda como anticipo, y genera el asiento.
 */
export async function aprobarPago(tx: Db, id: string, aprobador: string): Promise<ResultadoPago> {
  const { rows } = await tx.query<{
    estado: string; proveedor_id: string; fecha: string; moneda: string; cuenta_contable_id: string; numero: string; razon: string;
  }>(
    `select p.estado, p.proveedor_id, p.fecha::text, p.moneda, cb.cuenta_contable_id, p.numero::text, t.razon_social as razon
       from pago p join cuenta_bancaria cb on cb.id = p.cuenta_bancaria_id join tercero t on t.id = p.proveedor_id
      where p.id = $1 for update of p`, [id]);
  const p = rows[0];
  if (!p) throw new ErrorMaestro('El pago no existe.');
  if (p.estado !== 'solicitado') throw new ErrorMaestro('El pago no está pendiente de aprobación.');
  await tx.query(`update pago set estado = 'pagado', aprobado_por = $2 where id = $1`, [id, aprobador]);

  const { rows: lineas } = await tx.query<{ partida_id: string; monto: string; liquida: boolean }>(
    'select partida_id, monto::text, liquida from pago_linea where pago_id = $1 order by id', [id]);
  const calculadas = await insertarAplicaciones(tx, id, 'registro', p.fecha, lineas.map((l) => ({ partidaId: l.partida_id, monto: l.monto, liquida: l.liquida })));

  const { rows: c } = await tx.query<{ monto: string; monto_ves: string; monto_usd: string; por_aplicar: string; por_aplicar_ves: string; por_aplicar_usd: string }>(
    `select monto::text, monto_ves::text, monto_usd::text, por_aplicar::text, por_aplicar_ves::text, por_aplicar_usd::text from pago where id = $1`, [id]);
  const asiento = await asentar(tx, { id: aprobador }, {
    evento: 'pago_proveedor', fecha: p.fecha, moneda: p.moneda, descripcion: `Pago N° ${p.numero} · ${p.razon}`, origen: { tipo: 'pago_proveedor', id },
    proveedorId: p.proveedor_id, cuentaBanco: p.cuenta_contable_id, aplicadas: calculadas,
    banco: { original: c[0].monto, ves: c[0].monto_ves, usd: c[0].monto_usd },
    anticipo: { original: c[0].por_aplicar, ves: c[0].por_aplicar_ves, usd: c[0].por_aplicar_usd },
  });
  return { asiento, anticipo: c[0].por_aplicar };
}

/** Lo llama el motor de flujo cuando Gerencia rechaza el pago: no mueve nada y no se puede volver a solicitar el mismo. */
export async function rechazarPago(tx: Db, id: string, _usuario: string, motivo: string): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from pago where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El pago no existe.');
  if (rows[0].estado !== 'solicitado') throw new ErrorMaestro('El pago no está pendiente de aprobación.');
  await tx.query(`update pago set estado = 'rechazado', rechazo_motivo = $2 where id = $1`, [id, motivo.trim()]);
}

/** Aplica lo que queda de un pago aprobado (su anticipo) a facturas del mismo proveedor, y genera el asiento de la aplicación. */
export async function aplicarAnticipoPago(
  tx: Db, u: Usuario, pagoId: string, d: { fecha?: string; aplicaciones: AplicacionPagoEntrada[] },
): Promise<{ asiento: string; anticipo: string }> {
  const aplicaciones = validarAplicaciones(d.aplicaciones);
  if (!aplicaciones.length) throw new ErrorMaestro('Indique a qué facturas se aplica el anticipo.');
  const { rows } = await tx.query<{ estado: string; proveedor_id: string; moneda: string; por_aplicar: string; numero: string; razon: string; hoy: string }>(
    `select p.estado, p.proveedor_id, p.moneda, p.por_aplicar::text, p.numero::text, t.razon_social as razon,
            ((now() at time zone 'America/Caracas')::date)::text as hoy
       from pago p join tercero t on t.id = p.proveedor_id where p.id = $1 for update of p`, [pagoId]);
  const p = rows[0];
  if (!p) throw new ErrorMaestro('El pago no existe.');
  if (p.estado !== 'pagado') throw new ErrorMaestro('Solo se aplica el anticipo de un pago aprobado.');
  if (new Decimal(p.por_aplicar).lte(0)) throw new ErrorMaestro('Este pago no tiene anticipo por aplicar.');
  const fecha = d.fecha ?? p.hoy;
  if (!FECHA.test(fecha)) throw new ErrorMaestro('Indique la fecha de la aplicación.');

  const calculadas = await insertarAplicaciones(tx, pagoId, 'anticipo', fecha, aplicaciones);
  const suma = (campo: keyof Calculada) => calculadas.reduce((s, a) => s.plus(a[campo]), new Decimal(0));
  const asiento = await asentar(tx, u, {
    evento: 'aplicacion_anticipo_pago', fecha, moneda: p.moneda, descripcion: `Aplicación del anticipo del pago N° ${p.numero} · ${p.razon}`,
    origen: { tipo: 'aplicacion_pago', id: calculadas[0].id }, proveedorId: p.proveedor_id, aplicadas: calculadas,
    anticipo: { original: dos(suma('monto_pago')), ves: dos(suma('base_ves')), usd: dos(suma('base_usd')) },
  });
  const { rows: resto } = await tx.query<{ por_aplicar: string }>('select por_aplicar::text from pago where id = $1', [pagoId]);
  return { asiento, anticipo: resto[0].por_aplicar };
}

/** Anula un pago aprobado: reverso del asiento y las facturas recuperan su saldo. Con un anticipo ya aplicado a facturas, no se anula. */
export async function anularPago(tx: Db, _u: Usuario, id: string, motivo: MotivoDocumento): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from pago where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El pago no existe.');
  if (rows[0].estado !== 'pagado') throw new ErrorMaestro(rows[0].estado === 'anulado' ? 'El pago ya está anulado.' : 'Solo se anula un pago aprobado.');
  const texto = await textoDeAnulacion(tx, motivo);
  const { rows: a } = await tx.query<{ id: string }>(
    `select id from asiento where origen_tipo = 'pago_proveedor' and origen_id = $1 and tipo = 'automatico'`, [id]);
  if (!a[0]) throw new ErrorMaestro('El pago no tiene asiento: avise al administrador.');
  await tx.query(`update pago set estado = 'anulado', anulado_motivo = $2, anulado_motivo_id = $3 where id = $1`, [id, texto, motivo.motivoId]);
  await tx.query(`select fn_reversar_asiento($1, ((now() at time zone 'America/Caracas')::date), $2)`, [a[0].id, `Anulación del pago: ${texto}`]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

const puedeVer = (u: Usuario) => u.roles.some((r) => (ROLES_VEN_PAGOS as readonly string[]).includes(r));

export interface FilaPago {
  id: string; numero: string; fecha: string; proveedor_id: string; proveedor: string; moneda: string; monto: string; por_aplicar: string;
  instrumento: string; cuenta: string; referencia: string | null; estado: string;
}

export async function buscarPagos(db: Db, u: Usuario, filtro: { estado?: string; texto?: string; proveedorId?: string } = {}, limite = 100): Promise<FilaPago[]> {
  if (!puedeVer(u)) return [];
  const { rows } = await db.query<FilaPago>(
    `select p.id, p.numero::text, p.fecha::text, p.proveedor_id, pr.codigo || ' · ' || t.razon_social as proveedor, p.moneda, p.monto::text,
            p.por_aplicar::text, i.nombre as instrumento, cb.nombre as cuenta, p.referencia, p.estado
       from pago p
       join proveedor pr on pr.tercero_id = p.proveedor_id
       join tercero t on t.id = p.proveedor_id
       join instrumento_pago i on i.id = p.instrumento_id
       join cuenta_bancaria cb on cb.id = p.cuenta_bancaria_id
      where ($1 = '' or p.estado = $1) and ($3::uuid is null or p.proveedor_id = $3)
        and ($2 = '' or p.numero::text = $2 or pr.codigo ilike '%' || $2 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($2) || '%'
             or upper(p.referencia) like '%' || upper($2) || '%')
      order by p.fecha desc, p.numero desc limit $4`, [filtro.estado ?? '', (filtro.texto ?? '').trim(), filtro.proveedorId ?? null, limite]);
  return rows;
}

export interface AplicacionPagoDetalle {
  id: string; origen: 'registro' | 'anticipo'; fecha: string; factura: string; monto_pago: string; monto_partida: string; moneda_partida: string;
  ves_partida: string; usd_partida: string; base_ves: string; base_usd: string; dif_ves: string; dif_usd: string; revertida: boolean;
}
export interface LineaPagoSolicitada { partida_id: string; factura: string; moneda: string; monto: string; liquida: boolean; saldo: string }

export interface DetallePago extends FilaPago {
  cuenta_bancaria_id: string; tasa: string; monto_ves: string; monto_usd: string; por_aplicar_ves: string; por_aplicar_usd: string;
  observaciones: string | null; creador_id: string; creador: string; creado: string; aprobado_por: string | null; aprobado: string | null;
  rechazo_motivo: string | null; anulado_motivo: string | null; anulado: string | null; asiento: string | null; asiento_id: string | null;
  lineas: LineaPagoSolicitada[]; aplicaciones: AplicacionPagoDetalle[];
}

const FACTURA = `coalesce(f.numero_factura, g.numero_factura, 'ND ' || n.numero_documento)`;
const JOIN_ORIGEN = `left join factura_compra f on f.id = c.factura_id left join gasto_importacion g on g.id = c.gasto_id left join nota_proveedor n on n.id = c.nota_id`;

export async function detallePago(db: Db, id: string): Promise<DetallePago | null> {
  const { rows } = await db.query<Omit<DetallePago, 'lineas' | 'aplicaciones'>>(
    `select p.id, p.numero::text, p.fecha::text, p.proveedor_id, pr.codigo || ' · ' || t.razon_social as proveedor, p.moneda, p.monto::text,
            p.por_aplicar::text, i.nombre as instrumento, cb.nombre as cuenta, p.referencia, p.estado, p.cuenta_bancaria_id,
            p.tasa::text, p.monto_ves::text, p.monto_usd::text, p.por_aplicar_ves::text, p.por_aplicar_usd::text, p.observaciones,
            p.created_by as creador_id, cr.nombre as creador, to_char(p.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creado,
            ap.nombre as aprobado_por, to_char(p.aprobado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as aprobado,
            p.rechazo_motivo, p.anulado_motivo, to_char(p.anulado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as anulado,
            a.numero::text as asiento, a.id as asiento_id
       from pago p
       join proveedor pr on pr.tercero_id = p.proveedor_id
       join tercero t on t.id = p.proveedor_id
       join instrumento_pago i on i.id = p.instrumento_id
       join cuenta_bancaria cb on cb.id = p.cuenta_bancaria_id
       join usuario cr on cr.id = p.created_by
       left join usuario ap on ap.id = p.aprobado_por
       left join asiento a on a.origen_tipo = 'pago_proveedor' and a.origen_id = p.id and a.tipo = 'automatico'
      where p.id = $1`, [id]);
  if (!rows[0]) return null;
  const [lineas, aplicaciones] = await Promise.all([
    db.query<LineaPagoSolicitada>(
      `select l.partida_id, ${FACTURA} as factura, c.moneda, l.monto::text, l.liquida, c.saldo::text
         from pago_linea l join partida_cxp c on c.id = l.partida_id
         ${JOIN_ORIGEN}
        where l.pago_id = $1 order by l.id`, [id]),
    db.query<AplicacionPagoDetalle>(
      `select ap.id, ap.origen, ap.fecha::text, ${FACTURA} as factura, ap.monto_pago::text, ap.monto_partida::text, c.moneda as moneda_partida,
              ap.ves_partida::text, ap.usd_partida::text, ap.base_ves::text, ap.base_usd::text, (ap.ves_partida - ap.base_ves)::text as dif_ves,
              (ap.usd_partida - ap.base_usd)::text as dif_usd, ap.revertida
         from aplicacion_pago ap join partida_cxp c on c.id = ap.partida_id
         ${JOIN_ORIGEN}
        where ap.pago_id = $1 order by ap.created_at, ap.id`, [id]),
  ]);
  return { ...rows[0], lineas: lineas.rows, aplicaciones: aplicaciones.rows };
}

export interface PartidaPorPagar {
  partida_id: string; factura: string; fecha: string; vencimiento: string; moneda: string; saldo: string; saldo_usd: string; dias_vencida: number;
}

/** Facturas y gastos con saldo por pagar de un proveedor, los que vencen primero arriba. */
export async function partidasPorPagar(db: Db, proveedorId: string): Promise<PartidaPorPagar[]> {
  const { rows } = await db.query<PartidaPorPagar>(
    `select c.id as partida_id, ${FACTURA} as factura, c.fecha::text, c.vencimiento::text, c.moneda, c.saldo::text, c.saldo_usd::text,
            greatest(((now() at time zone 'America/Caracas')::date - c.vencimiento), 0)::int as dias_vencida
       from partida_cxp c ${JOIN_ORIGEN}
      where c.proveedor_id = $1 and c.estado = 'abierta' order by c.vencimiento, c.fecha`, [proveedorId]);
  return rows;
}

export interface CuadreCxP {
  auxiliar_ves: string; auxiliar_usd: string; mayor_ves: string; mayor_usd: string;
  anticipos_auxiliar_ves: string; anticipos_auxiliar_usd: string; anticipos_mayor_ves: string; anticipos_mayor_usd: string; cuadra: boolean;
}

/**
 * Auxiliar contra mayor: la suma de los saldos de las partidas abiertas contra Cuentas por pagar a proveedores (2.1.01), y los anticipos
 * sin aplicar contra Anticipos a proveedores (1.2.02), en bolívares y en USD, al centavo.
 */
export async function cuadreCxP(db: Db): Promise<CuadreCxP> {
  const mayor = (cuenta: string, lado: 'haber' | 'debe', moneda: 'ves' | 'usd') => {
    const [a, b] = lado === 'haber' ? ['haber', 'debe'] : ['debe', 'haber'];
    return `coalesce((select sum(l.${a}_${moneda} - l.${b}_${moneda}) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                       join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '${cuenta}'), 0)::text`;
  };
  const { rows } = await db.query<Omit<CuadreCxP, 'cuadra'>>(
    `select coalesce((select sum(saldo_ves) from partida_cxp where estado = 'abierta'), 0)::text as auxiliar_ves,
            coalesce((select sum(saldo_usd) from partida_cxp where estado = 'abierta'), 0)::text as auxiliar_usd,
            ${mayor('2.1.01', 'haber', 'ves')} as mayor_ves, ${mayor('2.1.01', 'haber', 'usd')} as mayor_usd,
            coalesce((select sum(por_aplicar_ves) from pago where estado = 'pagado'), 0)::text as anticipos_auxiliar_ves,
            coalesce((select sum(por_aplicar_usd) from pago where estado = 'pagado'), 0)::text as anticipos_auxiliar_usd,
            ${mayor('1.2.02', 'debe', 'ves')} as anticipos_mayor_ves, ${mayor('1.2.02', 'debe', 'usd')} as anticipos_mayor_usd`);
  const r = rows[0];
  const igual = (a: string, b: string) => new Decimal(a).equals(b);
  return {
    ...r,
    cuadra: igual(r.auxiliar_ves, r.mayor_ves) && igual(r.auxiliar_usd, r.mayor_usd)
      && igual(r.anticipos_auxiliar_ves, r.anticipos_mayor_ves) && igual(r.anticipos_auxiliar_usd, r.anticipos_mayor_usd),
  };
}
