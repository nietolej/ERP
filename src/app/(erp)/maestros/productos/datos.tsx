import 'server-only';
import { Campo } from '@/components/ui';
import type { Db } from '@/lib/db';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Opcion { id: string; nombre: string }
export interface OpcionesProducto { grupos: Opcion[]; marcas: Opcion[]; alicuotas: Opcion[]; categorias: Opcion[] }

const LINEAS: [string, string][] = [
  ['original', 'Original (marca del vehículo)'], ['oem', 'OEM (fabricante de equipo original)'], ['alterna', 'Alterna (aftermarket)'],
];
const PAISES = ['CN', 'KR', 'JP', 'TW', 'US', 'DE', 'IN', 'TR', 'BR', 'ES', 'IT', 'MX', 'VE'];

/** Categorías activas con su ruta ("Frenos › Pastillas"). */
export async function categorias(db: Db): Promise<Opcion[]> {
  const { rows } = await db.query<Opcion>(
    `select id, fn_categoria_ruta(id) as nombre from categoria_producto where activa order by fn_categoria_ruta(id)`);
  return rows;
}

/** Grupos y marcas activos (más los del producto aunque estén inactivos) y alícuotas con su % vigente hoy. */
export async function opcionesProducto(db: Db, hoy: string, actuales: (string | null)[] = []): Promise<OpcionesProducto> {
  const [g, m, a, c] = await Promise.all([
    db.query<Opcion>(`select id, codigo || ' · ' || nombre as nombre from grupo_producto where activo or id = any($1::uuid[]) order by codigo`, [actuales.filter(Boolean)]),
    db.query<Opcion>(`select id, codigo || ' · ' || nombre as nombre from marca where activo or id = any($1::uuid[]) order by codigo`, [actuales.filter(Boolean)]),
    db.query<Opcion>(
      `select id, nombre || ' (' || trim(trailing '.' from trim(trailing '0' from fn_alicuota_iva_pct(id, $1::date)::text)) || ' %)' as nombre
         from alicuota_iva where activa order by tipo_libro, codigo`, [hoy]),
    categorias(db),
  ]);
  return { grupos: g.rows, marcas: m.rows, alicuotas: a.rows, categorias: c };
}

export interface ValoresProducto {
  descripcion: string; codigo_comun: string | null; grupo_id: string | null; marca_id: string | null; unidad: string;
  alicuota_iva_id: string; inventariable: boolean; codigo_alterno: string | null; peso_kg: string | null;
  linea_calidad: string | null; pais_origen: string | null;
}

/** Campos del producto (sin el código), para el alta y la edición. */
export function CamposProducto({ op, v, soloLectura }: { op: OpcionesProducto; v?: ValoresProducto; soloLectura?: boolean }) {
  return (
    <fieldset disabled={soloLectura} className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-3 rounded-lg border border-borde bg-white/[0.02] p-4">
        <p className="mb-3 text-sm text-texto-2">
          <b className="text-texto">Código común:</b> el mismo artículo vendido en varias marcas comparte este código.
          Permite analizar ventas, precios y pronósticos del artículo completo o de cada marca por separado.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Campo etiqueta="Código común" ayuda="Si ya existe, el producto se agrega a él.">
            <input name="codigo_comun" defaultValue={v?.codigo_comun ?? ''} required maxLength={30} autoComplete="off" className="campo font-mono uppercase" />
          </Campo>
          {(
            <>
              <Campo etiqueta="Descripción genérica (si el código común es nuevo)">
                <input name="base_descripcion" maxLength={200} placeholder="Pastilla de freno delantera Tucson" className="campo" />
              </Campo>
              <Campo etiqueta="Categoría (si el código común es nuevo)">
                <select name="base_categoria_id" defaultValue="" className="campo">
                  <option value="">Sin categoría</option>
                  {op.categorias.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
                </select>
              </Campo>
            </>
          )}
        </div>
      </div>
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
        <select name="marca_id" defaultValue={v?.marca_id ?? ''} required className="campo">
          <option value="">Seleccione…</option>
          {op.marcas.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="Línea de calidad">
        <select name="linea_calidad" defaultValue={v?.linea_calidad ?? ''} className="campo">
          <option value="">Sin indicar</option>
          {LINEAS.map(([valor, nombre]) => <option key={valor} value={valor}>{nombre}</option>)}
        </select>
      </Campo>
      <Campo etiqueta="País de origen">
        <input name="pais_origen" defaultValue={v?.pais_origen ?? ''} maxLength={2} list="paises-origen" className="campo font-mono uppercase" />
        <datalist id="paises-origen">{PAISES.map((p) => <option key={p} value={p} />)}</datalist>
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
