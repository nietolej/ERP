import type { Db } from '@/lib/db/tipos';

/**
 * M3 · Vendedores, pestaña "Catálogo" (spec_reportes §6.1). Reusa vw_venta_documento y vw_nota_credito_linea
 * (§2, §12: misma venta y devolución de M1 Clientes y M2 Productos) y vw_meta_anual (§10 de metas).
 */

export type OrdenVendedores = 'venta' | 'facturas' | 'clientes';

export interface FiltroVendedores {
  anios?: number[];
  texto?: string;
  orden?: OrdenVendedores;
  incluirAdministrativos?: boolean;
}

export interface FilaCatalogoVendedor {
  id: string;
  codigo: string;
  nombre: string;
  contacto: string | null;
  clientesAtendidos: number;
  facturas: number;
  coberturaCarteraPct: number | null;
  concentracionTop3Pct: number | null;
  ventaTotalUsd: string;
  devolucionesPct: number | null;
  metaUsd: string | null;
  cumplimientoMetaPct: number | null;
}

const ORDEN_SQL: Record<OrdenVendedores, string> = {
  venta: 'venta desc', facturas: 'facturas desc', clientes: 'atendidos desc',
};

const HOY = `((now() at time zone 'America/Caracas')::date)`;

export async function catalogoVendedores(db: Db, f: FiltroVendedores = {}): Promise<FilaCatalogoVendedor[]> {
  const texto = (f.texto ?? '').trim();
  const anios = f.anios && f.anios.length > 0 ? f.anios : null;
  const anioActual = Number((await db.query<{ a: string }>(`select extract(year from ${HOY})::text as a`)).rows[0].a);
  const aniosMeta = f.anios && f.anios.length > 0 ? f.anios : [anioActual];
  const orden = ORDEN_SQL[f.orden ?? 'venta'];

  const { rows } = await db.query<{
    id: string; codigo: string; nombre: string; contacto: string | null; atendidos: string; facturas: string;
    asignados: string; top3: string; venta: string; devolucion: string; meta: string | null;
  }>(
    `with venta as (
       select vendedor_id, sum(base_usd)::numeric(16,2) as venta, count(*) as facturas, count(distinct cliente_id) as atendidos
         from vw_venta_documento
        where ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by vendedor_id
     ), devol as (
       select vendedor_id, sum(base_usd)::numeric(16,2) as devolucion
         from vw_nota_credito_linea
        where motivo_nc = 'devolucion' and ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by vendedor_id
     ), venta_cliente as (
       select vendedor_id, cliente_id, sum(base_usd) as venta
         from vw_venta_documento
        where ($1::int[] is null or extract(year from fecha)::int = any($1::int[]))
        group by vendedor_id, cliente_id
     ), top3 as (
       select vendedor_id, sum(venta)::numeric(16,2) as top3
         from (select vendedor_id, venta, row_number() over (partition by vendedor_id order by venta desc) as rn from venta_cliente) x
        where rn <= 3
        group by vendedor_id
     ), asignados as (
       select vendedor_id, count(*) as asignados from cliente where estado = 'activo' and vendedor_id is not null group by vendedor_id
     ), meta as (
       select entidad_id as vendedor_id, sum(monto_usd)::numeric(16,2) as meta
         from vw_meta_anual where tipo = 'vendedor' and anio = any($2::int[]) group by entidad_id
     )
     select v.id, v.codigo, v.nombre, coalesce(u.email, t.email, t.telefono) as contacto,
            coalesce(venta.atendidos, 0)::text as atendidos, coalesce(venta.facturas, 0)::text as facturas,
            coalesce(asignados.asignados, 0)::text as asignados,
            coalesce(top3.top3, 0::numeric(16,2))::text as top3, coalesce(venta.venta, 0::numeric(16,2))::text as venta,
            coalesce(devol.devolucion, 0::numeric(16,2))::text as devolucion, meta.meta::text as meta
       from vendedor v
       left join usuario u on u.id = v.usuario_id
       left join tercero t on t.id = v.tercero_id
       left join venta on venta.vendedor_id = v.id
       left join devol on devol.vendedor_id = v.id
       left join top3 on top3.vendedor_id = v.id
       left join asignados on asignados.vendedor_id = v.id
       left join meta on meta.vendedor_id = v.id
      where v.estado = 'activo'
        and ($3::boolean or v.tipo in ('interno', 'externo'))
        and ($4 = '' or v.codigo ilike '%' || $4 || '%' or fn_nombre_normalizado(v.nombre) like '%' || fn_nombre_normalizado($4) || '%')
      order by ${orden}`,
    [anios, aniosMeta, Boolean(f.incluirAdministrativos), texto]);

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);
  return rows.map((r) => {
    const venta = Number(r.venta);
    const metaUsd = r.meta;
    return {
      id: r.id, codigo: r.codigo, nombre: r.nombre, contacto: r.contacto,
      clientesAtendidos: Number(r.atendidos), facturas: Number(r.facturas),
      coberturaCarteraPct: pct(Number(r.atendidos), Number(r.asignados)),
      concentracionTop3Pct: pct(Number(r.top3), venta),
      ventaTotalUsd: r.venta, devolucionesPct: pct(Number(r.devolucion), venta),
      metaUsd, cumplimientoMetaPct: metaUsd !== null && Number(metaUsd) > 0 ? (venta / Number(metaUsd)) * 100 : null,
    };
  });
}
