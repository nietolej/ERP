import Decimal from 'decimal.js';
import type { Rol } from '@/lib/auth/constantes';
import { contabilizar } from '@/lib/contabilidad/motor';
import type { Db } from '@/lib/db/tipos';
import { textoDeAnulacion, type MotivoDocumento } from '@/lib/maestros/motivos';
import { ErrorMaestro } from '@/lib/maestros/terceros';
import type { Usuario } from './pedidos';

/**
 * Cobros y su aplicación a las cuentas por cobrar (§6.3, §12.3, migración 0028).
 *
 * Todo ocurre en la transacción del llamador: el cobro, sus aplicaciones, los saldos de las facturas y el asiento. Los importes de cada
 * aplicación (bolívares que cancela, USD históricos, valor en los libros de lo cobrado) los calcula la base de datos al insertarla; aquí se
 * leen y se arman los asientos de los eventos `cobro` y `aplicacion_anticipo` con el motor contable.
 */

/** Registran y aplican cobros. Facturación no: quien factura no aplica cobros (§3.6). */
export const ROLES_COBRAN = ['cobranzas', 'tesoreria', 'gerencia'] as const satisfies readonly Rol[];
export const ROLES_VEN_COBROS = ['cobranzas', 'tesoreria', 'gerencia', 'supervisor_ventas', 'contabilidad', 'jefe_contabilidad', 'auditor'] as const satisfies readonly Rol[];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^\d{1,14}(\.\d{1,2})?$/;

export interface AplicacionEntrada {
  partidaId: string;
  /** Cuánto del cobro se aplica a esa factura, en la moneda del cobro. */
  monto: string;
  /** El cobro liquida el saldo de la factura (con un centavo de la divisa de tolerancia por la conversión). */
  liquida?: boolean;
}

export interface DatosCobro {
  clienteId: string;
  /** 'YYYY-MM-DD'; hoy o anterior. */
  fecha: string;
  instrumentoId: string;
  cuentaBancariaId: string;
  referencia?: string;
  monto: string;
  observaciones?: string;
  /** A qué facturas se aplica; lo que quede sin aplicar es un anticipo del cliente. */
  aplicaciones?: AplicacionEntrada[];
}

interface Calculada {
  id: string; monto_cobro: string; monto_partida: string; usd_partida: string; base_ves: string; base_usd: string;
}

const dos = (v: Decimal.Value) => new Decimal(v).toFixed(2);

function normalizarMonto(texto: string, etiqueta: string): string {
  const v = texto.trim().replace(',', '.');
  if (!MONTO.test(v) || new Decimal(v).lte(0)) throw new ErrorMaestro(`${etiqueta}: indique un monto mayor que cero con hasta 2 decimales.`);
  return new Decimal(v).toFixed(2);
}

function validarAplicaciones(aplicaciones: AplicacionEntrada[]): AplicacionEntrada[] {
  const vistas = new Set<string>();
  return aplicaciones.map((a) => {
    if (vistas.has(a.partidaId)) throw new ErrorMaestro('Una factura no puede aparecer dos veces en el mismo cobro.');
    vistas.add(a.partidaId);
    return { partidaId: a.partidaId, monto: normalizarMonto(a.monto, 'Monto a aplicar'), liquida: a.liquida ?? false };
  });
}

/**
 * Asiento de un cobro o de la aplicación de un anticipo. Los importes son dobles (VES y USD ya calculados): la parte de la cuenta por
 * cobrar vale lo que valía su factura y la diferencia con lo cobrado va al diferencial cambiario, en cada moneda.
 */
async function asentar(
  tx: Db, u: Usuario,
  p: {
    evento: 'cobro' | 'aplicacion_anticipo'; fecha: string; moneda: string; descripcion: string; origen: { tipo: string; id: string };
    clienteId: string; cuentaBanco?: string; aplicadas: Calculada[];
    banco?: { original: string; ves: string; usd: string }; anticipo: { original: string; ves: string; usd: string };
  },
): Promise<string> {
  const suma = (campo: keyof Calculada) => p.aplicadas.reduce((s, a) => s.plus(a[campo]), new Decimal(0));
  const cxc = { original: suma('monto_cobro'), ves: suma('monto_partida'), usd: suma('usd_partida') };
  // Diferencia entre lo que sale de cuentas por cobrar (valor de la factura) y el valor en los libros de lo cobrado.
  const difVes = cxc.ves.minus(suma('base_ves'));
  const difUsd = cxc.usd.minus(suma('base_usd'));
  const positivo = (d: Decimal) => (d.isPositive() ? d : new Decimal(0));
  const negativo = (d: Decimal) => (d.isNegative() ? d.abs() : new Decimal(0));
  const par = (ves: Decimal, usd: Decimal) => ({ ves: dos(ves), usd: dos(usd) });
  const cero = new Decimal(0);

  const dobles: Record<string, { ves: string; usd: string; original?: string }> = {
    cxc: { ...par(cxc.ves, cxc.usd), original: dos(cxc.original) },
    anticipo: p.anticipo,
    dif_perdida_ves: par(positivo(difVes), cero), dif_perdida_usd: par(cero, positivo(difUsd)),
    dif_ganancia_ves: par(negativo(difVes), cero), dif_ganancia_usd: par(cero, negativo(difUsd)),
  };
  if (p.banco) dobles.banco = p.banco;
  const r = await contabilizar(tx, {
    evento: p.evento, fecha: p.fecha, descripcion: p.descripcion, origen: p.origen, moneda: p.moneda, importes: {},
    importesDobles: dobles, cuentas: p.cuentaBanco ? { banco: p.cuentaBanco } : undefined, terceroId: p.clienteId, usuarioId: u.id,
  });
  return r.numero;
}

async function insertarAplicaciones(
  tx: Db, cobroId: string, origen: 'registro' | 'anticipo', fecha: string, aplicaciones: AplicacionEntrada[],
): Promise<Calculada[]> {
  const calculadas: Calculada[] = [];
  for (const a of aplicaciones) {
    const { rows } = await tx.query<Calculada>(
      `insert into aplicacion_cobro (cobro_id, partida_id, origen, fecha, liquida, monto_cobro) values ($1, $2, $3, $4::date, $5, $6)
       returning id, monto_cobro::text, monto_partida::text, usd_partida::text, base_ves::text, base_usd::text`,
      [cobroId, a.partidaId, origen, fecha, a.liquida ?? false, a.monto]);
    calculadas.push(rows[0]);
  }
  return calculadas;
}

export interface ResultadoCobro { id: string; numero: string; asiento: string; anticipo: string }

/** Registra un cobro, lo aplica a las facturas indicadas (lo demás queda como anticipo) y genera su asiento. */
export async function registrarCobro(tx: Db, u: Usuario, d: DatosCobro): Promise<ResultadoCobro> {
  if (!FECHA.test(d.fecha)) throw new ErrorMaestro('Indique la fecha del cobro.');
  const monto = normalizarMonto(d.monto, 'Monto del cobro');
  const aplicaciones = validarAplicaciones(d.aplicaciones ?? []);
  const aplicado = aplicaciones.reduce((s, a) => s.plus(a.monto), new Decimal(0));
  if (aplicado.gt(monto)) throw new ErrorMaestro(`Lo que se aplica (${dos(aplicado)}) supera el monto del cobro (${monto}).`);

  const { rows: cuenta } = await tx.query<{ cuenta_contable_id: string; moneda: string }>(
    'select cuenta_contable_id, moneda from cuenta_bancaria where id = $1', [d.cuentaBancariaId]);
  if (!cuenta[0]) throw new ErrorMaestro('Seleccione la cuenta donde entró el cobro.');

  const { rows } = await tx.query<{ id: string; numero: string }>(
    // La tasa BCV, los valores en VES y USD y lo que falta por aplicar los fija la base de datos al insertar.
    `insert into cobro (cliente_id, fecha, instrumento_id, cuenta_bancaria_id, referencia, moneda, monto, observaciones, created_by)
     values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) returning id, numero::text`,
    [d.clienteId, d.fecha, d.instrumentoId, d.cuentaBancariaId, d.referencia ?? null, cuenta[0].moneda, monto, d.observaciones?.trim() || null, u.id]);
  const cobro = rows[0];
  const calculadas = await insertarAplicaciones(tx, cobro.id, 'registro', d.fecha, aplicaciones);

  const { rows: c } = await tx.query<{ monto: string; monto_ves: string; monto_usd: string; por_aplicar: string; por_aplicar_ves: string; por_aplicar_usd: string; razon: string }>(
    `select c.monto::text, c.monto_ves::text, c.monto_usd::text, c.por_aplicar::text, c.por_aplicar_ves::text, c.por_aplicar_usd::text,
            t.razon_social as razon
       from cobro c join tercero t on t.id = c.cliente_id where c.id = $1`, [cobro.id]);
  const asiento = await asentar(tx, u, {
    evento: 'cobro', fecha: d.fecha, moneda: cuenta[0].moneda, descripcion: `Cobro N° ${cobro.numero} · ${c[0].razon}`,
    origen: { tipo: 'cobro', id: cobro.id }, clienteId: d.clienteId, cuentaBanco: cuenta[0].cuenta_contable_id, aplicadas: calculadas,
    banco: { original: c[0].monto, ves: c[0].monto_ves, usd: c[0].monto_usd },
    anticipo: { original: c[0].por_aplicar, ves: c[0].por_aplicar_ves, usd: c[0].por_aplicar_usd },
  });
  return { id: cobro.id, numero: cobro.numero, asiento, anticipo: c[0].por_aplicar };
}

/** Aplica lo que queda de un cobro (su anticipo) a facturas del mismo cliente, y genera el asiento de la aplicación. */
export async function aplicarAnticipo(
  tx: Db, u: Usuario, cobroId: string, d: { fecha?: string; aplicaciones: AplicacionEntrada[] },
): Promise<{ asiento: string; anticipo: string }> {
  const aplicaciones = validarAplicaciones(d.aplicaciones);
  if (!aplicaciones.length) throw new ErrorMaestro('Indique a qué facturas se aplica el anticipo.');
  const { rows } = await tx.query<{ estado: string; cliente_id: string; moneda: string; por_aplicar: string; numero: string; razon: string; hoy: string }>(
    `select c.estado, c.cliente_id, c.moneda, c.por_aplicar::text, c.numero::text, t.razon_social as razon,
            ((now() at time zone 'America/Caracas')::date)::text as hoy
       from cobro c join tercero t on t.id = c.cliente_id where c.id = $1 for update of c`, [cobroId]);
  const c = rows[0];
  if (!c) throw new ErrorMaestro('El cobro no existe.');
  if (c.estado !== 'registrado') throw new ErrorMaestro('Solo se aplica un cobro registrado y no conciliado.');
  if (new Decimal(c.por_aplicar).lte(0)) throw new ErrorMaestro('Este cobro no tiene anticipo por aplicar.');
  const fecha = d.fecha ?? c.hoy;
  if (!FECHA.test(fecha)) throw new ErrorMaestro('Indique la fecha de la aplicación.');

  const calculadas = await insertarAplicaciones(tx, cobroId, 'anticipo', fecha, aplicaciones);
  const suma = (campo: keyof Calculada) => calculadas.reduce((s, a) => s.plus(a[campo]), new Decimal(0));
  const asiento = await asentar(tx, u, {
    evento: 'aplicacion_anticipo', fecha, moneda: c.moneda, descripcion: `Aplicación del anticipo del cobro N° ${c.numero} · ${c.razon}`,
    origen: { tipo: 'aplicacion_cobro', id: calculadas[0].id }, clienteId: c.cliente_id, aplicadas: calculadas,
    anticipo: { original: dos(suma('monto_cobro')), ves: dos(suma('base_ves')), usd: dos(suma('base_usd')) },
  });
  const { rows: resto } = await tx.query<{ por_aplicar: string }>('select por_aplicar::text from cobro where id = $1', [cobroId]);
  return { asiento, anticipo: resto[0].por_aplicar };
}

/** Anula un cobro: reverso del asiento y las facturas recuperan su saldo. Con un anticipo ya aplicado a facturas, no se anula. */
export async function anularCobro(tx: Db, u: Usuario, id: string, motivo: MotivoDocumento): Promise<void> {
  const { rows } = await tx.query<{ estado: string }>('select estado from cobro where id = $1 for update', [id]);
  if (!rows[0]) throw new ErrorMaestro('El cobro no existe.');
  if (rows[0].estado !== 'registrado') throw new ErrorMaestro(rows[0].estado === 'anulado' ? 'El cobro ya está anulado.' : 'Un cobro conciliado no se anula.');
  const texto = await textoDeAnulacion(tx, motivo);
  const { rows: a } = await tx.query<{ id: string }>(
    `select id from asiento where origen_tipo = 'cobro' and origen_id = $1 and tipo = 'automatico'`, [id]);
  if (!a[0]) throw new ErrorMaestro('El cobro no tiene asiento: avise al administrador.');
  await tx.query(`update cobro set estado = 'anulado', anulado_motivo = $2, anulado_motivo_id = $3 where id = $1`, [id, texto, motivo.motivoId]);
  await tx.query(
    `select fn_reversar_asiento($1, ((now() at time zone 'America/Caracas')::date), $2)`, [a[0].id, `Anulación del cobro: ${texto}`]);
}

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

const puedeVer = (u: Usuario) => u.roles.some((r) => (ROLES_VEN_COBROS as readonly string[]).includes(r));

export interface FilaCobro {
  id: string; numero: string; fecha: string; cliente_id: string; cliente_codigo: string; cliente: string; moneda: string; monto: string;
  por_aplicar: string; instrumento: string; cuenta: string; referencia: string | null; estado: string;
}

export async function buscarCobros(db: Db, u: Usuario, filtro: { estado?: string; texto?: string; clienteId?: string } = {}, limite = 100): Promise<FilaCobro[]> {
  if (!puedeVer(u)) return [];
  const { rows } = await db.query<FilaCobro>(
    `select c.id, c.numero::text, c.fecha::text, c.cliente_id, cl.codigo as cliente_codigo, t.razon_social as cliente, c.moneda, c.monto::text,
            c.por_aplicar::text, i.nombre as instrumento, cb.nombre as cuenta, c.referencia, c.estado
       from cobro c
       join cliente cl on cl.tercero_id = c.cliente_id
       join tercero t on t.id = c.cliente_id
       join instrumento_pago i on i.id = c.instrumento_id
       join cuenta_bancaria cb on cb.id = c.cuenta_bancaria_id
      where ($1 = '' or c.estado = $1) and ($3::uuid is null or c.cliente_id = $3)
        and ($2 = '' or c.numero::text = $2 or cl.codigo ilike '%' || $2 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($2) || '%'
             or upper(c.referencia) like '%' || upper($2) || '%')
      order by c.fecha desc, c.numero desc
      limit $4`, [filtro.estado ?? '', (filtro.texto ?? '').trim(), filtro.clienteId ?? null, limite]);
  return rows;
}

export interface AplicacionDetalle {
  id: string; origen: 'registro' | 'anticipo'; fecha: string; factura: string; partida_id: string; monto_cobro: string; monto_partida: string;
  usd_partida: string; base_ves: string; base_usd: string; dif_ves: string; dif_usd: string; revertida: boolean;
}

export interface DetalleCobro extends FilaCobro {
  cuenta_bancaria_id: string; tasa: string; monto_ves: string; monto_usd: string; por_aplicar_ves: string; por_aplicar_usd: string;
  observaciones: string | null; creador: string; creado: string; anulado_motivo: string | null; anulado: string | null;
  asiento: string | null; asiento_id: string | null; aplicaciones: AplicacionDetalle[];
}

export async function detalleCobro(db: Db, id: string): Promise<DetalleCobro | null> {
  const { rows } = await db.query<Omit<DetalleCobro, 'aplicaciones'>>(
    `select c.id, c.numero::text, c.fecha::text, c.cliente_id, cl.codigo as cliente_codigo, t.razon_social as cliente, c.moneda, c.monto::text,
            c.por_aplicar::text, i.nombre as instrumento, cb.nombre as cuenta, c.referencia, c.estado, c.cuenta_bancaria_id,
            c.tasa::text, c.monto_ves::text, c.monto_usd::text, c.por_aplicar_ves::text, c.por_aplicar_usd::text, c.observaciones,
            u.nombre as creador, to_char(c.created_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as creado, c.anulado_motivo,
            to_char(c.anulado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as anulado,
            a.numero::text as asiento, a.id as asiento_id
       from cobro c
       join cliente cl on cl.tercero_id = c.cliente_id
       join tercero t on t.id = c.cliente_id
       join instrumento_pago i on i.id = c.instrumento_id
       join cuenta_bancaria cb on cb.id = c.cuenta_bancaria_id
       join usuario u on u.id = c.created_by
       left join asiento a on a.origen_tipo = 'cobro' and a.origen_id = c.id and a.tipo = 'automatico'
      where c.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: aplicaciones } = await db.query<AplicacionDetalle>(
    `select ap.id, ap.origen, ap.fecha::text, d.serie || '-' || d.numero as factura, ap.partida_id, ap.monto_cobro::text, ap.monto_partida::text,
            ap.usd_partida::text, ap.base_ves::text, ap.base_usd::text, (ap.monto_partida - ap.base_ves)::text as dif_ves,
            (ap.usd_partida - ap.base_usd)::text as dif_usd, ap.revertida
       from aplicacion_cobro ap
       join partida_cxc p on p.id = ap.partida_id
       join documento_venta d on d.id = p.documento_id
      where ap.cobro_id = $1 order by ap.created_at, ap.id`, [id]);
  return { ...rows[0], aplicaciones };
}

export interface PartidaAbierta {
  partida_id: string; factura: string; fecha: string; vencimiento: string; saldo: string; saldo_usd: string; dias_vencida: number; tramo: string;
}

/** Facturas con saldo por cobrar de un cliente, de la más antigua a la más reciente. */
export async function partidasAbiertas(db: Db, clienteId: string): Promise<PartidaAbierta[]> {
  const { rows } = await db.query<PartidaAbierta>(
    `select partida_id, factura, fecha::text, vencimiento::text, saldo::text, saldo_usd::text, dias_vencida::int, tramo
       from vw_cxc_antiguedad where cliente_id = $1 order by vencimiento, fecha, factura`, [clienteId]);
  return rows;
}

export const TRAMOS_CXC = ['por_vencer', 'v_1_30', 'v_31_60', 'v_61_90', 'v_mas_90'] as const;
export type TramoCxC = (typeof TRAMOS_CXC)[number];
export const NOMBRE_TRAMO: Record<TramoCxC, string> = {
  por_vencer: 'Por vencer', v_1_30: '1 a 30 días', v_31_60: '31 a 60 días', v_61_90: '61 a 90 días', v_mas_90: 'Más de 90 días',
};

export interface FilaCxC {
  cliente_id: string; codigo: string; cliente: string; facturas: number; saldo_ves: string; saldo_usd: string;
  tramos: Record<TramoCxC, string>; anticipos_usd: string;
}

/** Cuentas por cobrar por cliente: saldo en bolívares y USD, antigüedad en USD y anticipos sin aplicar. */
export async function resumenCxC(db: Db, u: Usuario, texto = ''): Promise<FilaCxC[]> {
  if (!puedeVer(u)) return [];
  const { rows } = await db.query<Omit<FilaCxC, 'tramos'> & Record<TramoCxC, string>>(
    `select a.cliente_id, cl.codigo, t.razon_social as cliente, count(*)::int as facturas, sum(a.saldo)::text as saldo_ves, sum(a.saldo_usd)::text as saldo_usd,
            coalesce(sum(a.saldo_usd) filter (where a.tramo = 'por_vencer'), 0)::numeric(16,2)::text as por_vencer,
            coalesce(sum(a.saldo_usd) filter (where a.tramo = 'v_1_30'), 0)::numeric(16,2)::text as v_1_30,
            coalesce(sum(a.saldo_usd) filter (where a.tramo = 'v_31_60'), 0)::numeric(16,2)::text as v_31_60,
            coalesce(sum(a.saldo_usd) filter (where a.tramo = 'v_61_90'), 0)::numeric(16,2)::text as v_61_90,
            coalesce(sum(a.saldo_usd) filter (where a.tramo = 'v_mas_90'), 0)::numeric(16,2)::text as v_mas_90,
            coalesce((select sum(c.por_aplicar_usd) from cobro c where c.cliente_id = a.cliente_id and c.estado <> 'anulado'), 0)::numeric(16,2)::text as anticipos_usd
       from vw_cxc_antiguedad a
       join cliente cl on cl.tercero_id = a.cliente_id
       join tercero t on t.id = a.cliente_id
      where ($1 = '' or cl.codigo ilike '%' || $1 || '%' or fn_nombre_normalizado(t.razon_social) like '%' || fn_nombre_normalizado($1) || '%')
      group by a.cliente_id, cl.codigo, t.razon_social
      order by sum(a.saldo_usd) desc`, [texto.trim()]);
  return rows.map((r) => ({
    cliente_id: r.cliente_id, codigo: r.codigo, cliente: r.cliente, facturas: r.facturas, saldo_ves: r.saldo_ves, saldo_usd: r.saldo_usd, anticipos_usd: r.anticipos_usd,
    tramos: { por_vencer: r.por_vencer, v_1_30: r.v_1_30, v_31_60: r.v_31_60, v_61_90: r.v_61_90, v_mas_90: r.v_mas_90 },
  }));
}

export interface CuadreCxC {
  auxiliar_ves: string; auxiliar_usd: string; mayor_ves: string; mayor_usd: string;
  anticipos_auxiliar_ves: string; anticipos_auxiliar_usd: string; anticipos_mayor_ves: string; anticipos_mayor_usd: string;
  cuadra: boolean;
}

/**
 * Auxiliar contra mayor (criterio de aceptación de §6.3): la suma de saldos de las partidas abiertas contra la cuenta Cuentas por cobrar
 * comerciales, y los anticipos sin aplicar contra Anticipos de clientes, en bolívares y en USD, al centavo.
 */
export async function cuadreCxC(db: Db): Promise<CuadreCxC> {
  const { rows } = await db.query<Omit<CuadreCxC, 'cuadra'>>(
    `select coalesce((select sum(saldo) from partida_cxc where estado = 'abierta'), 0)::text as auxiliar_ves,
            coalesce((select sum(saldo_usd) from partida_cxc where estado = 'abierta'), 0)::text as auxiliar_usd,
            coalesce((select sum(l.debe_ves - l.haber_ves) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                       join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '1.2.01'), 0)::text as mayor_ves,
            coalesce((select sum(l.debe_usd - l.haber_usd) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                       join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '1.2.01'), 0)::text as mayor_usd,
            coalesce((select sum(por_aplicar_ves) from cobro where estado <> 'anulado'), 0)::text as anticipos_auxiliar_ves,
            coalesce((select sum(por_aplicar_usd) from cobro where estado <> 'anulado'), 0)::text as anticipos_auxiliar_usd,
            coalesce((select sum(l.haber_ves - l.debe_ves) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                       join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '2.1.08'), 0)::text as anticipos_mayor_ves,
            coalesce((select sum(l.haber_usd - l.debe_usd) from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
                       join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '2.1.08'), 0)::text as anticipos_mayor_usd`);
  const r = rows[0];
  const igual = (a: string, b: string) => new Decimal(a).equals(b);
  return {
    ...r,
    cuadra: igual(r.auxiliar_ves, r.mayor_ves) && igual(r.auxiliar_usd, r.mayor_usd)
      && igual(r.anticipos_auxiliar_ves, r.anticipos_mayor_ves) && igual(r.anticipos_auxiliar_usd, r.anticipos_mayor_usd),
  };
}
