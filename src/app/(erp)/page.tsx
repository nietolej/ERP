import Link from 'next/link';
import { GraficoVentasMensuales } from '@/components/grafico-ventas';
import { Aviso, Encabezado, KpiCard, Panel, Paso } from '@/components/ui';
import { exigirSesion } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto, tasa } from '@/lib/formato';
import {
  clientesActivos90Dias, cobranzaPendiente, productosEnQuiebre, ventaMensualConMeta, ventaMes,
} from '@/lib/reportes/inicio';

/**
 * Inicio. Las tarjetas de configuración salen de la §14.2 de la especificación principal; las tarjetas
 * comerciales y el gráfico de venta mensual salen de spec_reportes §3, con las vistas de la §12.
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

  const [venta, clientes, quiebres, cobranza, ventaMensual] = await Promise.all([
    ventaMes(db), clientesActivos90Dias(db), productosEnQuiebre(db), cobranzaPendiente(db), ventaMensualConMeta(db, 6),
  ]);
  const signoVariacion = venta.variacionPct === null ? '' : venta.variacionPct >= 0 ? '+' : '';

  return (
    <>
      <Encabezado titulo={`Bienvenido, ${u.nombre}`} descripcion="Dashboard central · Distribuciones Hanei Motors" />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard titulo="Ventas del mes" valor={monto(venta.ventaUsd, 'US$ ')}
          subtitulo={venta.variacionPct === null ? 'Sin venta en el mismo tramo del mes anterior' :
            `${signoVariacion}${venta.variacionPct.toFixed(1)} % vs. mismos días del mes anterior`} />
        <KpiCard titulo="Clientes activos" valor={String(clientes)} subtitulo="Con compras en los últimos 90 días" />
        <KpiCard titulo="Productos en quiebre" valor={String(quiebres)} tono={quiebres > 0 ? 'peligro' : 'exito'}
          subtitulo="Riesgo de quiebre (stock comercial)" />
        <KpiCard titulo="Cobranza pendiente" valor={monto(cobranza.deudaUsd, 'US$ ')} tono={Number(cobranza.vencidoUsd) > 0 ? 'advertencia' : undefined}
          subtitulo={`(${monto(cobranza.vencidoUsd, 'US$ ')} vencido)`} />
      </div>

      <Panel titulo="Rendimiento global de ventas" className="mb-5">
        {ventaMensual.every((m) => Number(m.ventaUsd) === 0) ? (
          <Aviso>Todavía no hay facturas emitidas. El gráfico se llena a medida que se registran ventas.</Aviso>
        ) : (
          <GraficoVentasMensuales datos={ventaMensual.map((m) => ({
            anio: m.anio, mes: m.mes, venta: Number(m.ventaUsd), meta: m.metaUsd === null ? null : Number(m.metaUsd),
          }))} />
        )}
      </Panel>

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
          <Panel titulo="Accesos rápidos">
            <div className="flex flex-col gap-2 text-sm">
              <Link href="/reportes/inventario" className="font-semibold text-acento hover:underline">Sugerido de compras →</Link>
              <Link href="/reportes/cobranzas" className="font-semibold text-acento hover:underline">Análisis de cartera →</Link>
              <Link href="/reportes/devoluciones" className="font-semibold text-acento hover:underline">Auditoría de calidad →</Link>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
