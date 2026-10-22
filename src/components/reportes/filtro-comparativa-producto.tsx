/** Año A y año B del detalle de producto (spec_reportes §5.2, Comparativa multianual). */
export function FiltroComparativaProducto({ anios, anioA, anioB }: { anios: number[]; anioA: number; anioB: number }) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
      <input type="hidden" name="tab" value="comparativa" />
      <label className="block">
        <span className="mb-1 block text-texto-2">Año A</span>
        <select name="anioA" defaultValue={anioA} className="campo w-auto">
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-texto-2">Año B</span>
        <select name="anioB" defaultValue={anioB} className="campo w-auto">
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Comparar</button>
    </form>
  );
}
