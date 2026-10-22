/** Fecha desde/hasta de un solo periodo (spec_reportes §4.4), con el estado en la URL. */
export function FiltroRango({ desde, hasta, tab }: { desde: string; hasta: string; tab: string }) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
      <input type="hidden" name="tab" value={tab} />
      <label className="block"><span className="mb-1 block text-texto-2">Desde</span><input type="date" name="desde" defaultValue={desde} className="campo" /></label>
      <label className="block"><span className="mb-1 block text-texto-2">Hasta</span><input type="date" name="hasta" defaultValue={hasta} className="campo" /></label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
    </form>
  );
}
