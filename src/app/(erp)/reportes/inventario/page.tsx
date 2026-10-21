import Link from 'next/link';
import { Aviso, Celda, Encabezado, Etiqueta, Panel, Tabla } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { monto } from '@/lib/formato';
import {
  ESTADOS_SALUD, NOMBRE_ESTADO_SALUD, ORDENES, ROLES_VEN_DISPONIBILIDAD, consultarDisponibilidad, resumenSalud,
  type OrdenDisponibilidad,
} from '@/lib/inventario/disponibilidad';
import { ErrorMaestro } from '@/lib/maestros/terceros';

const ETIQUETA_ORDEN: Record<OrdenDisponibilidad, string> = {
  venta_perdida: 'Mayor venta perdida', dias_sin_existencia: 'Más días sin existencia', cobertura: 'Menor cobertura',
  velocidad: 'Mayor velocidad', codigo: 'Código',
};
const fecha = (iso: string) => iso.split('-').reverse().join('-');
const num = (v: string | null, dec = 2) => (v === null ? '—' : Number(v).toLocaleString('es-VE', { maximumFractionDigits: dec }));

type Busqueda = { desde?: string; hasta?: string; estado?: string; texto?: string; orden?: string };

export default async function DisponibilidadPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  await exigirRol(...ROLES_VEN_DISPONIBILIDAD);
  const q = await searchParams;
  const orden = (Object.keys(ORDENES) as OrdenDisponibilidad[]).includes(q.orden as OrdenDisponibilidad) ? (q.orden as OrdenDisponibilidad) : 'venta_perdida';
  const db = await getDb();

  let datos: Awaited<ReturnType<typeof consultarDisponibilidad>> | null = null;
  let resumen: Awaited<ReturnType<typeof resumenSalud>> | null = null;
  let error: string | null = null;
  try {
    datos = await consultarDisponibilidad(db, { desde: q.desde, hasta: q.hasta, estado: q.estado, texto: q.texto, orden });
    resumen = await resumenSalud(db, datos.desde, datos.hasta);
  } catch (e) {
    error = e instanceof ErrorMaestro ? e.message : 'No se pudo calcular la disponibilidad. Avise al administrador.';
    if (!(e instanceof ErrorMaestro)) console.error(e);
  }
  const enlace = (extra: Partial<Busqueda>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ desde: q.desde, hasta: q.hasta, estado: q.estado, texto: q.texto, orden: q.orden, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/reportes/inventario?${s}` : '/reportes/inventario';
  };

  return (
    <>
      <Encabezado titulo="Disponibilidad y velocidad de venta"
        descripcion="Cuántos días tuvo existencia cada producto, cuánto vende cuando la tiene y para cuántos días le alcanza. Se calcula con la existencia al cierre de cada día y las salidas del kardex." />

      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="mb-1 block text-texto-2">Desde</span><input type="date" name="desde" defaultValue={q.desde ?? datos?.desde} className="campo" /></label>
          <label className="block"><span className="mb-1 block text-texto-2">Hasta</span><input type="date" name="hasta" defaultValue={q.hasta ?? datos?.hasta} className="campo" /></label>
          <label className="block"><span className="mb-1 block text-texto-2">Producto</span><input name="texto" defaultValue={q.texto ?? ''} placeholder="Código o descripción" className="campo" /></label>
          <label className="block">
            <span className="mb-1 block text-texto-2">Ordenar por</span>
            <select name="orden" defaultValue={orden} className="campo">
              {(Object.keys(ORDENES) as OrdenDisponibilidad[]).map((o) => <option key={o} value={o}>{ETIQUETA_ORDEN[o]}</option>)}
            </select>
          </label>
          {q.estado && <input type="hidden" name="estado" value={q.estado} />}
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 text-sm font-semibold text-white hover:bg-acento-hover">Aplicar</button>
          <Link href="/reportes/inventario" className="py-2 text-texto-2 hover:text-texto">Restablecer</Link>
        </form>

        {error && <Aviso tono="peligro">{error}</Aviso>}

        {resumen && datos && (
          <>
            <p className="mb-3 text-sm text-texto-2">Periodo del {fecha(datos.desde)} al {fecha(datos.hasta)}. Haga clic en un estado para filtrar.</p>
            <div className="mb-5 grid gap-3 md:grid-cols-5">
              {ESTADOS_SALUD.map((e) => {
                const n = NOMBRE_ESTADO_SALUD[e];
                const activo = q.estado === e;
                return (
                  <Link key={e} href={enlace({ estado: activo ? undefined : e })}
                    className={`rounded-lg border px-3 py-3 ${activo ? 'border-acento bg-acento/10' : 'border-borde hover:bg-white/[0.03]'}`} title={n.ayuda}>
                    <span className="block text-2xl font-bold tabular-nums">{resumen[e]}</span>
                    <Etiqueta tono={n.tono}>{n.texto}</Etiqueta>
                  </Link>
                );
              })}
            </div>

            <Tabla
              columnas={['Producto', 'Estado', { t: 'Días con stock', derecha: true }, { t: 'Días sin stock', derecha: true }, { t: '% disp.', derecha: true },
                { t: 'Vendidas', derecha: true }, { t: 'Vel. básica', derecha: true }, { t: 'Vel. ajustada', derecha: true }, { t: 'Stock', derecha: true },
                { t: 'Cobertura (días)', derecha: true }, { t: 'Venta perdida', derecha: true }]}
              vacio="No hay productos con registro de existencia en ese periodo.">
              {datos.filas.map((f) => {
                const n = NOMBRE_ESTADO_SALUD[f.estado_salud];
                return (
                  <tr key={f.producto_id} className="hover:bg-white/[0.03]">
                    <Celda><span className="font-mono">{f.codigo}</span><span className="block text-xs text-texto-2">{f.descripcion}</span></Celda>
                    <Celda><Etiqueta tono={n.tono}>{n.texto}</Etiqueta></Celda>
                    <Celda derecha mono>{f.dias_con_existencia}</Celda>
                    <Celda derecha mono>{f.dias_sin_existencia}</Celda>
                    <Celda derecha mono>{num(f.pct_disponibilidad, 1)} %</Celda>
                    <Celda derecha mono>{num(f.unidades_vendidas, 2)}</Celda>
                    <Celda derecha mono>{num(f.velocidad_basica, 3)}</Celda>
                    <Celda derecha mono>{num(f.velocidad_ajustada, 3)}</Celda>
                    <Celda derecha mono>{num(f.stock_comercial, 2)}</Celda>
                    <Celda derecha mono>{num(f.cobertura_dias, 1)}</Celda>
                    <Celda derecha>
                      {f.venta_perdida_usd === null ? '—' : monto(f.venta_perdida_usd, 'US$ ')}
                      {f.venta_perdida_unidades !== null && <span className="block text-xs text-texto-2">{num(f.venta_perdida_unidades, 1)} und</span>}
                    </Celda>
                  </tr>
                );
              })}
            </Tabla>
            {datos.filas.length >= 200 && <p className="mt-3 text-xs text-texto-2">Se muestran los primeros 200; afine el periodo, el estado o la búsqueda para ver otros.</p>}
          </>
        )}
      </Panel>

      <Panel titulo="Cómo se calcula" className="mt-5">
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          <div><dt className="font-medium">Días con stock</dt><dd className="text-texto-2">Días del periodo en que la existencia de los almacenes que venden, al cierre del día, fue mayor que cero. Antes del primer registro del producto no hay dato y esos días no se cuentan.</dd></div>
          <div><dt className="font-medium">Velocidad básica y ajustada</dt><dd className="text-texto-2">Unidades vendidas (salidas por venta menos devoluciones) entre los días del periodo, y entre los días con stock. La ajustada es lo que se vende cuando hay existencia.</dd></div>
          <div><dt className="font-medium">Cobertura</dt><dd className="text-texto-2">Existencia comercial al cierre del periodo entre la velocidad ajustada, en días.</dd></div>
          <div><dt className="font-medium">Venta perdida estimada</dt><dd className="text-texto-2">Días sin stock × velocidad ajustada × precio de la lista A vigente al cierre. Es una estimación: no incluye lo registrado como demanda no atendida.</dd></div>
        </dl>
        <p className="mt-3 text-xs text-texto-2">Los umbrales de cada estado (cobertura mínima y máxima, disponibilidad y velocidad de demanda reprimida) son parámetros de inventario.</p>
      </Panel>
    </>
  );
}
