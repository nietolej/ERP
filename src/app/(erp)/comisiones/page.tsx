import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { ROLES_VEN_COMISIONES, movimientosDe, pendientesDeLiquidar, resumenPorVendedor, ROLES_VEN_TODO_COMISIONES } from '@/lib/comisiones/comisiones';
import { getDb } from '@/lib/db';
import { fecha, hoyCaracas, monto } from '@/lib/formato';

export default async function ComisionesPage({ searchParams }: { searchParams: Promise<{ periodo?: string }> }) {
  const u = await exigirRol(...ROLES_VEN_COMISIONES);
  const q = await searchParams;
  const periodo = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.periodo ?? '') ? q.periodo! : hoyCaracas().slice(0, 7);
  const db = await getDb();
  const [resumen, movs, pendientes] = await Promise.all([
    resumenPorVendedor(db, u, periodo), movimientosDe(db, u, { periodo }), u.roles.some((r) => (ROLES_VEN_TODO_COMISIONES as readonly string[]).includes(r)) ? pendientesDeLiquidar(db) : Promise.resolve([]),
  ]);

  return (
    <>
      <Encabezado titulo="Estado de comisiones"
        descripcion="Base cobrada: la comisión se devenga cuando se aplica un cobro a la factura y se revierte con una nota de crédito o al anular el cobro. Montos en dólares.">
        <form className="flex items-end gap-2 text-sm">
          <input type="month" name="periodo" defaultValue={periodo} className="campo w-auto" aria-label="Mes" />
          <button className="rounded-lg bg-acento px-3 py-2 font-semibold text-white">Ver</button>
        </form>
      </Encabezado>
      <div className="mb-5 flex flex-wrap gap-4 text-sm">
        <Link href="/comisiones/planes" className="text-acento hover:underline">Planes de comisión →</Link>
        <Link href="/comisiones/liquidaciones" className="text-acento hover:underline">Liquidaciones →</Link>
      </div>
      {pendientes.length > 0 && <div className="mb-5"><Aviso>Comisiones sin liquidar: {pendientes.map((p) => `${p.vendedor} US$ ${monto(p.netoUsd)}`).join(' · ')}.</Aviso></div>}
      <Panel titulo={`Resumen del mes ${periodo}`} className="mb-5">
        <Tabla columnas={['Vendedor', { t: 'Devengado (US$)', derecha: true }, { t: 'Reversiones (US$)', derecha: true }, { t: 'Neto (US$)', derecha: true }, { t: 'Por liquidar (US$)', derecha: true }, { t: 'En liquidación (US$)', derecha: true }, { t: 'Pagado (US$)', derecha: true }]}
          vacio="Sin movimientos de comisión en el mes.">
          {resumen.map((r) => (
            <tr key={r.vendedor}>
              <Celda>{r.vendedor}</Celda>
              <Celda derecha>{monto(r.devengadoUsd)}</Celda><Celda derecha>{monto(r.reversionesUsd)}</Celda><Celda derecha className="font-semibold">{monto(r.netoUsd)}</Celda>
              <Celda derecha>{monto(r.porLiquidarUsd)}</Celda><Celda derecha>{monto(r.liquidadoUsd)}</Celda><Celda derecha>{monto(r.pagadoUsd)}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
      <Panel titulo="Movimientos">
        <Tabla columnas={['Fecha', 'Vendedor', 'Tipo', 'Origen', 'Factura', { t: 'Base (US$)', derecha: true }, { t: '%', derecha: true }, { t: 'Comisión (US$)', derecha: true }, 'Liquidación']} vacio="Sin movimientos en el mes.">
          {movs.map((m) => (
            <tr key={m.id}>
              <Celda>{fecha(m.fecha)}</Celda>
              <Celda>{m.vendedor}</Celda>
              <Celda><Etiqueta tono={m.tipo === 'devengo' ? 'exito' : 'peligro'}>{m.tipo === 'devengo' ? 'devengo' : 'reversión'}</Etiqueta></Celda>
              <Celda>{m.origen}</Celda>
              <Celda mono>{m.factura}</Celda>
              <Celda derecha>{monto(m.baseUsd)}</Celda>
              <Celda derecha>{Number(m.porcentaje).toFixed(2)}</Celda>
              <Celda derecha className={m.tipo === 'reversion' ? 'text-red-300' : ''}>{monto(m.montoUsd)}</Celda>
              <Celda>{m.liquidacion ?? '—'}</Celda>
            </tr>
          ))}
        </Tabla>
      </Panel>
    </>
  );
}
