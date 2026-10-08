import 'server-only';
import { Campo } from '@/components/ui';
import { CRITERIOS_REPARTO, NOMBRE_CRITERIO } from '@/lib/compras/costo-destino';
import { CONCEPTOS_GASTO, NOMBRE_CONCEPTO, recepcionesElegibles, type RecepcionElegible } from '@/lib/compras/gastos-importacion';
import type { Db } from '@/lib/db';

interface Opcion { id: string; nombre: string }
export interface OpcionesGasto {
  proveedores: Opcion[]; alicuotas: Opcion[]; monedas: string[]; recepciones: RecepcionElegible[];
}
export interface ValoresGasto {
  proveedor_id: string; concepto: string; descripcion: string | null; numero_factura: string; numero_control: string; fecha_factura: string;
  fecha_vencimiento: string; moneda: string; criterio_reparto: string; base: string; alicuota_iva_id: string; recepcion_ids: string[];
}

/** Proveedores de servicios, alícuotas con su % de hoy, monedas y recepciones a las que se puede aplicar el gasto. */
export async function opcionesGasto(db: Db, hoy: string): Promise<OpcionesGasto> {
  const [proveedores, alicuotas, monedas, recepciones] = await Promise.all([
    db.query<Opcion>(
      `select p.tercero_id as id, p.codigo || ' · ' || t.razon_social as nombre
         from proveedor p join tercero t on t.id = p.tercero_id
        where p.estado = 'activo' and p.tipo in ('servicios', 'importacion', 'gastos') order by p.codigo`).then((r) => r.rows),
    db.query<Opcion>(
      `select id, nombre || ' (' || trim(trailing '.' from trim(trailing '0' from fn_alicuota_iva_pct(id, $1::date)::text)) || ' %)' as nombre
         from alicuota_iva where activa order by tipo_libro, codigo`, [hoy]).then((r) => r.rows),
    db.query<{ codigo: string }>(`select codigo from moneda order by case codigo when 'USD' then 0 when 'EUR' then 1 when 'VES' then 2 else 3 end, codigo`)
      .then((r) => r.rows.map((m) => m.codigo)),
    recepcionesElegibles(db),
  ]);
  return { proveedores, alicuotas, monedas, recepciones };
}

/** Campos del gasto de importación (factura del proveedor de servicios, criterio de reparto y recepciones a las que se aplica). */
export function CamposGasto({ op, v, hoy }: { op: OpcionesGasto; v?: ValoresGasto; hoy: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <Campo etiqueta="Proveedor del servicio">
          <select name="proveedor_id" required defaultValue={v?.proveedor_id ?? ''} className="campo">
            <option value="" disabled>Seleccione…</option>
            {op.proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </Campo>
      </div>
      <Campo etiqueta="Concepto">
        <select name="concepto" required defaultValue={v?.concepto ?? 'flete'} className="campo">
          {CONCEPTOS_GASTO.map((c) => <option key={c} value={c}>{NOMBRE_CONCEPTO[c]}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Número de factura"><input name="numero_factura" required maxLength={40} defaultValue={v?.numero_factura} autoComplete="off" className="campo font-mono uppercase" /></Campo>
      <Campo etiqueta="Número de control"><input name="numero_control" required maxLength={40} defaultValue={v?.numero_control} autoComplete="off" className="campo font-mono uppercase" /></Campo>
      <Campo etiqueta="Fecha de la factura"><input type="date" name="fecha_factura" required max={hoy} defaultValue={v?.fecha_factura ?? hoy} className="campo" /></Campo>
      <Campo etiqueta="Moneda de la factura">
        <select name="moneda" required defaultValue={v?.moneda ?? 'USD'} className="campo">
          {op.monedas.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Monto sin IVA (a repartir)"><input name="base" required inputMode="decimal" defaultValue={v?.base} className="campo text-right tabular-nums" /></Campo>
      <Campo etiqueta="Alícuota de IVA">
        <select name="alicuota_iva_id" required defaultValue={v?.alicuota_iva_id ?? op.alicuotas[0]?.id} className="campo">
          {op.alicuotas.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Vence (opcional)" ayuda="Si la deja vacía: fecha de la factura más los días de la condición de pago del proveedor.">
        <input type="date" name="fecha_vencimiento" defaultValue={v?.fecha_vencimiento} className="campo" />
      </Campo>
      <Campo etiqueta="Se reparte por" ayuda="Si lo deja vacío usa el criterio de las órdenes de compra de las recepciones.">
        <select name="criterio_reparto" defaultValue={v?.criterio_reparto ?? ''} className="campo">
          <option value="">Según la orden</option>
          {CRITERIOS_REPARTO.map((c) => <option key={c} value={c}>{NOMBRE_CRITERIO[c]}</option>)}
        </select>
      </Campo>
      <div className="sm:col-span-2">
        <Campo etiqueta="Descripción (opcional)"><input name="descripcion" maxLength={200} defaultValue={v?.descripcion ?? ''} className="campo" /></Campo>
      </div>
      <fieldset className="sm:col-span-3 rounded-lg border border-borde p-4">
        <legend className="px-2 text-sm text-texto-2">Recepciones a las que se aplica el gasto</legend>
        {op.recepciones.length === 0 ? (
          <p className="text-sm text-texto-2">Todavía no hay recepciones de mercancía.</p>
        ) : (
          <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
            {op.recepciones.map((r) => (
              <label key={r.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="recepcion_id" value={r.id} defaultChecked={v?.recepcion_ids.includes(r.id)} className="mt-1" />
                <span>{r.texto}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
