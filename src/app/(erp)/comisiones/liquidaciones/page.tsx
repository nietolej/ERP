import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Campo, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { ROLES_LIQUIDAN, ROLES_VEN_COMISIONES, listarLiquidaciones } from '@/lib/comisiones/comisiones';
import { getDb } from '@/lib/db';
import { hoyCaracas, monto } from '@/lib/formato';
import { generarLiquidacionesAccion } from '../acciones';

const TONO = { pendiente: 'advertencia', aprobada: 'info', pagada: 'exito', rechazada: 'peligro' } as const;

function mesPasado(): string {
  const [a, m] = hoyCaracas().split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

export default async function LiquidacionesPage() {
  const u = await exigirRol(...ROLES_VEN_COMISIONES);
  const filas = await listarLiquidaciones(await getDb(), u);
  return (
    <>
      <Encabezado titulo="Liquidación de comisiones" descripcion="Al cierre de cada mes se arma una liquidación por vendedor con lo devengado y revertido sin liquidar. Gerencia la aprueba (no el vendedor beneficiario) y Tesorería la paga.">
        <Link href="/comisiones" className="text-sm text-texto-2 hover:text-texto">← Estado de comisiones</Link>
      </Encabezado>
      {tieneRol(u, ROLES_LIQUIDAN) && (
        <Panel titulo="Armar las liquidaciones de un mes" className="mb-5">
          <Formulario accion={generarLiquidacionesAccion} className="flex flex-wrap items-end gap-3">
            <Campo etiqueta="Mes (ya terminado)"><input type="month" name="periodo" defaultValue={mesPasado()} required className="campo" /></Campo>
            <BotonEnviar>Armar y enviar a Gerencia</BotonEnviar>
          </Formulario>
          <p className="mt-3 text-xs text-texto-2">Un vendedor con saldo negativo (más reversiones que devengos) no se liquida: su saldo se descuenta de la próxima liquidación y, si pasa de dos meses, se avisa.</p>
        </Panel>
      )}
      <Panel>
        <Tabla columnas={['N°', 'Vendedor', 'Mes', { t: 'Neto (US$)', derecha: true }, 'Estado']} vacio="Todavía no hay liquidaciones.">
          {filas.map((l) => (
            <tr key={l.id}>
              <Celda mono><Link href={`/comisiones/liquidaciones/${l.id}`} className="text-acento hover:underline">{l.numero}</Link></Celda>
              <Celda>{l.vendedor}</Celda><Celda>{l.periodo}</Celda><Celda derecha>{monto(l.netoUsd)}</Celda>
              <Celda><Etiqueta tono={TONO[l.estado as keyof typeof TONO] ?? 'info'}>{l.estado}</Etiqueta></Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
