import 'server-only';
import { Campo } from '@/components/ui';
import type { Db } from '@/lib/db';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Opcion { id: string; nombre: string }
export interface OpcionesProducto { grupos: Opcion[]; marcas: Opcion[]; alicuotas: Opcion[] }

/** Grupos y marcas activos (más los del producto aunque estén inactivos) y alícuotas con su % vigente hoy. */
export async function opcionesProducto(db: Db, hoy: string, actuales: (string | null)[] = []): Promise<OpcionesProducto> {
  const [g, m, a] = await Promise.all([
    db.query<Opcion>(`select id, codigo || ' · ' || nombre as nombre from grupo_producto where activo or id = any($1::uuid[]) order by codigo`, [actuales.filter(Boolean)]),
    db.query<Opcion>(`select id, codigo || ' · ' || nombre as nombre from marca where activo or id = any($1::uuid[]) order by codigo`, [actuales.filter(Boolean)]),
    db.query<Opcion>(
      `select id, nombre || ' (' || trim(trailing '.' from trim(trailing '0' from fn_alicuota_iva_pct(id, $1::date)::text)) || ' %)' as nombre
         from alicuota_iva where activa order by tipo_libro, codigo`, [hoy]),
  ]);
  return { grupos: g.rows, marcas: m.rows, alicuotas: a.rows };
}

export interface ValoresProducto {
  descripcion: string; grupo_id: string | null; marca_id: string | null; familia: string | null; unidad: string;
  alicuota_iva_id: string; inventariable: boolean; codigo_alterno: string | null; peso_kg: string | null;
}

/** Campos del producto (sin el código), para el alta y la edición. */
export function CamposProducto({ op, v, soloLectura }: { op: OpcionesProducto; v?: ValoresProducto; soloLectura?: boolean }) {
  return (
    <fieldset disabled={soloLectura} className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-3">
        <Campo etiqueta="Descripción">
          <input name="descripcion" defaultValue={v?.descripcion} required maxLength={200} className="campo" />
        </Campo>
      </div>
      <Campo etiqueta="Grupo (modelo de vehículo)">
        <select name="grupo_id" defaultValue={v?.grupo_id ?? ''} className="campo">
          <option value="">Sin grupo</option>
          {op.grupos.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Marca">
        <select name="marca_id" defaultValue={v?.marca_id ?? ''} className="campo">
          <option value="">Sin marca</option>
          {op.marcas.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Familia">
        <input name="familia" defaultValue={v?.familia ?? ''} maxLength={60} className="campo" />
      </Campo>
      <Campo etiqueta="Alícuota de IVA" ayuda="El porcentaje sale de los parámetros fiscales vigentes.">
        <select name="alicuota_iva_id" defaultValue={v?.alicuota_iva_id ?? op.alicuotas[0]?.id} required className="campo">
          {op.alicuotas.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Unidad">
        <input name="unidad" defaultValue={v?.unidad ?? 'UND'} required maxLength={10} className="campo uppercase" />
      </Campo>
      <Campo etiqueta="Peso (kg)">
        <input name="peso_kg" defaultValue={v?.peso_kg ?? ''} inputMode="decimal" className="campo text-right tabular-nums" />
      </Campo>
      <Campo etiqueta="Código alterno">
        <input name="codigo_alterno" defaultValue={v?.codigo_alterno ?? ''} maxLength={30} className="campo font-mono uppercase" />
      </Campo>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" name="inventariable" defaultChecked={v?.inventariable ?? true} /> Lleva inventario
      </label>
    </fieldset>
  );
}
