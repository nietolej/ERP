/** Selector de año del detalle de producto (spec_reportes §5.2), con el estado en la URL. */
export function FiltroAnioProducto({ anios, aniosSeleccionados }: { anios: number[]; aniosSeleccionados: number[] }) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
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
