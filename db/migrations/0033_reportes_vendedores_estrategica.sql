-- =====================================================================
-- 0033 · Parámetro de días sin comprar para la cartera dormida de vendedores (spec_reportes §6.2)
-- =====================================================================

insert into parametro_reporte (codigo, descripcion, valor, unidad) values
  ('DIAS_FUGA_CLIENTE', 'Pestaña "Analítica estratégica" de vendedores: días sin comprar a partir de los cuales un cliente asignado se marca "en riesgo de fuga"', 45, 'dias');
