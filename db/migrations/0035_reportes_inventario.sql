-- =====================================================================
-- 0035 · Parámetro de días de cobertura para el sugerido de compra (spec_reportes §9.1)
-- =====================================================================

insert into parametro_inventario (codigo, descripcion, valor, unidad) values
  ('DIAS_COBERTURA_COMPRA', 'Sugerido de compra: días de venta que se quieren cubrir con existencia, tránsito y producción', 90, 'dias');
