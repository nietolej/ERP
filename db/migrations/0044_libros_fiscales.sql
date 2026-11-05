-- =====================================================================
-- 0044 · Libros de ventas y de compras (spec §11.4, Reglamento de la Ley de IVA art. 75 y siguientes)
--
--   R-CT  Los libros son VISTAS sobre los documentos ya emitidos: una sola fuente, sin tablas aparte que puedan desviarse.
--   R-CU  Grano: documento × alícuota (la alícuota sale de la línea del documento, nunca del código). Importes en bolívares: el documento
--         en otra moneda se convierte con su tasa congelada. Las notas de crédito restan; las de débito suman.
--   R-CV  El periodo es el mes calendario de la fecha del documento. Los anulados de ventas aparecen marcados (incluido = false) y no suman.
--         Las compras no se anulan: se corrigen con notas del proveedor.
--   R-CW  El IGTF no entra en estos libros (va en su propio reporte, §11.3). El IVA de un gasto sin derecho a crédito fiscal se muestra,
--         pero su crédito fiscal es cero.
-- =====================================================================

create view vw_libro_ventas as
select date_trunc('month', x.fecha)::date as periodo,
       x.fecha, x.tipo, x.estado, (x.estado = 'emitido') as incluido, x.documento_id,
       x.serie || '-' || x.numero as numero_documento, x.numero_control, x.contingencia,
       x.fecha_anulacion,
       (select o.serie || '-' || o.numero from documento_venta o where o.id = x.documento_origen_id) as documento_afectado,
       x.cliente_id, t.rif, t.razon_social,
       x.alicuota_iva_id, x.alicuota_pct, a.tipo_libro,
       x.signo * round(x.base * x.factor, 2) as base_ves,
       x.signo * round(x.iva * x.factor, 2) as iva_ves
  from (
    select d.id as documento_id, d.tipo, d.estado, d.serie, d.numero, d.numero_control, d.contingencia, d.cliente_id, d.documento_origen_id,
           (d.fecha_emision at time zone 'America/Caracas')::date as fecha,
           (d.anulado_at at time zone 'America/Caracas')::date as fecha_anulacion,
           case when d.moneda = 'VES' then 1 else d.tasa end as factor,
           case when d.tipo = 'nota_credito' then -1 else 1 end as signo,
           l.alicuota_iva_id, l.alicuota_pct, sum(l.base) as base, sum(l.iva) as iva
      from documento_venta d join documento_venta_linea l on l.documento_id = d.id
     where d.tipo in ('factura', 'nota_credito', 'nota_debito') and d.estado in ('emitido', 'anulado')
     group by d.id, l.alicuota_iva_id, l.alicuota_pct) x
  join tercero t on t.id = x.cliente_id
  join alicuota_iva a on a.id = x.alicuota_iva_id;

comment on view vw_libro_ventas is 'Libro de ventas (§11.4). Grano documento × alícuota, en bolívares. Sumar solo las filas con incluido = true.';

create view vw_libro_compras as
-- Facturas de compra de mercancía (contabilizadas)
select date_trunc('month', f.fecha_factura)::date as periodo, f.fecha_factura as fecha, 'factura'::text as origen, 'factura'::text as tipo, f.id as documento_id,
       f.numero_factura as numero_documento, f.numero_control, null::text as documento_afectado, f.proveedor_id, t.rif, t.razon_social,
       l.alicuota_iva_id, l.alicuota_pct, a.tipo_libro,
       round(sum(l.base) * f.tasa, 2) as base_ves, round(sum(l.iva) * f.tasa, 2) as iva_ves, round(sum(l.iva) * f.tasa, 2) as credito_ves
  from factura_compra f join factura_compra_linea l on l.factura_id = f.id join tercero t on t.id = f.proveedor_id join alicuota_iva a on a.id = l.alicuota_iva_id
 where f.estado = 'contabilizada'
 group by f.id, t.rif, t.razon_social, l.alicuota_iva_id, l.alicuota_pct, a.tipo_libro
union all
-- Gastos de importación (flete, seguro, aranceles…)
select date_trunc('month', g.fecha_factura)::date, g.fecha_factura, 'gasto_importacion', 'factura', g.id,
       g.numero_factura, g.numero_control, null, g.proveedor_id, t.rif, t.razon_social,
       g.alicuota_iva_id, g.alicuota_pct, a.tipo_libro,
       round(g.base * g.tasa, 2), round(g.iva * g.tasa, 2), round(g.iva * g.tasa, 2)
  from gasto_importacion g join tercero t on t.id = g.proveedor_id join alicuota_iva a on a.id = g.alicuota_iva_id
 where g.estado = 'contabilizado'
union all
-- Facturas de gasto de proveedores de servicios: sin derecho a crédito fiscal si la categoría no lo admite
select date_trunc('month', g.fecha_factura)::date, g.fecha_factura, 'gasto', 'factura', g.id,
       g.numero_factura, g.numero_control, null, g.proveedor_id, t.rif, t.razon_social,
       g.alicuota_iva_id, g.alicuota_pct, a.tipo_libro,
       round(g.base * g.tasa, 2), round(g.iva * g.tasa, 2), case when g.iva_deducible then round(g.iva * g.tasa, 2) else 0.00 end
  from gasto_proveedor g join tercero t on t.id = g.proveedor_id join alicuota_iva a on a.id = g.alicuota_iva_id
 where g.estado = 'contabilizado'
union all
-- Notas de crédito (restan) y de débito (suman) del proveedor, aprobadas
select date_trunc('month', n.fecha)::date, n.fecha, 'nota', n.tipo, n.id,
       n.numero_documento, n.numero_control, f.numero_factura, n.proveedor_id, t.rif, t.razon_social,
       fl.alicuota_iva_id, fl.alicuota_pct, a.tipo_libro,
       (case when n.tipo = 'nota_credito' then -1 else 1 end) * round(sum(l.base) * n.tasa, 2),
       (case when n.tipo = 'nota_credito' then -1 else 1 end) * round(sum(l.iva) * n.tasa, 2),
       (case when n.tipo = 'nota_credito' then -1 else 1 end) * round(sum(l.iva) * n.tasa, 2)
  from nota_proveedor n join nota_proveedor_linea l on l.nota_id = n.id join factura_compra_linea fl on fl.id = l.factura_linea_id
  join factura_compra f on f.id = n.factura_id join tercero t on t.id = n.proveedor_id join alicuota_iva a on a.id = fl.alicuota_iva_id
 where n.estado = 'aprobada'
 group by n.id, f.numero_factura, t.rif, t.razon_social, fl.alicuota_iva_id, fl.alicuota_pct, a.tipo_libro;

comment on view vw_libro_compras is 'Libro de compras (§11.4). Grano documento × alícuota, en bolívares; credito_ves es el IVA con derecho a crédito fiscal.';

-- Retenciones practicadas por documento (las notas de crédito restan lo retenido), en bolívares.
create view vw_libro_compras_retencion as
select coalesce(r.factura_id, r.gasto_id, r.gasto_proveedor_id, r.nota_id) as documento_id, r.impuesto,
       date_trunc('month', r.fecha)::date as periodo, r.fecha,
       r.signo * round(r.monto * r.tasa, 2) as monto_ves
  from retencion_compra r;

comment on view vw_libro_compras_retencion is 'Retenciones de IVA e ISLR por documento de compra, en bolívares (signo −1 en notas de crédito).';
