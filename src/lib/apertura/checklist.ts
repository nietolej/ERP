import type { Db } from '@/lib/db/tipos';
import { PROVEEDOR_SIMULADO } from '@/lib/fiscal/imprenta';
import { ErrorMaestro } from '@/lib/errores';
import { controlApertura } from './apertura';

/**
 * Checklist de arranque (spec §14.6; migración 0050). Cada punto se comprueba solo cuando el sistema puede hacerlo (configuración, conteos,
 * saldos, usuarios, primera factura) y, cuando depende de una persona, se confirma con su responsable, fecha y nota. Las firmas de Gerencia y
 * del contador solo se permiten con todo lo demás en orden.
 */

export type CodigoConfirmacion = 'configuracion' | 'bancos' | 'cartera' | 'capacitacion' | 'respaldo' | 'firma_gerencia' | 'firma_contador';
export type UsuarioChecklist = { id: string; roles: readonly string[] };

export const ROLES_CONFIRMAN: Record<CodigoConfirmacion, readonly string[]> = {
  configuracion: ['contabilidad', 'jefe_contabilidad', 'gerencia'],
  bancos: ['tesoreria', 'gerencia'],
  cartera: ['contabilidad', 'jefe_contabilidad', 'gerencia'],
  capacitacion: ['gerencia', 'administrador'],
  respaldo: ['administrador', 'gerencia'],
  firma_gerencia: ['gerencia'],
  firma_contador: ['contabilidad', 'jefe_contabilidad'],
};
export const ROLES_VEN_CHECKLIST = ['administrador', 'gerencia', 'contabilidad', 'jefe_contabilidad', 'tesoreria', 'cobranzas', 'compras', 'almacen', 'auditor'] as const;

export interface Confirmacion { codigo: CodigoConfirmacion; por: string; el: string; nota: string | null; id: string }

export interface PuntoChecklist {
  codigo: string;
  titulo: string;
  /** Lo que el sistema comprueba solo. */
  automatico: { ok: boolean; detalle: string } | null;
  /** Lo que una persona confirma (con su responsable). */
  confirmacion: { codigo: CodigoConfirmacion; roles: readonly string[]; hecha: Confirmacion | null } | null;
  listo: boolean;
  enlace?: { texto: string; href: string };
}

export interface Checklist {
  puntos: PuntoChecklist[];
  firmas: { gerencia: Confirmacion | null; contador: Confirmacion | null };
  todoListo: boolean;
  firmado: boolean;
}

async function confirmaciones(db: Db): Promise<Map<CodigoConfirmacion, Confirmacion>> {
  const { rows } = await db.query<{ id: string; codigo: CodigoConfirmacion; por: string; el: string; nota: string | null }>(
    `select c.id, c.codigo, u.nombre as por, to_char(c.confirmado_at at time zone 'America/Caracas', 'DD-MM-YYYY HH24:MI') as el, c.nota
       from arranque_confirmacion c join usuario u on u.id = c.confirmado_por where c.retirada_at is null`);
  return new Map(rows.map((r) => [r.codigo, { id: r.id, codigo: r.codigo, por: r.por, el: r.el, nota: r.nota }]));
}

/** Calcula el checklist con el estado de hoy. */
export async function checklist(db: Db): Promise<Checklist> {
  const conf = await confirmaciones(db);
  const ctl = await controlApertura(db);
  const num = async (sql: string, p: unknown[] = []) => Number((await db.query<{ n: string }>(sql, p)).rows[0].n);

  // 1. Configuración del día 0
  const empresa = await num('select count(*)::text as n from empresa');
  const sucursales = await num('select count(*)::text as n from sucursal where activa');
  const tasa = await num(`select count(*)::text as n from tasa_cambio where moneda = 'USD'`);
  const fiscales = (await db.query<{ v: string; t: string }>(`select count(*) filter (where validado_por_contador)::text as v, count(*)::text as t from parametro_fiscal`)).rows[0];
  const fecha = ctl.impedimentos.every((i) => !i.includes('fecha de arranque'));
  const faltan: string[] = [];
  if (!empresa) faltan.push('datos de la empresa');
  if (!sucursales) faltan.push('sucursales');
  if (!tasa) faltan.push('tasa BCV');
  if (fiscales.v !== fiscales.t) faltan.push(`parámetros fiscales sin validar (${fiscales.v} de ${fiscales.t})`);
  if (!fecha) faltan.push('fecha de arranque');
  const configOk = faltan.length === 0;

  // 2. Conteo de inventario en todos los almacenes
  const sinConteo = await num(
    `select count(*)::text as n from almacen a where a.activo and a.es_comercial
        and not exists (select 1 from apertura_inventario o where o.almacen_id = a.id and o.estado = 'aprobado')`);
  const conteos = await num(`select count(*)::text as n from apertura_inventario where estado = 'aprobado'`);

  // 3. Bancos y cajas
  const sinSaldo = await num(
    `select count(*)::text as n from cuenta_bancaria c where c.activa and not exists (select 1 from apertura_banco o where o.cuenta_bancaria_id = c.id and o.estado = 'aprobado')`);
  const bancosOk = ctl.pendientes === 0 && ctl.totales.find((t) => t.tipo === 'banco')!.documentos > 0;

  // 4. Cuentas por cobrar y por pagar
  const cxc = ctl.totales.find((t) => t.tipo === 'cxc')!.documentos;
  const cxp = ctl.totales.find((t) => t.tipo === 'cxp')!.documentos;

  // 5. Asiento de apertura y control
  const puenteOk = ctl.saldoPuenteVes === '0.00' && ctl.mayorCuadra && ctl.pendientes === 0 && ctl.totales.some((t) => t.documentos > 0);

  // 6. Primera factura fiscal con número de control válido
  const real = await num(
    `select count(*)::text as n from documento_venta where tipo = 'factura' and estado = 'emitido' and not apertura and numero_control is not null and coalesce(imprenta, '') <> $1`, [PROVEEDOR_SIMULADO]);
  const simulada = await num(
    `select count(*)::text as n from documento_venta where tipo = 'factura' and estado = 'emitido' and not apertura and numero_control is not null and imprenta = $1`, [PROVEEDOR_SIMULADO]);

  // 7. Usuarios
  const sinCambiar = await num('select count(*)::text as n from usuario where activo and debe_cambiar_password');
  const usuarios = await num('select count(*)::text as n from usuario where activo');

  const puntos: PuntoChecklist[] = [];
  const agrega = (p: Omit<PuntoChecklist, 'listo'> & { listo?: boolean }) => {
    const hecha = p.confirmacion?.hecha ?? null;
    const listo = p.listo ?? ((p.automatico?.ok ?? true) && (p.confirmacion ? hecha !== null : true));
    puntos.push({ ...p, listo });
  };
  const confirma = (codigo: CodigoConfirmacion) => ({ codigo, roles: ROLES_CONFIRMAN[codigo], hecha: conf.get(codigo) ?? null });

  agrega({
    codigo: 'configuracion', titulo: 'Configuración del día 0 completa y revisada por el contador',
    automatico: { ok: configOk, detalle: configOk ? 'Empresa, sucursales, tasa, parámetros fiscales validados y fecha de arranque.' : `Falta: ${faltan.join(', ')}.` },
    confirmacion: confirma('configuracion'), enlace: { texto: 'Parámetros fiscales', href: '/configuracion/parametros-fiscales' },
  });
  agrega({
    codigo: 'inventario', titulo: 'Conteo físico inicial registrado y aprobado en todos los almacenes',
    automatico: { ok: sinConteo === 0 && conteos > 0, detalle: conteos === 0 ? 'Todavía no hay conteos aprobados.' : sinConteo === 0 ? `${conteos} conteos aprobados.` : `Faltan ${sinConteo} almacenes comerciales sin conteo aprobado.` },
    confirmacion: null, enlace: { texto: 'Conteo inicial', href: '/inventario/apertura' },
  });
  agrega({
    codigo: 'bancos', titulo: 'Saldos iniciales de bancos y cajas registrados y cuadrados con los estados de cuenta',
    automatico: { ok: bancosOk, detalle: ctl.totales.find((t) => t.tipo === 'banco')!.documentos === 0 ? 'Todavía no hay saldos de bancos o cajas aprobados.' : sinSaldo === 0 ? 'Todas las cuentas activas tienen su saldo aprobado.' : `${sinSaldo} cuentas activas sin saldo aprobado (una cuenta en cero no necesita documento).` },
    confirmacion: confirma('bancos'), enlace: { texto: 'Apertura', href: '/configuracion/apertura' },
  });
  agrega({
    codigo: 'cartera', titulo: 'Cuentas por cobrar y por pagar abiertas registradas factura por factura y cuadradas con los totales conocidos',
    automatico: { ok: ctl.pendientes === 0 && cxc + cxp > 0, detalle: `${cxc} facturas por cobrar y ${cxp} por pagar aprobadas${ctl.pendientes ? `; ${ctl.pendientes} documentos sin aprobar` : ''}.` },
    confirmacion: confirma('cartera'), enlace: { texto: 'Apertura', href: '/configuracion/apertura' },
  });
  agrega({
    codigo: 'apertura', titulo: 'Asiento de apertura del contador registrado; «Saldos de apertura» en cero y balance cuadrado',
    automatico: { ok: puenteOk, detalle: puenteOk ? 'Saldos de apertura en cero y el mayor cuadra.' : ctl.impedimentos.filter((i) => !i.includes('fecha')).join(' ') || 'Pendiente.' },
    confirmacion: null, enlace: { texto: 'Control de cierre', href: '/configuracion/apertura' },
  });
  agrega({
    codigo: 'factura', titulo: 'Primera factura fiscal emitida con número de control válido',
    automatico: {
      ok: real > 0,
      detalle: real > 0 ? `${real} facturas con número de control de imprenta.` : simulada > 0 ? 'Solo hay facturas con el simulador de pruebas (sin validez fiscal): falta la imprenta real.' : 'Todavía no se ha emitido ninguna factura.',
    },
    confirmacion: null, enlace: { texto: 'Facturas', href: '/ventas/facturas' },
  });
  agrega({
    codigo: 'usuarios', titulo: 'Usuarios capacitados por rol y contraseñas iniciales cambiadas',
    automatico: { ok: sinCambiar === 0 && usuarios > 0, detalle: sinCambiar === 0 ? `${usuarios} usuarios activos con su contraseña propia.` : `${sinCambiar} de ${usuarios} usuarios activos todavía tienen la contraseña inicial.` },
    confirmacion: confirma('capacitacion'), enlace: { texto: 'Usuarios', href: '/configuracion/usuarios' },
  });
  agrega({
    codigo: 'respaldo', titulo: 'Respaldo automático de la base de datos probado (respaldo y restauración)',
    automatico: null, confirmacion: confirma('respaldo'),
  });

  const todoListo = puntos.every((p) => p.listo);
  const firmas = { gerencia: conf.get('firma_gerencia') ?? null, contador: conf.get('firma_contador') ?? null };
  return { puntos, firmas, todoListo, firmado: Boolean(firmas.gerencia && firmas.contador) };
}

/** Confirma un punto (o firma). Cada código lo hace solo su rol; las firmas exigen todo lo demás en orden. */
export async function confirmar(tx: Db, u: UsuarioChecklist, codigo: CodigoConfirmacion, nota?: string): Promise<void> {
  const roles = ROLES_CONFIRMAN[codigo];
  if (!roles) throw new ErrorMaestro('Confirmación desconocida.');
  if (!u.roles.some((r) => roles.includes(r))) throw new ErrorMaestro('Su rol no puede hacer esa confirmación.');
  if (codigo === 'firma_gerencia' || codigo === 'firma_contador') {
    const c = await checklist(tx);
    if (!c.todoListo) throw new ErrorMaestro('Antes de firmar, todos los puntos del checklist deben estar en orden.');
  }
  const { rows } = await tx.query('select 1 from arranque_confirmacion where codigo = $1 and retirada_at is null', [codigo]);
  if (rows.length) throw new ErrorMaestro('Esa confirmación ya está hecha.');
  await tx.query('insert into arranque_confirmacion (codigo, nota, confirmado_por) values ($1, nullif(trim($2), \'\'), $3)', [codigo, nota ?? '', u.id]);
}

/** Gerencia retira una confirmación (con motivo): también las firmas, que se vuelven a pedir. */
export async function retirarConfirmacion(tx: Db, u: UsuarioChecklist, id: string, motivo: string): Promise<void> {
  if (!u.roles.includes('gerencia')) throw new ErrorMaestro('Solo Gerencia retira una confirmación.');
  if (motivo.trim().length < 3) throw new ErrorMaestro('Indique el motivo.');
  const { rows } = await tx.query('update arranque_confirmacion set retirada_motivo = $2, retirada_por = $3 where id = $1 and retirada_at is null returning id', [id, motivo.trim(), u.id]);
  if (!rows[0]) throw new ErrorMaestro('La confirmación no existe o ya fue retirada.');
  // Un cambio en el checklist invalida las firmas ya dadas.
  await tx.query(`update arranque_confirmacion set retirada_motivo = 'Se retiró otra confirmación del checklist', retirada_por = $1 where codigo in ('firma_gerencia', 'firma_contador') and retirada_at is null and id <> $2`, [u.id, id]);
}
