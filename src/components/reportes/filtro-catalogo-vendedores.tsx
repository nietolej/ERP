/** Filtros del catálogo de vendedores (spec_reportes §6.1): año, búsqueda, orden e incluir administrativos/casa. */
export function FiltroCatalogoVendedores({ anios, aniosSeleccionados, texto, orden, incluirAdministrativos }: {
  anios: number[]; aniosSeleccionados: number[]; texto: string; orden: string; incluirAdministrativos: boolean;
}) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 text-sm">
      <label className="block">
        <span className="mb-1 block text-texto-2">Buscar</span>
        <input name="texto" defaultValue={texto} placeholder="Código o nombre" autoComplete="off" className="campo w-64" />
      </label>
      <label className="block">
        <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
        <select name="anios" multiple size={Math.min(anios.length, 5) || 1} defaultValue={aniosSeleccionados.map(String)} className="campo min-w-[8rem]">
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-texto-2">Ordenar por</span>
        <select name="orden" defaultValue={orden} className="campo w-auto">
          <option value="venta">Venta</option>
          <option value="facturas">Facturas</option>
          <option value="clientes">Clientes atendidos</option>
        </select>
      </label>
      <label className="flex items-center gap-2 pb-2">
        <input type="checkbox" name="incluir" value="1" defaultChecked={incluirAdministrativos} className="h-4 w-4" />
        Incluir administrativos / casa
      </label>
      <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
    </form>
  );
}
