-- ---------------------------------------------------------------------
-- Índice para las vistas de reportes de ventas (solo rendimiento: no cambia ningún resultado)
-- ---------------------------------------------------------------------

-- Las vistas de ventas (vw_venta_documento, vw_venta_linea, vw_nota_credito_linea, vw_rentabilidad_linea)
-- exponen la fecha como (fecha_emision at time zone 'America/Caracas')::date. Con esa expresión exacta, un
-- filtro por rango de fechas puede usar este índice; el de fecha_emision (0030) no sirve para ese filtro.
-- Medido con datos sintéticos (scripts/benchmark-vistas.mts, 300 000 facturas): un trimestre pasa de 357 a 29 ms
-- y un mes por vendedor de 338 a 14 ms. Los índices probados para partida_cxc (abiertas) y cobro (fecha) no
-- mejoraron las consultas y se descartaron.
create index documento_venta_fecha_local_idx
  on documento_venta (((fecha_emision at time zone 'America/Caracas')::date))
  where tipo in ('factura', 'nota_credito') and estado = 'emitido';
