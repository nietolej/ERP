/** Filtros de la pestaña "Catálogo de artículos" (spec_reportes §5.1): año, búsqueda y cantidad de filas. */
export function FiltroCatalogoProductos({ anios, aniosSeleccionados, texto, limite }: {
  anios: number[]; aniosSeleccionados: number[]; texto: string; limite: number;
}) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
      <label className="block">
        <span className="mb-1 block text-texto-2">Buscar</span>
        <input name="texto" defaultValue={texto} placeholder="Código o descripción" autoComplete="off" className="campo w-64" />
      </label>
      <label className="block">
        <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
        <select name="anios" multiple size={Math.min(anios.length, 5) || 1} defaultValue={aniosSeleccionados.map(String)} className="campo min-w-[8rem]">
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-texto-2">Filas</span>
        <select name="limite" defaultValue={limite} className="campo w-auto">
          {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
    </form>
  );
}
