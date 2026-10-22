-- =====================================================================
-- 0030 · Vista de venta por documento y tarjetas de Inicio (spec_reportes §2, §3, §12)
--
--   R-BR  "Venta" se calcula una sola vez, en vw_venta_documento: factura emitida (nunca anulada ni de apertura),
--         monto = base sin IVA ni IGTF, convertido a USD con la tasa congelada del documento. Los reportes nunca
--         repiten esta cuenta con su propia regla.
-- =====================================================================

create view vw_venta_documento as
select d.id,
       (d.fecha_emision at time zone 'America/Caracas')::date as fecha,
       d.cliente_id, d.vendedor_id, d.sucursal_id, d.moneda, d.tasa,
       case when d.moneda = 'VES' then round((d.base_imponible + d.exento) / d.tasa, 2) else d.base_imponible + d.exento end as base_usd,
       d.total_usd,
       coalesce(p.saldo_usd, 0) as saldo_usd,
       (p.id is not null and p.estado = 'cancelada') as cancelada,
       (select max(a.fecha) from aplicacion_cobro a where a.partida_id = p.id and a.liquida and not a.revertida) as fecha_cancelacion
  from documento_venta d
  left join partida_cxc p on p.documento_id = d.id
 where d.tipo = 'factura' and d.estado = 'emitido';
create index documento_venta_fecha_idx on documento_venta (tipo, estado, fecha_emision);

comment on view vw_venta_documento is 'Grano factura. "Venta" (glosario §2) = base_usd. Única fuente para todos los reportes comerciales.';
