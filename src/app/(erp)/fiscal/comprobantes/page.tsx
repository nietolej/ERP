import Link from 'next/link';
import { BotonEnviar, Formulario } from '@/components/formulario';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol, tieneRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { NOMBRE_IMPUESTO, ROLES_EMITEN_COMPROBANTES, ROLES_VEN_COMPROBANTES, resumenComprobantes } from '@/lib/fiscal/comprobantes';
import { fecha, monto } from '@/lib/formato';
import { leerPeriodo } from '../periodo';
import { emitirComprobantesAccion } from './acciones';

export default async function ComprobantesPage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMPROBANTES);
  const { periodo } = await searchParams;
  const p = leerPeriodo(periodo);
  const r = await resumenComprobantes(await getDb(), p.anio, p.mes);
  const hoy = new Date().toISOString().slice(0, 10);
  const vencido = r.pendientes.length > 0 && hoy > r.plazo;

  return (
    <>
      <Encabezado titulo="Comprobantes de retención de IVA e ISLR"
        descripcion="Un comprobante por cada retención practicada a un documento, con número de 14 caracteres (AAAAMM + 8 dígitos correlativos por impuesto y periodo). Contabilidad o Gerencia los emite por lotes del mes." />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Mes de la retención</span><input type="month" name="periodo" defaultValue={p.texto} className="campo" /></label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Ver</button>
        </form>
      </Panel>

      {r.pendientes.length > 0 && (
        <div className="mb-5"><Aviso tono={vencido ? 'peligro' : 'advertencia'}>
          Hay {r.pendientes.length} retenciones sin comprobante. El plazo de entrega es el segundo día hábil de {fecha(r.plazo)}{vencido ? ': ya venció' : ''} (no considera feriados).
        </Aviso></div>
      )}
      {r.ajustes.length > 0 && (
        <div className="mb-5"><Aviso tono="info">
          {r.ajustes.length === 1 ? 'Hay 1 retención revertida' : `Hay ${r.ajustes.length} retenciones revertidas`} por notas de crédito del proveedor: no se numeran todavía, a la espera de que el contador confirme cómo se documentan.
        </Aviso></div>
      )}

      {r.pendientes.length > 0 && (
        <Panel titulo={`Pendientes de comprobante (${r.pendientes.length})`} className="mb-5">
          <Tabla columnas={['Impuesto', 'Fecha', 'Proveedor', 'RIF', 'Documento', { t: 'Base', derecha: true }, { t: 'Retenido', derecha: true }]}>
            {r.pendientes.map((x) => (
              <tr key={x.retencion_id}>
                <Celda>{NOMBRE_IMPUESTO[x.impuesto]}</Celda>
                <Celda className="text-texto-2">{fecha(x.fecha)}</Celda>
                <Celda>{x.proveedor}</Celda>
                <Celda mono>{x.rif}</Celda>
                <Celda mono>{x.documento}</Celda>
                <Celda derecha mono>{x.moneda} {monto(x.base)}</Celda>
                <Celda derecha mono>{x.moneda} {monto(x.monto)}</Celda>
              </tr>
            ))}
          </Tabla>
          {tieneRol(u, ROLES_EMITEN_COMPROBANTES) && (
            <Formulario accion={emitirComprobantesAccion} className="mt-4 flex flex-wrap items-center gap-4">
              <input type="hidden" name="periodo" value={p.texto} />
              <BotonEnviar>Emitir los {r.pendientes.length} comprobantes del mes</BotonEnviar>
              <p className="text-xs text-texto-2">Se numeran en orden de fecha, correlativos y sin huecos. Un comprobante emitido no se modifica ni se borra.</p>
            </Formulario>
          )}
        </Panel>
      )}

      <Panel titulo={`Comprobantes emitidos (${r.emitidos.length})`}>
        <Tabla columnas={['N° de comprobante', 'Impuesto', 'Emisión', 'Proveedor', 'RIF', 'Documento', { t: 'Base', derecha: true }, { t: 'Retenido', derecha: true }]} vacio="No hay comprobantes emitidos en este mes.">
          {r.emitidos.map((c) => (
            <tr key={c.id} className="hover:bg-white/[0.03]">
              <Celda mono><Link href={`/fiscal/comprobantes/${c.id}`} className="text-acento hover:underline">{c.numero}</Link></Celda>
              <Celda><Etiqueta tono={c.impuesto === 'iva' ? 'info' : 'advertencia'}>{NOMBRE_IMPUESTO[c.impuesto]}</Etiqueta></Celda>
              <Celda className="text-texto-2">{c.fecha_emision}</Celda>
              <Celda>{c.proveedor}</Celda>
              <Celda mono>{c.rif}</Celda>
              <Celda mono>{c.documento}</Celda>
              <Celda derecha mono>{c.moneda} {monto(c.base)}</Celda>
              <Celda derecha mono>{c.moneda} {monto(c.monto)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
