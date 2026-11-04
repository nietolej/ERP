-- =====================================================================
-- 0034 · Parámetros de M5 Devoluciones (spec_reportes §8)
--
--   Los umbrales de la tasa de devolución, del nivel de riesgo por cliente y de la alerta de defecto por producto son
--   parámetros, no constantes del código. El costo por devolución NO tiene valor inicial: mientras no se cargue, la
--   tarjeta "Costo operativo estimado" no se muestra (en el dashboard eran US$ 15 fijos).
-- =====================================================================

alter table parametro_reporte drop constraint parametro_reporte_unidad_check;
alter table parametro_reporte add constraint parametro_reporte_unidad_check check (unidad in ('dias', 'porcentaje', 'unidades', 'usd'));

insert into parametro_reporte (codigo, descripcion, valor, unidad) values
  ('DEVOLUCION_TASA_UMBRAL_PCT',   'Devoluciones: la tarjeta de tasa de devolución financiera se marca en rojo si supera este porcentaje', 5, 'porcentaje'),
  ('DEVOLUCION_RIESGO_CRITICO_PCT','Devoluciones por cliente: nivel de riesgo CRÍTICO si el porcentaje de devolución supera este valor', 8, 'porcentaje'),
  ('DEVOLUCION_RIESGO_MODERADO_PCT','Devoluciones por cliente: nivel de riesgo MODERADO si el porcentaje de devolución supera este valor', 3, 'porcentaje'),
  ('DEFECTO_PCT',                  'Devoluciones por producto: ALERTA DEFECTO si el porcentaje de devolución en volumen supera este valor', 5, 'porcentaje'),
  ('DEFECTO_UNIDADES_MINIMAS',     'Devoluciones por producto: ALERTA DEFECTO solo si se devolvieron al menos estas unidades', 5, 'unidades');
