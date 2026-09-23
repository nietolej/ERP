import Link from 'next/link';
import { Aviso, Encabezado, Panel, Paso } from '@/components/ui';
import { exigirSesion } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, tasa } from '@/lib/formato';

/**
 * Inicio. Las tarjetas comerciales (ventas del mes, clientes activos, quiebres, cobranza)
 * se habilitan en la Fase 2 (spec_reportes §3). En la Fase 0 se muestra el estado real
 * de la configuración necesaria para el arranque (§14.2 de la especificación).
 */
export default async function InicioPage() {
  const u = await exigirSesion();
  const db = await getDb();
  const hoy = hoyCaracas();
  const anio = Number(hoy.slice(0, 4));

  const { rows } = await db.query<{
    empresa: string | null; sucursales: string; usuarios: string; periodos: string;
    param_total: string; param_validados: string; tasa_fecha: string | null; tasa_valor: string | null; cuadre_ves: string;
  }>(
    `select (select razon_social from empresa) as empresa,
            (select count(*) from sucursal where activa) as sucursales,
            (select count(*) from usuario where activo) as usuarios,
            (select count(*) from periodo_contable where anio = $2) as periodos,
            (select count(*) from parametro_fiscal where vigente_hasta is null or vigente_hasta >= $1::date) as param_total,
            (select count(*) from parametro_fiscal where validado_por_contador and (vigente_hasta is null or vigente_hasta >= $1::date)) as param_validados,
            (select max(fecha) from tasa_cambio where moneda = 'USD' and fuente = 'BCV') as tasa_fecha,
            (select tasa from tasa_cambio where moneda = 'USD' and fuente = 'BCV' order by fecha desc limit 1) as tasa_valor,
            (select diferencia_ves from vw_control_cuadre) as cuadre_ves`,
    [hoy, anio],
  );
  const e = rows[0];
  const tasaAlDia = e.tasa_fecha === hoy;

  return (
    <>
      <Encabezado titulo={`Bienvenido, ${u.nombre}`} descripcion="Dashboard central · Distribuciones Hanei Motors" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel titulo="Configuración para el arranque (día 0)">
          <ul className="divide-y divide-borde">
            <Paso listo={Boolean(e.empresa)} titulo="Datos de la empresa"
              detalle={e.empresa ?? 'Pendiente: RIF, razón social y condición fiscal.'} />
            <Paso listo={Number(e.sucursales) > 0} titulo="Sucursales"
              detalle={Number(e.sucursales) > 0 ? `${e.sucursales} activa(s)` : 'Pendiente: Barquisimeto, Caracas…'} />
            <Paso listo={Number(e.periodos) >= 13} titulo={`Periodos contables ${anio}`}
              detalle={Number(e.periodos) >= 13 ? '12 meses + periodo de cierre creados' : 'Pendiente: crear los periodos del año.'} />
            <Paso listo={tasaAlDia} titulo="Tasa BCV del día (USD)"
              detalle={e.tasa_fecha ? `Última: ${tasa(e.tasa_valor!)} Bs/USD del ${fecha(e.tasa_fecha)}${tasaAlDia ? '' : ' — registre la de hoy'}` : 'Pendiente: no hay tasas registradas.'} />
            <Paso listo={Number(e.param_validados) === Number(e.param_total) && Number(e.param_total) > 0} titulo="Parámetros fiscales validados por el contador"
              detalle={`${e.param_validados} de ${e.param_total} validados`} />
            <Paso listo={Number(e.usuarios) > 1} titulo="Usuarios y roles"
              detalle={`${e.usuarios} usuario(s) activo(s)`} />
          </ul>
        </Panel>

        <div className="space-y-5">
          <Panel titulo="Control de integridad contable">
            {e.cuadre_ves === '0.00' || e.cuadre_ves === '0' ? (
              <Aviso tono="exito">El mayor cuadra: la suma del debe es igual a la del haber.</Aviso>
            ) : (
              <Aviso tono="peligro">Diferencia en el mayor de {e.cuadre_ves} VES. Avise a Contabilidad y al administrador.</Aviso>
            )}
          </Panel>
          <Panel titulo="Indicadores comerciales">
            <p className="text-sm text-texto-2">
              Ventas del mes, clientes activos, productos en quiebre y cobranza pendiente aparecen aquí cuando
              se registren las primeras operaciones (Fase 2: ventas, cobros e inventario).
            </p>
            <Link href="/reportes/clientes" className="mt-3 inline-block text-sm font-semibold text-acento">Ver módulos de reportes →</Link>
          </Panel>
        </div>
      </div>
    </>
  );
}
