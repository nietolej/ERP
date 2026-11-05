-- =====================================================================
-- 0053 · Comisiones de venta con base cobrada (spec §9; decisión 6)
--
--   R-DU  Un plan de comisión es un conjunto de reglas por grupo de producto y marca (la primera por prioridad que aplica gana; sin grupo ni marca
--         es la regla general). Nace borrador, se envía y lo aprueba Gerencia, distinta de quien lo creó; aprobado no se edita. Un vendedor comercial
--         (interno o externo) tiene el plan que Gerencia o el Supervisor de ventas le asignan por fechas, sin traslapes: el plan que cuenta es el vigente
--         en la fecha de la factura.
--   R-DV  La comisión se devenga al aplicar un cobro a una factura (base cobrada: lo cobrado sin IVA ni IGTF, en USD a la tasa de la factura) y se
--         revierte al emitir una nota de crédito sobre esa factura o al anular el cobro. Cada movimiento es inmutable y guarda su cálculo; solo cambia
--         su liquidación, una vez. Las facturas de apertura y los vendedores administrativos o de la casa no comisionan.
--   R-DW  Liquidación mensual por vendedor: pendiente → aprobada (Gerencia, que no puede ser el vendedor beneficiario) → pagada (Tesorería, con asiento
--         contra el banco). Rechazada, libera sus movimientos. Una liquidación solo se arma con neto positivo.
--   R-DX  Asientos: devengo (gasto de comisiones contra comisiones por pagar), reversión (el inverso, al mismo valor en VES del devengo) y pago
--         (comisiones por pagar contra banco, con el diferencial cambiario contra el valor en libros).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Planes y reglas
-- ---------------------------------------------------------------------
create table plan_comision (
  id               uuid primary key default gen_random_uuid(),
  nombre           text not null check (length(trim(nombre)) > 2),
  base             text not null default 'cobrado' check (base = 'cobrado'),
  estado           text not null default 'borrador' check (estado in ('borrador', 'pendiente', 'aprobado', 'rechazado')),
  creado_por       uuid not null references usuario(id),
  created_at       timestamptz not null default now(),
  aprobado_por     uuid references usuario(id),
  aprobado_at      timestamptz,
  rechazo_motivo   text,
  check (estado <> 'aprobado' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index plan_comision_nombre_unico on plan_comision (lower(trim(nombre)));

create table plan_comision_regla (
  id                 uuid primary key default gen_random_uuid(),
  plan_id            uuid not null references plan_comision(id),
  prioridad          int not null check (prioridad > 0),
  grupo_producto_id  uuid references grupo_producto(id),
  marca_id           uuid references marca(id),
  porcentaje         numeric(5,2) not null check (porcentaje >= 0 and porcentaje <= 100),
  unique (plan_id, prioridad)
);

create function fn_plan_comision_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un plan de comisión enviado o aprobado no se borra';
    end if;
    delete from plan_comision_regla where plan_id = old.id;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un plan de comisión nace borrador';
    end if;
    if not (fn_tiene_rol(new.creado_por, 'gerencia') or fn_tiene_rol(new.creado_por, 'supervisor_ventas')) then
      raise exception 'Solo Gerencia o el Supervisor de ventas crean planes de comisión';
    end if;
    return new;
  end if;
  if new.nombre is distinct from old.nombre or new.base <> old.base or new.creado_por <> old.creado_por then
    raise exception 'Un plan de comisión no cambia su nombre ni su base';
  end if;
  if new.estado = old.estado then
    return new;
  end if;
  if old.estado = 'borrador' and new.estado = 'pendiente' then
    if not exists (select 1 from plan_comision_regla where plan_id = old.id) then
      raise exception 'Un plan necesita al menos una regla para enviarse a aprobación';
    end if;
  elsif old.estado = 'pendiente' and new.estado = 'aprobado' then
    if new.aprobado_por is null or new.aprobado_por = old.creado_por or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Gerencia, distinta de quien creó el plan, lo aprueba';
    end if;
    new.aprobado_at := coalesce(new.aprobado_at, now());
  elsif old.estado = 'pendiente' and new.estado = 'rechazado' then
    null;
  else
    raise exception 'Cambio de estado del plan no permitido (% → %)', old.estado, new.estado;
  end if;
  return new;
end $$;
create trigger plan_comision_antes before insert or update or delete on plan_comision for each row execute function fn_plan_comision_antes();

create function fn_plan_regla_antes() returns trigger
language plpgsql as $$
declare
  v_plan uuid := case when tg_op = 'DELETE' then old.plan_id else new.plan_id end;
begin
  if (select estado from plan_comision where id = v_plan) <> 'borrador' then
    raise exception 'Las reglas de un plan enviado o aprobado no se modifican: cree un plan nuevo';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger plan_comision_regla_antes before insert or update or delete on plan_comision_regla for each row execute function fn_plan_regla_antes();

-- ---------------------------------------------------------------------
-- Asignación del plan a cada vendedor, por fechas
-- ---------------------------------------------------------------------
create table vendedor_plan (
  id              uuid primary key default gen_random_uuid(),
  vendedor_id     uuid not null references vendedor(id),
  plan_id         uuid not null references plan_comision(id),
  vigente_desde   date not null,
  vigente_hasta   date,
  asignado_por    uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);
create index vendedor_plan_idx on vendedor_plan (vendedor_id, vigente_desde);

create function fn_vendedor_plan_antes() returns trigger
language plpgsql as $$
declare
  v_tipo text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una asignación de plan no se borra: se cierra con fecha final';
  end if;
  if tg_op = 'INSERT' then
    if not (fn_tiene_rol(new.asignado_por, 'gerencia') or fn_tiene_rol(new.asignado_por, 'supervisor_ventas')) then
      raise exception 'Solo Gerencia o el Supervisor de ventas asignan planes de comisión';
    end if;
    if (select estado from plan_comision where id = new.plan_id) <> 'aprobado' then
      raise exception 'Solo se asigna un plan aprobado';
    end if;
    select tipo into v_tipo from vendedor where id = new.vendedor_id;
    if v_tipo is null or v_tipo not in ('interno', 'externo') then
      raise exception 'Solo los vendedores internos o externos comisionan';
    end if;
    if exists (select 1 from vendedor_plan o where o.vendedor_id = new.vendedor_id
                and coalesce(o.vigente_hasta, 'infinity'::date) >= new.vigente_desde and coalesce(new.vigente_hasta, 'infinity'::date) >= o.vigente_desde) then
      raise exception 'El vendedor ya tiene un plan vigente en esas fechas';
    end if;
    return new;
  end if;
  if new.vendedor_id <> old.vendedor_id or new.plan_id <> old.plan_id or new.vigente_desde <> old.vigente_desde or new.asignado_por <> old.asignado_por
     or old.vigente_hasta is not null or new.vigente_hasta is null then
    raise exception 'Una asignación de plan solo se cierra, una vez, con su fecha final';
  end if;
  return new;
end $$;
create trigger vendedor_plan_antes before insert or update or delete on vendedor_plan for each row execute function fn_vendedor_plan_antes();

-- ---------------------------------------------------------------------
-- Liquidaciones
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('liquidacion_comision', 'A', '', 1);

create table liquidacion_comision (
  id                     uuid primary key default gen_random_uuid(),
  numero                 bigint not null unique,
  vendedor_id            uuid not null references vendedor(id),
  periodo                char(7) not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  total_devengado_usd    numeric(16,2) not null,
  total_reversiones_usd  numeric(16,2) not null,
  neto_usd               numeric(16,2) not null check (neto_usd > 0),
  neto_ves               numeric(18,2) not null,
  estado                 text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada', 'pagada')),
  created_by             uuid not null references usuario(id),
  created_at             timestamptz not null default now(),
  aprobado_por           uuid references usuario(id),
  aprobado_at            timestamptz,
  rechazo_motivo         text,
  pagada_por             uuid references usuario(id),
  pagada_at              timestamptz,
  fecha_pago             date,
  cuenta_bancaria_id     uuid references cuenta_bancaria(id),
  referencia             text,
  tasa_pago              numeric(18,6),
  asiento_pago_id        uuid references asiento(id),
  check (estado not in ('aprobada', 'pagada') or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2),
  check ((estado = 'pagada') = (pagada_por is not null and pagada_at is not null and fecha_pago is not null and cuenta_bancaria_id is not null and asiento_pago_id is not null))
);
create unique index liquidacion_comision_vigente on liquidacion_comision (vendedor_id, periodo) where estado <> 'rechazada';

create function fn_liquidacion_antes() returns trigger
language plpgsql as $$
declare
  v_usuario uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una liquidación de comisiones no se borra';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Una liquidación nace pendiente de aprobación';
    end if;
    if not (fn_tiene_rol(new.created_by, 'contabilidad') or fn_tiene_rol(new.created_by, 'jefe_contabilidad') or fn_tiene_rol(new.created_by, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia arman liquidaciones de comisiones';
    end if;
    new.numero := fn_siguiente_numero('liquidacion_comision', 'A');
    return new;
  end if;
  if new.numero <> old.numero or new.vendedor_id <> old.vendedor_id or new.periodo <> old.periodo or new.total_devengado_usd <> old.total_devengado_usd
     or new.total_reversiones_usd <> old.total_reversiones_usd or new.neto_usd <> old.neto_usd or new.neto_ves <> old.neto_ves or new.created_by <> old.created_by then
    raise exception 'Los importes de una liquidación no se modifican';
  end if;
  if new.estado = old.estado then
    return new;
  end if;
  if old.estado = 'pendiente' and new.estado = 'aprobada' then
    select usuario_id into v_usuario from vendedor where id = old.vendedor_id;
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo Gerencia aprueba una liquidación de comisiones';
    end if;
    if new.aprobado_por = v_usuario then
      raise exception 'Gerencia no puede aprobar su propia liquidación de comisiones';
    end if;
    new.aprobado_at := coalesce(new.aprobado_at, now());
  elsif old.estado = 'pendiente' and new.estado = 'rechazada' then
    null;
  elsif old.estado = 'aprobada' and new.estado = 'pagada' then
    if new.pagada_por is null or not (fn_tiene_rol(new.pagada_por, 'tesoreria') or fn_tiene_rol(new.pagada_por, 'gerencia')) then
      raise exception 'Solo Tesorería o Gerencia pagan una liquidación de comisiones';
    end if;
    new.pagada_at := coalesce(new.pagada_at, now());
  else
    raise exception 'Cambio de estado de la liquidación no permitido (% → %)', old.estado, new.estado;
  end if;
  return new;
end $$;
create trigger liquidacion_comision_antes before insert or update or delete on liquidacion_comision for each row execute function fn_liquidacion_antes();

-- ---------------------------------------------------------------------
-- Movimientos de comisión (inmutables)
-- ---------------------------------------------------------------------
create table comision_movimiento (
  id              bigint generated always as identity primary key,
  ref             uuid not null unique default gen_random_uuid(),       -- origen del asiento del movimiento
  vendedor_id     uuid not null references vendedor(id),
  fecha           date not null,
  tipo            text not null check (tipo in ('devengo', 'reversion')),
  origen_tipo     text not null check (origen_tipo in ('aplicacion_cobro', 'nota_credito')),
  origen_id       uuid not null,
  factura_id      uuid not null references documento_venta(id),
  base_usd        numeric(16,2) not null,
  porcentaje      numeric(7,4) not null,
  monto_usd       numeric(16,2) not null,
  monto_ves       numeric(18,2) not null,
  calculo         jsonb not null,
  asiento_id      uuid not null references asiento(id),
  liquidacion_id  uuid references liquidacion_comision(id),
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  check ((tipo = 'devengo' and monto_usd > 0) or (tipo = 'reversion' and monto_usd < 0)),
  unique (tipo, origen_tipo, origen_id)
);
create index comision_movimiento_vendedor_idx on comision_movimiento (vendedor_id, fecha);
create index comision_movimiento_factura_idx on comision_movimiento (factura_id);

create function fn_comision_movimiento_antes() returns trigger
language plpgsql as $$
declare
  v_liq liquidacion_comision%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un movimiento de comisión no se borra: se corrige con otro movimiento';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if (to_jsonb(new) - 'liquidacion_id') is distinct from (to_jsonb(old) - 'liquidacion_id') then
    raise exception 'Un movimiento de comisión no se modifica';
  end if;
  if old.liquidacion_id is null and new.liquidacion_id is not null then
    select * into v_liq from liquidacion_comision where id = new.liquidacion_id;
    if not found or v_liq.estado <> 'pendiente' or v_liq.vendedor_id <> old.vendedor_id then
      raise exception 'El movimiento solo entra en una liquidación pendiente del mismo vendedor';
    end if;
  elsif old.liquidacion_id is not null and new.liquidacion_id is null then
    select * into v_liq from liquidacion_comision where id = old.liquidacion_id;
    if v_liq.estado <> 'rechazada' then
      raise exception 'El movimiento solo sale de una liquidación rechazada';
    end if;
  elsif new.liquidacion_id is distinct from old.liquidacion_id then
    raise exception 'Un movimiento ya liquidado no cambia de liquidación';
  end if;
  return new;
end $$;
create trigger comision_movimiento_antes before insert or update or delete on comision_movimiento for each row execute function fn_comision_movimiento_antes();

create trigger plan_comision_audit          after insert or update or delete on plan_comision          for each row execute function fn_audit();
create trigger plan_comision_regla_audit    after insert or update or delete on plan_comision_regla    for each row execute function fn_audit();
create trigger vendedor_plan_audit          after insert or update on vendedor_plan                    for each row execute function fn_audit();
create trigger liquidacion_comision_audit   after insert or update on liquidacion_comision             for each row execute function fn_audit();
create trigger comision_movimiento_audit    after insert or update on comision_movimiento              for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Reglas contables y flujos de aprobación
-- ---------------------------------------------------------------------
insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('comision_devengada', 1, 'D', '6.1.01', null,    'monto',            'Comisión de venta devengada'),
    ('comision_devengada', 2, 'H', '2.1.07', null,    'monto',            'Comisiones por pagar'),
    ('comision_reversada', 1, 'D', '2.1.07', null,    'monto',            'Comisiones por pagar'),
    ('comision_reversada', 2, 'H', '6.1.01', null,    'monto',            'Reversión de comisión de venta'),
    ('pago_comision',      1, 'D', '2.1.07', null,    'comision',         'Comisiones por pagar'),
    ('pago_comision',      2, 'D', '6.3.02', null,    'dif_perdida_ves',  'Pérdida por diferencial cambiario (Bs)'),
    ('pago_comision',      3, 'H', null,     'banco', 'banco',            'Pago de comisiones'),
    ('pago_comision',      4, 'H', '4.2.01', null,    'dif_ganancia_ves', 'Ganancia por diferencial cambiario (Bs)')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;

insert into flujo_definicion (objeto_tipo, nombre) values ('plan_comision', 'Plan de comisión'), ('liquidacion_comision', 'Liquidación de comisiones');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo in ('plan_comision', 'liquidacion_comision');

-- ---------------------------------------------------------------------
-- La rentabilidad resta las comisiones (0052): cada movimiento se reparte entre las líneas de su factura según su base.
-- ---------------------------------------------------------------------
create or replace view vw_rentabilidad_linea as
select (d.fecha_emision at time zone 'America/Caracas')::date as fecha,
       d.cliente_id, d.vendedor_id, d.sucursal_id, l.producto_id, p.grupo_id, p.marca_id,
       case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as venta_usd,
       case when d.moneda = 'VES' then round((round(l.cantidad * l.precio_unitario, 2) - l.base) / d.tasa, 2)
            else round(l.cantidad * l.precio_unitario, 2) - l.base end as descuento_linea_usd,
       0::numeric as devolucion_usd, 0::numeric as descuento_posterior_usd, 0::numeric as pronto_pago_usd,
       coalesce(round(l.cantidad * l.costo_unitario_usd, 2), 0) as costo_usd,
       0::numeric as comision_usd
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
       case when d.motivo_nc = 'devolucion' then -coalesce(round(l.cantidad * l.costo_unitario_usd, 2), 0) else 0 end,
       0
  from documento_venta_linea l
  join documento_venta d on d.id = l.documento_id
  join producto p on p.id = l.producto_id
  cross join lateral (select case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as usd) b
 where d.tipo = 'nota_credito' and d.estado = 'emitido' and not d.apertura
union all
select m.fecha, d.cliente_id, d.vendedor_id, d.sucursal_id, l.producto_id, p.grupo_id, p.marca_id,
       0, 0, 0, 0, 0, 0,
       round(m.monto_usd * b.usd / nullif(t.usd, 0), 2)
  from comision_movimiento m
  join documento_venta d on d.id = m.factura_id
  join documento_venta_linea l on l.documento_id = d.id
  join producto p on p.id = l.producto_id
  cross join lateral (select case when d.moneda = 'VES' then round(l.base / d.tasa, 2) else l.base end as usd) b
  cross join lateral (select coalesce(sum(case when d.moneda = 'VES' then round(l2.base / d.tasa, 2) else l2.base end), 0) as usd
                        from documento_venta_linea l2 where l2.documento_id = d.id) t;

comment on view vw_rentabilidad_linea is 'Grano línea de factura y de nota de crédito emitidas, más el reparto de cada movimiento de comisión entre las líneas de su factura, en USD (R-DT).';
