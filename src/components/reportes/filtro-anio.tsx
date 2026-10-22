import Link from 'next/link';

/** Selector de año múltiple + "Incluir inactivos" (spec_reportes §1.3, §4), con el estado en la URL. */
export function FiltroAnio({ base, anios, aniosSeleccionados, incluirInactivos }: {
  base: string; anios: number[]; aniosSeleccionados: number[]; incluirInactivos: boolean;
}) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
      <label className="block">
        <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
        <select name="anios" multiple size={Math.min(anios.length, 5) || 1} defaultValue={aniosSeleccionados.map(String)} className="campo min-w-[8rem]">
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 pb-2">
        <input type="checkbox" name="incluir" value="1" defaultChecked={incluirInactivos} className="h-4 w-4" />
        Incluir inactivos
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
      <Link href={base} className="py-2 text-texto-2 hover:text-texto">Todos los años</Link>
    </form>
  );
}
