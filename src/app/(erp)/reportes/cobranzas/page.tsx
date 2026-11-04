import Link from 'next/link';
import { PanelCobranzaResumen, TarjetasCobranza } from '@/components/reportes/panel-cobranza-resumen';
import { Pestanas } from '@/components/reportes/pestanas';
import { PanelBancosCanales, PanelCobranzaCliente, TablaCobranzaVendedor } from '@/components/reportes/tablas-cobranza';
import { Encabezado, Panel } from '@/components/ui';
import { exigirRol } from '@/lib/auth/dal';
import { getDb } from '@/lib/db';
import { ROLES_VEN_CLIENTES, ROLES_VEN_TODOS } from '@/lib/maestros/clientes';
import { aniosDisponibles } from '@/lib/reportes/clientes';
import {
  antiguedadSaldos, bancosYCanales, cobranzaPorCliente, cobranzaPorVendedor, resumenCobranza, tendenciaCobranza, velocidadCobro,
  type BaseAntiguedad, type CategoriaCliente,
} from '@/lib/reportes/cobranzas';

type Busqueda = { tab?: string; anios?: string | string[]; incluir?: string; base?: string; texto?: string; categoria?: string };

const TABS = ['resumen', 'vendedor', 'cliente', 'bancos'] as const;
const CATEGORIAS: CategoriaCliente[] = ['puntual', 'mora_leve', 'mora_critica', 'con_deuda'];

export default async function ReporteCobranzasPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const u = await exigirRol(...ROLES_VEN_CLIENTES);
  const db = await getDb();
  const q = await searchParams;
  const tab = (TABS as readonly string[]).includes(q.tab ?? '') ? q.tab! : 'resumen';
  const anios = (Array.isArray(q.anios) ? q.anios : q.anios ? [q.anios] : []).map(Number).filter((n) => Number.isInteger(n));
  const incluirInactivos = q.incluir === '1';
  const baseAntiguedad: BaseAntiguedad = q.base === 'emision' ? 'emision' : 'vencimiento';
  const texto = (q.texto ?? '').trim();
  const categoria = (CATEGORIAS as string[]).includes(q.categoria ?? '') ? (q.categoria as CategoriaCliente) : undefined;

  // Seguridad por fila (§4.3): quien solo tiene el rol Ventas ve nada más su propia cartera.
  const verTodos = (ROLES_VEN_TODOS as string[]).some((r) => u.roles.includes(r));
  let vendedorId: string | undefined;
  if (!verTodos) {
    const { rows } = await db.query<{ id: string }>('select id from vendedor where usuario_id = $1', [u.id]);
    vendedorId = rows[0]?.id;
  }
  const filtro = { anios, incluirInactivos, vendedorId };

  const sufijo = `${incluirInactivos ? '&incluir=1' : ''}${anios.map((a) => `&anios=${a}`).join('')}`;
  const pestanas = [
    { tab: 'resumen', label: 'Resumen & velocidad de cobro', href: `/reportes/cobranzas?tab=resumen${sufijo}` },
    { tab: 'vendedor', label: 'Promedio por vendedor', href: `/reportes/cobranzas?tab=vendedor${sufijo}` },
    { tab: 'cliente', label: 'Promedio por cliente', href: `/reportes/cobranzas?tab=cliente${sufijo}` },
    { tab: 'bancos', label: 'Bancos & canales', href: `/reportes/cobranzas?tab=bancos${sufijo}` },
  ];

  const [aniosLista, resumen] = await Promise.all([aniosDisponibles(db), resumenCobranza(db, filtro)]);

  return (
    <>
      <Encabezado titulo="Cobranzas" descripcion="Réplica del dashboard de ventas, con los datos del ERP (M4)" />
      <Pestanas activa={tab} items={pestanas} />
      <Panel className="mb-5">
        <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="tab" value={tab} />
          {tab === 'resumen' && <input type="hidden" name="base" value={baseAntiguedad} />}
          {tab === 'cliente' && <input type="hidden" name="texto" value={texto} />}
          {tab === 'cliente' && <input type="hidden" name="categoria" value={categoria ?? ''} />}
          <label className="block">
            <span className="mb-1 block text-texto-2">Año (varios o &quot;Todos&quot;)</span>
            <select name="anios" multiple size={Math.min(aniosLista.length, 5) || 1} defaultValue={anios.map(String)} className="campo min-w-[8rem]">
              {aniosLista.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" name="incluir" value="1" defaultChecked={incluirInactivos} className="h-4 w-4" />Incluir inactivos
          </label>
          <button type="submit" className="rounded-lg bg-acento px-4 py-2 font-semibold text-white hover:bg-acento-hover">Aplicar</button>
          <Link href={`/reportes/cobranzas?tab=${tab}`} className="py-2 text-texto-2 hover:text-texto">Todos los años</Link>
        </form>
      </Panel>
      <TarjetasCobranza r={resumen} />
      {tab === 'vendedor' ? (
        <Panel><TablaCobranzaVendedor filas={await cobranzaPorVendedor(db, filtro)} /></Panel>
      ) : tab === 'cliente' ? (
        <PanelCobranzaCliente filas={await cobranzaPorCliente(db, { ...filtro, texto, categoria })} texto={texto}
          categoria={categoria ?? ''} anios={anios} />
      ) : tab === 'bancos' ? (
        <PanelBancosCanales b={await bancosYCanales(db, filtro)} />
      ) : (
        <PanelCobranzaResumen velocidad={await velocidadCobro(db, filtro)} antiguedad={await antiguedadSaldos(db, filtro, baseAntiguedad)}
          baseAntiguedad={baseAntiguedad} tendencia={await tendenciaCobranza(db, filtro)}
          rutaBase={`/reportes/cobranzas?tab=resumen${sufijo}`} />
      )}
    </>
  );
}
