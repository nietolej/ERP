-- =====================================================================
-- 0022 · Medidas y empaque del producto (§5.3, §7.2 regla 3)
--
--   R-U  Para repartir flete, seguro y gastos de importación entre las líneas de una compra
--        por peso, volumen o cantidad, cada producto guarda sus medidas:
--          · unidad (ya existía)   unidad de medida de venta e inventario (UND, JGO, PAR, LT…)
--          · peso_kg (ya existía)  peso de UNA unidad de venta
--          · empaque               cómo viene embalado: unidad de empaque (CJA, BLT…),
--                                  unidades de venta por empaque, peso bruto y dimensiones
--        El volumen del empaque y el de una unidad se calculan en la base, nunca se digitan.
--   R-V  Las tres dimensiones van juntas o ninguna; todas mayores que cero.
-- =====================================================================

alter table producto
  add column empaque_unidad       varchar(10) check (empaque_unidad is null or empaque_unidad ~ '^[A-Z]{1,10}$'),
  add column unidades_por_empaque numeric(12,3) not null default 1 check (unidades_por_empaque > 0),
  add column empaque_peso_kg      numeric(10,3) check (empaque_peso_kg is null or empaque_peso_kg > 0),
  add column empaque_largo_cm     numeric(8,2) check (empaque_largo_cm > 0),
  add column empaque_ancho_cm     numeric(8,2) check (empaque_ancho_cm > 0),
  add column empaque_alto_cm      numeric(8,2) check (empaque_alto_cm > 0),
  add constraint producto_empaque_dimensiones_completas check (
    (empaque_largo_cm is null) = (empaque_ancho_cm is null) and (empaque_ancho_cm is null) = (empaque_alto_cm is null)),
  -- Volumen de un empaque completo (m³) y de una unidad de venta (m³).
  add column empaque_volumen_m3 numeric generated always as
    (empaque_largo_cm * empaque_ancho_cm * empaque_alto_cm / 1000000) stored,
  add column volumen_unitario_m3 numeric generated always as
    (empaque_largo_cm * empaque_ancho_cm * empaque_alto_cm / 1000000 / unidades_por_empaque) stored;

comment on column producto.peso_kg              is 'Peso de una unidad de venta (kg)';
comment on column producto.empaque_peso_kg      is 'Peso bruto de un empaque completo (kg)';
comment on column producto.volumen_unitario_m3  is 'Volumen de una unidad de venta (m³): volumen del empaque ÷ unidades por empaque';
