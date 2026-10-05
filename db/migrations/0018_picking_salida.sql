-- =====================================================================
-- 0018 · Picking y empaque con tiempos, y salida de mercancía de la nota de entrega (§6.4, §8.2, §12.3)
--
--   R-AL  El picking se activa por almacén (`usa_picking`): el mostrador puede despachar sin él.
--   R-AM  Los tiempos de picking nunca se digitan: salen de las marcas de hora que pone la base de
--         datos, y los indicadores se calculan en la vista vw_picking_tiempos (una sola vez).
--   R-AN  Una orden de picking solo avanza por transiciones válidas; un faltante la deja en
--         `con_faltante` hasta que Gerencia o el supervisor decidan.
--   R-AO  La salida de mercancía descuenta la existencia al costo promedio vigente y su asiento
--         (costo de ventas contra inventario) sale del motor contable. La nota despachada no se anula.
-- =====================================================================

alter table almacen add column usa_picking boolean not null default true;

-- Horas objetivo de picking por almacén y prioridad (1 = más urgente): el valor lo fija Gerencia, no el código.
create table almacen_picking_objetivo (
  almacen_id uuid not null references almacen(id),
  prioridad  smallint not null check (prioridad between 1 and 5),
  horas      numeric(6,2) not null check (horas > 0),
  primary key (almacen_id, prioridad)
);

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('picking', 'A', '', 1);

-- ---------------------------------------------------------------------
-- Orden de picking
-- ---------------------------------------------------------------------
create table orden_picking (
  id              uuid primary key default gen_random_uuid(),
  numero          bigint not null unique,
  nota_entrega_id uuid not null references documento_venta(id),
  almacen_id      uuid not null references almacen(id),
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente', 'asignada', 'en_proceso', 'completa', 'con_faltante', 'cancelada')),
  prioridad       smallint not null default 3 check (prioridad between 1 and 5),
  asignada_a      uuid references usuario(id),
  creada_at       timestamptz not null default now(),
  asignada_at     timestamptz,
  iniciada_at     timestamptz,
  finalizada_at   timestamptz,
  empacada_at     timestamptz,
  created_by      uuid not null references usuario(id)
);
-- Una nota de entrega tiene a lo sumo una orden vigente.
create unique index orden_picking_vigente on orden_picking (nota_entrega_id) where estado <> 'cancelada';
create index orden_picking_almacen_idx on orden_picking (almacen_id, estado);

create table orden_picking_linea (
  id               uuid primary key default gen_random_uuid(),
  orden_id         uuid not null references orden_picking(id),
  nota_linea_id    uuid not null references documento_venta_linea(id),
  producto_id      uuid not null references producto(id),
  cantidad_pedida  numeric(14,4) not null check (cantidad_pedida > 0),
  cantidad_recogida numeric(14,4) not null default 0 check (cantidad_recogida >= 0),
  motivo_faltante  text,
  unique (orden_id, nota_linea_id),
  check (cantidad_recogida <= cantidad_pedida)
);

create function fn_orden_picking_antes() returns trigger
language plpgsql as $$
declare
  v_ok        boolean;
  -- Solo el despacho parcial (despacho.ts) reasigna la orden a la nota nueva y la da por completa (R-AN).
  v_continuar boolean := coalesce(current_setting('app.picking_continuar', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    new.numero := fn_siguiente_numero('picking', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Una orden de picking no se borra: se cancela';
  end if;

  if new.almacen_id <> old.almacen_id or new.numero <> old.numero or new.creada_at <> old.creada_at
     or (new.nota_entrega_id <> old.nota_entrega_id and not v_continuar) then
    raise exception 'Una orden de picking no cambia de nota, de almacén ni de número';
  end if;

  if new.estado <> old.estado then
    v_ok := (old.estado, new.estado) in (
      ('pendiente', 'asignada'), ('pendiente', 'en_proceso'), ('pendiente', 'cancelada'),
      ('asignada', 'en_proceso'), ('asignada', 'cancelada'),
      ('en_proceso', 'completa'), ('en_proceso', 'con_faltante'), ('en_proceso', 'cancelada'),
      ('con_faltante', 'en_proceso'), ('con_faltante', 'cancelada'),
      ('completa', 'cancelada'))
      or (v_continuar and (old.estado, new.estado) = ('con_faltante', 'completa'));
    if not v_ok then
      raise exception 'Una orden de picking % no pasa a %', old.estado, new.estado;
    end if;
    -- Las marcas de hora las pone la base de datos (R-AM).
    if new.estado = 'asignada' then
      new.asignada_at := now();
    elsif new.estado = 'en_proceso' then
      new.iniciada_at := coalesce(old.iniciada_at, now());
      new.finalizada_at := null;
    elsif v_continuar and new.estado = 'completa' then
      new.finalizada_at := old.finalizada_at;       -- el despacho parcial conserva los tiempos reales del picking
    elsif new.estado in ('completa', 'con_faltante') then
      new.finalizada_at := now();
    end if;
  else
    new.asignada_at := old.asignada_at;
    new.iniciada_at := old.iniciada_at;
    new.finalizada_at := old.finalizada_at;
  end if;

  if new.empacada_at is distinct from old.empacada_at then
    if old.empacada_at is not null then
      raise exception 'El empaque de una orden de picking no se deshace';
    end if;
    if new.estado <> 'completa' then
      raise exception 'Solo se empaca una orden de picking completa';
    end if;
    new.empacada_at := now();
  end if;
  return new;
end $$;

create trigger orden_picking_antes
  before insert or update or delete on orden_picking
  for each row execute function fn_orden_picking_antes();

create function fn_orden_picking_linea_antes() returns trigger
language plpgsql as $$
declare
  v_estado    text;
  v_continuar boolean := coalesce(current_setting('app.picking_continuar', true), '') = '1';
begin
  if tg_op = 'DELETE' then
    if not v_continuar then
      raise exception 'Las líneas de una orden de picking no se borran';
    end if;
    return old;
  end if;
  select estado into v_estado from orden_picking where id = new.orden_id;
  if tg_op = 'INSERT' then
    if v_estado <> 'pendiente' then
      raise exception 'Las líneas se crean con la orden';
    end if;
    return new;
  end if;
  if new.orden_id <> old.orden_id or new.producto_id <> old.producto_id then
    raise exception 'Una línea de picking no cambia de orden ni de producto';
  end if;
  if (new.nota_linea_id <> old.nota_linea_id or new.cantidad_pedida <> old.cantidad_pedida) and not v_continuar then
    raise exception 'Una línea de picking no cambia de cantidad pedida';
  end if;
  if v_continuar then
    return new;
  end if;
  if v_estado <> 'en_proceso' then
    raise exception 'Solo se registra lo recogido mientras la orden está en proceso';
  end if;
  return new;
end $$;

create trigger orden_picking_linea_antes
  before insert or update or delete on orden_picking_linea
  for each row execute function fn_orden_picking_linea_antes();

-- ---------------------------------------------------------------------
-- Indicadores de picking (R-AM): espera, picking, ciclo total, líneas por hora y cumplimiento del objetivo
-- ---------------------------------------------------------------------
create view vw_picking_tiempos as
select o.id as orden_id, o.numero, o.almacen_id, o.prioridad, o.estado,
       extract(epoch from (o.iniciada_at - o.creada_at))::numeric(14,0)    as espera_seg,
       extract(epoch from (o.finalizada_at - o.iniciada_at))::numeric(14,0) as picking_seg,
       extract(epoch from (o.empacada_at - o.creada_at))::numeric(14,0)     as ciclo_seg,
       l.lineas_recogidas,
       case when o.finalizada_at > o.iniciada_at
            then round(l.lineas_recogidas * 3600 / extract(epoch from (o.finalizada_at - o.iniciada_at)), 2) end as lineas_por_hora,
       ob.horas as objetivo_horas,
       case when ob.horas is not null and o.empacada_at is not null
            then extract(epoch from (o.empacada_at - o.creada_at)) / 3600 <= ob.horas end as cumple_objetivo
  from orden_picking o
  left join almacen_picking_objetivo ob on ob.almacen_id = o.almacen_id and ob.prioridad = o.prioridad
  cross join lateral (select count(*) filter (where cantidad_recogida > 0)::int as lineas_recogidas
                        from orden_picking_linea where orden_id = o.id) l
 where o.estado <> 'cancelada';

-- ---------------------------------------------------------------------
-- Salida de mercancía de una nota de entrega (R-AO)
-- ---------------------------------------------------------------------
alter table documento_venta
  add column salida_at  timestamptz,
  add column salida_por uuid references usuario(id),
  add constraint documento_venta_salida check (
    (salida_at is null) = (salida_por is null) and (salida_at is null or tipo = 'nota_entrega'));

create or replace function fn_documento_venta_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'situacion', 'aprobado_por', 'aprobado_at', 'anulado_por', 'anulado_at', 'anulado_motivo',
                           'salida_at', 'salida_por'];
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un documento de venta nace en borrador';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un documento de venta necesita el usuario que lo crea';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un documento emitido no se borra: se anula con su motivo';
    end if;
    return old;
  end if;

  if old.estado = 'borrador' then
    if new.estado = 'anulado' then
      raise exception 'Un borrador no se anula: se elimina';
    end if;
    if new.estado = 'emitido' then
      if not exists (select 1 from documento_venta_linea where documento_id = old.id) then
        raise exception 'No se puede emitir un documento sin líneas';
      end if;
      new.numero := fn_siguiente_numero(new.tipo, new.serie);
      new.fecha_emision := now();
    end if;
    return new;
  end if;

  if old.estado = 'anulado' then
    raise exception 'Un documento anulado no se modifica';
  end if;

  -- Emitido: solo cambian el estado, la situación y los datos de aprobación, salida o anulación.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Un documento emitido no se edita: se anula con su motivo o se corrige con otro documento';
  end if;
  if new.estado = 'borrador' then
    raise exception 'Un documento emitido no vuelve a borrador';
  end if;
  if new.estado = 'anulado' and old.salida_at is not null then
    raise exception 'La mercancía de una nota de entrega despachada ya salió: no se anula, se corrige con una devolución';
  end if;
  if old.salida_at is not null and (new.salida_at is distinct from old.salida_at or new.salida_por is distinct from old.salida_por) then
    raise exception 'La salida de una nota de entrega no se modifica';
  end if;
  if new.estado = 'anulado' then
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := coalesce(new.anulado_at, now());
  end if;
  return new;
end $$;

-- En una línea emitida solo se completa el costo con que salió la mercancía (margen por línea, §6.1).
create or replace function fn_documento_venta_linea_antes() returns trigger
language plpgsql as $$
declare
  v_estado text;
begin
  select estado into v_estado from documento_venta where id = coalesce(new.documento_id, old.documento_id);
  -- Si el encabezado ya no existe, es el borrado en cascada de un borrador.
  if v_estado is not null and v_estado <> 'borrador' then
    if tg_op = 'UPDATE' and old.costo_unitario_usd is null
       and (to_jsonb(new) - 'costo_unitario_usd') = (to_jsonb(old) - 'costo_unitario_usd') then
      return new;
    end if;
    raise exception 'Las líneas de un documento emitido no se modifican';
  end if;
  return coalesce(new, old);
end $$;

-- Regla contable: costo de la venta al despachar (§12.3). Importe 'costo' en USD, a valor de inventario.
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select 'salida_venta', v.orden, v.lado, c.id, 'costo', v.glosa
  from (values (1, 'D', '5.1.01', 'Costo de ventas'), (2, 'H', '1.3.01', 'Salida de inventario')) as v(orden, lado, codigo, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger orden_picking_audit         after insert or update on orden_picking         for each row execute function fn_audit();
create trigger orden_picking_linea_audit   after insert or update on orden_picking_linea   for each row execute function fn_audit();
create trigger almacen_picking_objetivo_audit after insert or update or delete on almacen_picking_objetivo for each row execute function fn_audit();
