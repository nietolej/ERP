/** Filtros de "Análisis por grupos/familias" (spec_reportes §5.1): agrupador y año. */
export function FiltroGruposProductos({ agrupador, anios, aniosSeleccionados }: {
  agrupador: 'categoria' | 'codigo_comun'; anios: number[]; aniosSeleccionados: number[];
}) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
      <input type="hidden" name="tab" value="grupos" />
      <label className="block">
        <span className="mb-1 block text-texto-2">Agrupar por</span>
        <select name="agrupar" defaultValue={agrupador} className="campo w-auto">
          <option value="categoria">Categoría (familia)</option>
          <option value="codigo_comun">Código común</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
        <select name="anios" multiple size={Math.min(anios.length, 5) || 1} defaultValue={aniosSeleccionados.map(String)} className="campo min-w-[8rem]">
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
    </form>
  );
}
