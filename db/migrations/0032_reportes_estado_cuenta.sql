-- =====================================================================
-- 0032 · Movimientos de cuentas por cobrar, para el estado de cuenta del cliente (spec_reportes §4.4, §12)
--
--   R-BY  "Movimiento de CxC" se arma una sola vez, en vw_cxc_movimiento: cada factura y nota de débito abre
--         cargo por su total (igual al monto de su partida); cada nota de crédito aplicada y cada cobro
--         aplicado abonan por el monto en USD que de verdad redujo esa partida (nunca una estimación).
--         Se ordena por el momento exacto (fecha y hora) y, a igualdad, por el orden de creación.
-- =====================================================================

create view vw_cxc_movimiento as
select d.id as origen_id, 'factura'::text as tipo, d.cliente_id, d.fecha_emision as momento,
       d.serie || '-' || d.numero as documento, 'Factura'::text as concepto,
       d.total_usd as cargo_usd, 0::numeric(16,2) as abono_usd, d.created_at as desempate
  from documento_venta d
 where d.tipo = 'factura' and d.estado = 'emitido'
union all
select d.id, 'nota_debito', d.cliente_id, d.fecha_emision, d.serie || '-' || d.numero, 'Nota de débito',
       d.total_usd, 0::numeric(16,2), d.created_at
  from documento_venta d
 where d.tipo = 'nota_debito' and d.estado = 'emitido'
union all
select a.id, 'nota_credito', n.cliente_id, n.fecha_emision, n.serie || '-' || n.numero, 'Nota de crédito',
       0::numeric(16,2), a.usd, a.created_at
  from aplicacion_nota_credito a
  join documento_venta n on n.id = a.nota_id
union all
-- cobro.fecha es solo la fecha del depósito (sin hora): se le pega la hora real de registro, para que el
-- orden estricto por fecha y hora (R-BY) no mande siempre los cobros del día al principio de la lista.
select a.id, 'cobro', c.cliente_id, (c.fecha + a.created_at::time)::timestamptz, 'COB-' || c.numero::text, 'Cobro',
       0::numeric(16,2), a.usd_partida, a.created_at
  from aplicacion_cobro a
  join cobro c on c.id = a.cobro_id
 where not a.revertida and c.estado <> 'anulado';

comment on view vw_cxc_movimiento is
  'Grano movimiento de CxC (factura, nota de débito, nota de crédito aplicada, cobro aplicado). cargo_usd/abono_usd en USD.';
