-- =====================================================================
-- 0031 · Vistas de línea de venta, notas de crédito y cobro aplicado; parámetros de insight (spec_reportes §2, §4, §12)
--
--   R-BS  "Venta bruta", "descuento de línea", "ítems vendidos" y "devolución" se calculan una sola vez, en
--         vw_venta_linea y vw_nota_credito_linea, con la misma fórmula de conversión a USD que vw_venta_documento
--         (la tasa congelada del propio documento). Los reportes de clientes, productos y vendedores las reusan.
--   R-BT  "Días de pago" sale del enlace real entre el cobro y la factura (vw_cobro_aplicado), nunca de una
--         estimación: fecha del cobro menos fecha de emisión de la partida que cubre.
-- =====================================================================

create table parametro_reporte (
  codigo      varchar(40) primary key check (codigo ~ '^[A-Z_]+$'),
  descripcion text not null,
  valor       numeric(14,4) not null check (valor >= 0),
  unidad      text not null check (unidad in ('dias', 'porcentaje'))
);
insert into parametro_reporte (codigo, descripcion, valor, unidad) values
  ('INSIGHT_DEVOLUCION_PCT',             'Panel de insight de clientes: alerta si el índice de devolución en monto supera este porcentaje', 5,   'porcentaje'),
  ('INSIGHT_CUMPLIMIENTO_TENDENCIA_PCT', 'Panel de insight de clientes: felicita si el cumplimiento de la tendencia frente a la meta supera este porcentaje', 100, 'porcentaje');
create trigger parametro_reporte_audit after insert or update or delete on parametro_reporte for each row execute function fn_audit();

create function fn_parametro_reporte(p_codigo text) returns numeric
language plpgsql stable as $$
declare v numeric;
begin
  select valor into v from parametro_reporte where codigo = p_codigo;
  if v is null then
    raise exception 'Falta configurar el parámetro de reporte %', p_codigo;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Línea de factura emitida, con la misma conversión a USD de vw_venta_documento (base sin IVA ni IGTF)
-- ---------------------------------------------------------------------
create view vw_venta_linea as
select l.id, l.documento_id, (d.fecha_emision at time zone 'America/Caracas')::date as fecha,
       d.cliente_id, d.vendedor_id, d.sucursal_id, d.almacen_id,
       l.producto_id, p.producto_base_id, pb.categoria_id, p.grupo_id, p.marca_id, p.linea_calidad,
       l.cantidad, l.precio_lista, l.precio_unitario, l.descuento_pct, l.promocion_id,
       case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as base_usd,
       case when d.moneda = 'VES' then round((round(l.cantidad * l.precio_unitario, 2) - l.base) / d.tasa, 2)
            else round(l.cantidad * l.precio_unitario, 2) - l.base end as descuento_usd,
       -- Venta bruta (§2): cantidad × precio de lista, antes de descuentos. precio_lista queda en la moneda del
       -- documento (se copia convertido al facturar una nota de entrega en USD), así que se convierte igual que base_usd.
       case when d.moneda = 'VES' then round(l.cantidad * l.precio_lista / d.tasa, 2) else round(l.cantidad * l.precio_lista, 2) end as venta_bruta_usd,
       l.costo_unitario_usd
  from documento_venta_linea l
  join documento_venta d on d.id = l.documento_id
  join producto p on p.id = l.producto_id
  left join producto_base pb on pb.id = p.producto_base_id
 where d.tipo = 'factura' and d.estado = 'emitido';

-- ---------------------------------------------------------------------
-- Línea de nota de crédito emitida (R-BS). motivo_nc viaja en cada línea para no repetir el join en los reportes.
-- ---------------------------------------------------------------------
create view vw_nota_credito_linea as
select l.id, l.documento_id, (d.fecha_emision at time zone 'America/Caracas')::date as fecha, d.motivo_nc,
       d.cliente_id, d.vendedor_id, d.documento_origen_id as factura_id, l.producto_id, l.cantidad,
       case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as base_usd
  from documento_venta_linea l
  join documento_venta d on d.id = l.documento_id
 where d.tipo = 'nota_credito' and d.estado = 'emitido';

-- ---------------------------------------------------------------------
-- Aplicación de cobro → factura (R-BT): el monto en USD es el que redujo el saldo de esa partida, a la tasa de su factura.
-- ---------------------------------------------------------------------
create view vw_cobro_aplicado as
select a.id, c.fecha, c.cliente_id, f.vendedor_id, c.instrumento_id, c.cuenta_bancaria_id,
       a.usd_partida as monto_usd, (c.fecha - p.fecha) as dias_pago
  from aplicacion_cobro a
  join cobro c on c.id = a.cobro_id
  join partida_cxc p on p.id = a.partida_id
  join documento_venta f on f.id = p.documento_id
 where c.estado <> 'anulado' and not a.revertida;
