-- =====================================================================
-- 0052 · Rentabilidad por dimensión (spec §12.5)
--
--   R-DT  El margen se calcula una sola vez, en vw_rentabilidad_linea, a partir de las líneas de las facturas emitidas y de las notas de crédito
--         emitidas (nunca las anuladas ni las de apertura). Todas las cifras en USD (gestión), con la conversión de cada documento:
--           venta               base sin IVA ni IGTF de la factura, ya neta de los descuentos de línea (glosario §2 de spec_reportes);
--           devolución          nota de crédito con motivo `devolucion`;
--           descuento posterior nota de crédito `descuento_comercial` o `ajuste_precio`;
--           pronto pago         nota de crédito `pronto_pago`;
--           costo               cantidad × foto del costo de la línea al despachar; la devolución resta el costo que reingresa al inventario
--                               (la nota copia el costo de la línea de la factura, como el asiento de reingreso).
--         Venta neta = venta − devoluciones − descuentos posteriores − pronto pago (la misma de 4.1.01 − 4.1.02 − 4.1.03 del estado de resultados).
--         Margen = venta neta − costo. Las comisiones se restan cuando exista su devengo (Fase 6).
-- =====================================================================

create view vw_rentabilidad_linea as
select (d.fecha_emision at time zone 'America/Caracas')::date as fecha,
       d.cliente_id, d.vendedor_id, d.sucursal_id, l.producto_id, p.grupo_id, p.marca_id,
       case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as venta_usd,
       case when d.moneda = 'VES' then round((round(l.cantidad * l.precio_unitario, 2) - l.base) / d.tasa, 2)
            else round(l.cantidad * l.precio_unitario, 2) - l.base end as descuento_linea_usd,
       0::numeric as devolucion_usd, 0::numeric as descuento_posterior_usd, 0::numeric as pronto_pago_usd,
       coalesce(round(l.cantidad * l.costo_unitario_usd, 2), 0) as costo_usd
  from documento_venta_linea l
  join documento_venta d on d.id = l.documento_id
  join producto p on p.id = l.producto_id
 where d.tipo = 'factura' and d.estado = 'emitido' and not d.apertura
union all
select (d.fecha_emision at time zone 'America/Caracas')::date,
       d.cliente_id, d.vendedor_id, d.sucursal_id, l.producto_id, p.grupo_id, p.marca_id,
       0, 0,
       case when d.motivo_nc = 'devolucion' then b.usd else 0 end,
       case when d.motivo_nc in ('descuento_comercial', 'ajuste_precio') then b.usd else 0 end,
       case when d.motivo_nc = 'pronto_pago' then b.usd else 0 end,
       case when d.motivo_nc = 'devolucion' then -coalesce(round(l.cantidad * l.costo_unitario_usd, 2), 0) else 0 end
  from documento_venta_linea l
  join documento_venta d on d.id = l.documento_id
  join producto p on p.id = l.producto_id
  cross join lateral (select case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as usd) b
 where d.tipo = 'nota_credito' and d.estado = 'emitido' and not d.apertura;

comment on view vw_rentabilidad_linea is 'Grano línea de factura y de nota de crédito emitidas, en USD. Única fuente del margen por dimensión (R-DT).';
