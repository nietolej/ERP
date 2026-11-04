-- =====================================================================
-- 0036 · M7 Análisis Avanzado (spec_reportes §14) y condición de pago congelada en la factura (decisiones 16 y 17)
--
--   R-BU  La factura congela la condición de pago de su cliente al emitirse (condicion_pago_id y dias_credito), igual que
--         la moneda y la tasa (§3.4). Es una columna del encabezado: un documento emitido no se edita, así que nadie puede
--         cambiarla después. El reporte de morosidad compara contra el plazo que tenía la factura, no el actual del cliente.
--   R-BV  Los tramos de monto de pedido salen de fn_tramo_pedido y los parámetros HISTOGRAMA_PEDIDOS_*; el histograma
--         (§14.1) y la morosidad (§14.2) usan los mismos tramos.
--   R-BW  Un episodio de quiebre es un tramo de días consecutivos con existencia ≤ 0 en un almacén que vende, precedido
--         de un periodo con existencia. Se define una sola vez, en vw_quiebre_episodio (§14.3 y §14.4).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Condición de pago congelada en la factura. Las facturas anteriores a esta migración (solo existen en bases de
-- desarrollo; el ERP nace con la base vacía) no la tienen: el reporte usa entonces vencimiento − emisión.
-- ---------------------------------------------------------------------
alter table documento_venta
  add column condicion_pago_id uuid references condicion_pago(id),
  add column dias_credito      smallint check (dias_credito between 0 and 365);

-- ---------------------------------------------------------------------
-- Parámetros de M7 (valores de referencia: decisión 16)
-- ---------------------------------------------------------------------
insert into parametro_reporte (codigo, descripcion, valor, unidad) values
  ('HISTOGRAMA_PEDIDOS_TRAMO_USD',     'Histograma de pedidos: ancho de cada tramo de monto', 50, 'usd'),
  ('HISTOGRAMA_PEDIDOS_TOPE_USD',      'Histograma de pedidos: monto a partir del cual el pedido entra en el tramo abierto "más de"', 1000, 'usd'),
  ('MOROSIDAD_PATRON_PCT',             'Patrones de morosidad: se marca la celda si el porcentaje de facturas en mora llega a este valor', 20, 'porcentaje'),
  ('VENTANA_VELOCIDAD_QUIEBRE_DIAS',   'Velocidad tras quiebre: días que se comparan antes del quiebre y después de la reposición', 15, 'dias');

-- Índice del tramo de un pedido: 0 = [0, tramo), 1 = [tramo, 2·tramo)…; el último índice es el tramo abierto.
create function fn_tramo_pedido(p_monto_usd numeric) returns int
language plpgsql stable as $$
declare
  v_tramo numeric := fn_parametro_reporte('HISTOGRAMA_PEDIDOS_TRAMO_USD');
  v_tope  numeric := fn_parametro_reporte('HISTOGRAMA_PEDIDOS_TOPE_USD');
begin
  if v_tramo <= 0 or v_tope < v_tramo then
    raise exception 'Los parámetros del histograma de pedidos son inválidos: el tramo debe ser mayor que cero y el tope no menor que el tramo';
  end if;
  return least(floor(greatest(p_monto_usd, 0) / v_tramo)::int, ceil(v_tope / v_tramo)::int);
end $$;

-- ---------------------------------------------------------------------
-- Cobro aplicado: se agrega la factura a la que se aplicó (columna nueva al final, no cambia lo existente)
-- ---------------------------------------------------------------------
create or replace view vw_cobro_aplicado as
select a.id, c.fecha, c.cliente_id, f.vendedor_id, c.instrumento_id, c.cuenta_bancaria_id,
       a.usd_partida as monto_usd, (c.fecha - p.fecha) as dias_pago,
       f.id as factura_id
  from aplicacion_cobro a
  join cobro c on c.id = a.cobro_id
  join partida_cxc p on p.id = a.partida_id
  join documento_venta f on f.id = p.documento_id
 where c.estado <> 'anulado' and not a.revertida;

-- ---------------------------------------------------------------------
-- Pedido (= factura) con su plazo, su comportamiento de cobro y su mora (§14.1, §14.2)
--
--   dias_credito  el congelado en la factura; si no lo tiene (factura anterior a esta migración), vencimiento − emisión
--   cobrado_usd / dias_ponderados  Σ monto aplicado y Σ monto × días de pago (promedio ponderado = ponderados ÷ cobrado)
--   en_mora       la partida sigue abierta y ya venció (vw_cxc_antiguedad.dias_vencida > 0)
-- ---------------------------------------------------------------------
create view vw_pedido_morosidad as
select d.id, d.fecha, d.cliente_id, d.vendedor_id, d.sucursal_id, d.base_usd, d.saldo_usd,
       fn_tramo_pedido(d.base_usd) as tramo,
       coalesce(f.dias_credito, f.fecha_vencimiento - d.fecha)::int as dias_credito,
       coalesce(c.cobrado, 0) as cobrado_usd, coalesce(c.ponderado, 0) as dias_ponderados,
       coalesce(a.dias_vencida, 0) > 0 as en_mora
  from vw_venta_documento d
  join documento_venta f on f.id = d.id
  left join vw_cxc_antiguedad a on a.documento_id = d.id
  left join lateral (
    select sum(x.monto_usd) as cobrado, sum(x.monto_usd * x.dias_pago) as ponderado
      from vw_cobro_aplicado x where x.factura_id = d.id) c on true;

-- ---------------------------------------------------------------------
-- Episodios de quiebre por producto y almacén que vende (§14.3, §14.4)
--
--   Existencia diaria escalonada: un registro por cambio. Un episodio empieza cuando la existencia pasa de > 0 a ≤ 0 y
--   termina el día en que vuelve a ser > 0 (reposicion; null si sigue en quiebre). La existencia que nace en cero no es
--   un episodio: antes no hubo existencia que se agotara.
--   velocidad = unidades vendidas netas de devoluciones en la ventana ÷ días de la ventana. La de después solo existe si
--   la ventana completa ya transcurrió. venta_perdida_usd = días del episodio × velocidad antes × precio de la lista A
--   de hoy (la misma idea de §9.1, referida al episodio).
-- ---------------------------------------------------------------------
create view vw_quiebre_episodio as
with par as (
  select fn_parametro_reporte('VENTANA_VELOCIDAD_QUIEBRE_DIAS')::int as ventana, ((now() at time zone 'America/Caracas')::date) as hoy
),
iv as (
  select e.producto_id, e.almacen_id, e.fecha as ini, e.cantidad,
         lead(e.fecha) over (partition by e.producto_id, e.almacen_id order by e.fecha) as fin,
         lag(e.cantidad) over (partition by e.producto_id, e.almacen_id order by e.fecha) as previa
    from existencia_diaria e join almacen a on a.id = e.almacen_id and a.permite_venta
),
marcado as (
  select iv.*, (cantidad <= 0) as agotado, (cantidad <= 0 and coalesce(previa, 0) > 0)::int as inicio
    from iv
),
grupo as (
  select m.*, sum(inicio) over (partition by producto_id, almacen_id order by ini) as g from marcado m
),
episodio as (
  select producto_id, almacen_id, min(ini) as inicio,
         case when bool_or(fin is null) then null else max(fin) end as reposicion
    from grupo where agotado and g > 0
   group by producto_id, almacen_id, g
)
select ep.producto_id, ep.almacen_id, ep.inicio, ep.reposicion,
       (coalesce(ep.reposicion, par.hoy) - ep.inicio)::int as duracion_dias,
       (antes.u / par.ventana)::numeric(14,4) as velocidad_antes,
       (despues.u / par.ventana)::numeric(14,4) as velocidad_despues,
       case when antes.u > 0 and despues.u is not null then round((despues.u - antes.u) / antes.u * 100, 2) end as variacion_pct,
       round((coalesce(ep.reposicion, par.hoy) - ep.inicio) * (antes.u / par.ventana) * coalesce(fn_precio(ep.producto_id, 'A', par.hoy), 0), 2) as venta_perdida_usd
  from episodio ep cross join par
  left join lateral (
    select greatest(-coalesce(sum(m.cantidad), 0), 0) as u from movimiento_inventario m
     where m.producto_id = ep.producto_id and m.almacen_id = ep.almacen_id and m.tipo in ('salida_venta', 'devolucion_cliente')
       and (m.fecha at time zone 'America/Caracas')::date between ep.inicio - par.ventana and ep.inicio - 1) antes on true
  left join lateral (
    select greatest(-coalesce(sum(m.cantidad), 0), 0) as u from movimiento_inventario m
     where m.producto_id = ep.producto_id and m.almacen_id = ep.almacen_id and m.tipo in ('salida_venta', 'devolucion_cliente')
       and (m.fecha at time zone 'America/Caracas')::date between ep.reposicion and ep.reposicion + par.ventana - 1) despues
    on ep.reposicion is not null and ep.reposicion + par.ventana - 1 <= par.hoy;
