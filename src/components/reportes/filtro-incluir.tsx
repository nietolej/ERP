/** Solo el interruptor "Incluir inactivos" (spec_reportes §1.3), para pestañas que no usan el selector de año. */
export function FiltroIncluir({ incluirInactivos, tab }: { incluirInactivos: boolean; tab: string }) {
  return (
    <form method="get" className="mb-5 flex items-center gap-2 text-sm">
      <input type="hidden" name="tab" value={tab} />
      <label className="flex items-center gap-2">
        <input type="checkbox" name="incluir" value="1" defaultChecked={incluirInactivos} className="h-4 w-4" />
        Incluir inactivos
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
    </form>
  );
}
