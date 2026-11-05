import { BotonEnviar, Formulario } from '@/components/formulario';
import { GraficoValorizacion } from '@/components/grafico-valorizacion';
import { Aviso, Celda, KpiCard, Panel, Tabla } from '@/components/ui';
import { monto } from '@/lib/formato';
import type { FilaSaludGrupo, PuntoValorizacion, SugeridoCompra, TarjetasInventario } from '@/lib/reportes/inventario';
import { crearOrdenDesdeSugeridoAccion } from '@/app/(erp)/reportes/inventario/acciones';

const num = (v: string | number | null, dec = 2) => (v === null ? '—' : Number(v).toLocaleString('es-VE', { maximumFractionDigits: dec }));

/** Capital inmovilizado y venta perdida estimada (spec_reportes §9). */
export function TarjetasCapital({ t }: { t: TarjetasInventario }) {
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2">
      <KpiCard titulo="Capital inmovilizado" valor={monto(t.capitalInmovilizadoUsd, 'US$ ')} subtitulo="Existencia × costo promedio, todos los almacenes" />
      <KpiCard titulo="Venta perdida estimada" valor={monto(t.ventaPerdidaUsd, 'US$ ')} tono={Number(t.ventaPerdidaUsd) > 0 ? 'advertencia' : undefined}
        subtitulo="Días sin stock × velocidad ajustada × precio A, en el periodo" />
    </div>
  );
}

export function PanelValorizacion({ serie }: { serie: PuntoValorizacion[] }) {
  return (
    <Panel titulo="Valorización mensual del inventario (al costo, por almacén)" className="mb-5">
      {serie.length === 0 ? <Aviso>Aún no hay movimientos de inventario para valorar.</Aviso> : (
        <GraficoValorizacion datos={serie.map((s) => ({ mes: s.mes, almacen: s.almacen, valor: Number(s.valorUsd) }))} />
      )}
    </Panel>
  );
}

/** Pestaña "Sugerido de órdenes de compra" (spec_reportes §9.2), con el botón para crear la orden. */
export function PanelSugerido({ s, texto, puedeComprar, proveedores, almacenes }: {
  s: SugeridoCompra; texto: string; puedeComprar: boolean;
  proveedores: { id: string; nombre: string }[]; almacenes: { id: string; nombre: string }[];
}) {
  return (
    <>
      <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
        <input type="hidden" name="tab" value="sugerido" />
        <label className="block"><span className="mb-1 block text-texto-2">Producto</span>
          <input name="texto" defaultValue={texto} placeholder="Código o descripción" className="campo" /></label>
        <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
      </form>
      <Panel>
        <p className="mb-3 text-sm text-texto-2">
          Sugerido = velocidad ajustada × {s.diasCobertura} días de cobertura − (stock comercial + tránsito + producción), redondeado hacia arriba. El tránsito es lo
          ordenado y no recibido en órdenes aprobadas; la producción, lo que falta producir en órdenes liberadas o en proceso.
        </p>
        {s.filas.length === 0 ? <Aviso tono="exito">Ningún producto necesita reposición con la velocidad actual.</Aviso> : (
          <Formulario accion={crearOrdenDesdeSugeridoAccion} className="space-y-4">
            <Tabla columnas={[...(puedeComprar ? ['Incluir'] : []), 'Producto', { t: 'Stock', derecha: true }, { t: 'En tránsito', derecha: true }, { t: 'En producción', derecha: true },
              { t: 'Vel. ajustada', derecha: true }, { t: `Demanda ${s.diasCobertura} d`, derecha: true }, { t: 'Sugerido', derecha: true }]}>
              {s.filas.map((f) => (
                <tr key={f.productoId} className="hover:bg-white/[0.03]">
                  {puedeComprar && <Celda><input type="checkbox" name="producto" value={f.productoId} className="h-4 w-4" aria-label={`Incluir ${f.codigo}`} /></Celda>}
                  <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.descripcion}</span></Celda>
                  <Celda derecha mono>{num(f.stock)}</Celda>
                  <Celda derecha mono>{num(f.transito)}</Celda>
                  <Celda derecha mono>{num(f.produccion)}</Celda>
                  <Celda derecha mono>{num(f.velocidadAjustada, 3)}</Celda>
                  <Celda derecha mono>{num(f.demanda, 1)}</Celda>
                  <Celda derecha>
                    {puedeComprar
                      ? <input name={`cantidad_${f.productoId}`} defaultValue={f.sugerido} inputMode="decimal" className="campo w-24 text-right" aria-label={`Cantidad de ${f.codigo}`} />
                      : <span className="font-mono">{f.sugerido}</span>}
                  </Celda>
                </tr>
              ))}
            </Tabla>
            {puedeComprar && (
              <div className="flex flex-wrap items-end gap-3 text-sm">
                <label className="block"><span className="mb-1 block text-texto-2">Proveedor</span>
                  <select name="proveedor_id" required defaultValue="" className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                  </select></label>
                <label className="block"><span className="mb-1 block text-texto-2">Se recibe en</span>
                  <select name="almacen_id" required defaultValue="" className="campo">
                    <option value="" disabled>Seleccione…</option>
                    {almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                  </select></label>
                <BotonEnviar>Crear orden de compra</BotonEnviar>
              </div>
            )}
            {s.filas.length >= 500 && <p className="text-xs text-texto-2">Se muestran los primeros 500.</p>}
          </Formulario>
        )}
      </Panel>
    </>
  );
}

/** Pestaña "Salud por grupo / familia" (spec_reportes §9.2). */
export function TablaSaludGrupo({ filas, desde, hasta }: { filas: FilaSaludGrupo[]; desde: string; hasta: string }) {
  const fecha = (iso: string) => iso.split('-').reverse().join('-');
  return (
    <Panel>
      <p className="mb-3 text-sm text-texto-2">Periodo del {fecha(desde)} al {fecha(hasta)}.</p>
      <Tabla columnas={['Grupo', { t: 'Ítems', derecha: true }, { t: 'Capital inmovilizado ($)', derecha: true }, { t: 'En quiebre', derecha: true },
        { t: 'En sobrestock', derecha: true }, { t: 'Venta perdida ($)', derecha: true }]}
        vacio="No hay productos con registro de existencia en ese periodo.">
        {filas.map((f) => (
          <tr key={f.grupoId ?? 'sin-grupo'} className="hover:bg-white/[0.03]">
            <Celda>{f.codigo ? <span className="font-mono">{f.codigo} · </span> : null}{f.nombre}</Celda>
            <Celda derecha mono>{f.items}</Celda>
            <Celda derecha>{monto(f.capitalUsd, 'US$ ')}</Celda>
            <Celda derecha mono className={f.enQuiebre > 0 ? 'text-peligro' : ''}>{f.enQuiebre}</Celda>
            <Celda derecha mono>{f.enSobrestock}</Celda>
            <Celda derecha>{monto(f.ventaPerdidaUsd, 'US$ ')}</Celda>
          </tr>
        ))}
      </Tabla>
    </Panel>
  );
}
