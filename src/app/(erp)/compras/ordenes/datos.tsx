import 'server-only';
import { CRITERIOS_REPARTO, NOMBRE_CRITERIO } from '@/lib/compras/costo-destino';
import { Campo } from '@/components/ui';
import type { Db } from '@/lib/db';

interface Opcion { id: string; nombre: string }
export interface OpcionesOrden {
  proveedores: Opcion[]; almacenes: Opcion[]; monedas: string[]; criterios: { valor: string; nombre: string }[];
}
export interface ValoresOrden {
  proveedor_id: string; almacen_id: string; moneda: string; criterio_reparto: string; fecha_prometida: string | null; observaciones: string | null;
}

/** Proveedores activos de mercancía, almacenes activos, monedas y criterios de reparto. */
export async function opcionesOrden(db: Db): Promise<OpcionesOrden> {
  const [proveedores, almacenes, monedas] = await Promise.all([
    db.query<Opcion>(
      `select p.tercero_id as id, p.codigo || ' · ' || t.razon_social as nombre
         from proveedor p join tercero t on t.id = p.tercero_id
        where p.estado = 'activo' and p.tipo in ('mercancia_local', 'importacion') order by p.codigo`).then((r) => r.rows),
    db.query<Opcion>(`select id, codigo || ' · ' || nombre as nombre from almacen where activo order by codigo`).then((r) => r.rows),
    db.query<{ codigo: string }>(`select codigo from moneda order by case codigo when 'USD' then 0 when 'EUR' then 1 when 'VES' then 2 else 3 end, codigo`)
      .then((r) => r.rows.map((m) => m.codigo)),
  ]);
  return { proveedores, almacenes, monedas, criterios: CRITERIOS_REPARTO.map((c) => ({ valor: c, nombre: NOMBRE_CRITERIO[c] })) };
}

/** Campos del encabezado de la orden, para el alta y la edición en borrador. */
export function CamposOrden({ op, v, monedaFija }: { op: OpcionesOrden; v?: ValoresOrden; monedaFija?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <Campo etiqueta="Proveedor">
          {v ? (
            <>
              <input readOnly value={op.proveedores.find((p) => p.id === v.proveedor_id)?.nombre ?? ''} className="campo opacity-70" />
              <input type="hidden" name="proveedor_id" value={v.proveedor_id} />
            </>
          ) : (
            <select name="proveedor_id" required defaultValue="" className="campo">
              <option value="" disabled>Seleccione…</option>
              {op.proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          )}
        </Campo>
      </div>
      <Campo etiqueta="Moneda de la orden">
        <select name="moneda" required defaultValue={v?.moneda ?? 'USD'} disabled={monedaFija} className="campo">
          {op.monedas.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {monedaFija && <input type="hidden" name="moneda" value={v?.moneda} />}
      </Campo>
      <Campo etiqueta="Se recibe en el almacén">
        <select name="almacen_id" required defaultValue={v?.almacen_id ?? ''} className="campo">
          <option value="" disabled>Seleccione…</option>
          {op.almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Gastos de importación se reparten por"
        ayuda="Flete, seguro y aranceles se prorratean entre los productos con este criterio. Peso y volumen exigen esas medidas en cada producto.">
        <select name="criterio_reparto" defaultValue={v?.criterio_reparto ?? 'valor'} className="campo">
          {op.criterios.map((c) => <option key={c.valor} value={c.valor}>{c.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Entrega prometida (opcional)">
        <input type="date" name="fecha_prometida" defaultValue={v?.fecha_prometida ?? ''} className="campo" />
      </Campo>
      <div className="sm:col-span-3">
        <Campo etiqueta="Observaciones"><textarea name="observaciones" rows={2} maxLength={300} defaultValue={v?.observaciones ?? ''} className="campo" /></Campo>
      </div>
    </div>
  );
}
