/** Fechas desde/hasta de los dos periodos a comparar (spec_reportes §4.3), con el estado en la URL. */
export function FiltroComparacion({ periodoA, periodoB, incluirInactivos }: {
  periodoA: { desde: string; hasta: string }; periodoB: { desde: string; hasta: string }; incluirInactivos: boolean;
}) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-4 text-sm">
      <input type="hidden" name="tab" value="comparacion" />
      <fieldset className="flex items-end gap-2">
        <legend className="mb-1 text-xs text-texto-2">Periodo A</legend>
        <label className="block"><span className="mb-1 block text-texto-2">Desde</span><input type="date" name="a_desde" defaultValue={periodoA.desde} className="campo" /></label>
        <label className="block"><span className="mb-1 block text-texto-2">Hasta</span><input type="date" name="a_hasta" defaultValue={periodoA.hasta} className="campo" /></label>
      </fieldset>
      <fieldset className="flex items-end gap-2">
        <legend className="mb-1 text-xs text-texto-2">Periodo B</legend>
        <label className="block"><span className="mb-1 block text-texto-2">Desde</span><input type="date" name="b_desde" defaultValue={periodoB.desde} className="campo" /></label>
        <label className="block"><span className="mb-1 block text-texto-2">Hasta</span><input type="date" name="b_hasta" defaultValue={periodoB.hasta} className="campo" /></label>
      </fieldset>
      <label className="flex items-center gap-2 pb-2">
        <input type="checkbox" name="incluir" value="1" defaultChecked={incluirInactivos} className="h-4 w-4" />
        Incluir inactivos
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Comparar</button>
    </form>
  );
}
