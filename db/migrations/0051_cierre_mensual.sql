-- =====================================================================
-- 0051 · Cierre mensual (spec §12.4)
--
--   R-DP  Un periodo de enero a diciembre se cierra solo con fn_cerrar_periodo y se reabre solo con fn_reabrir_periodo: un UPDATE directo del
--         estado se rechaza. El cierre lo hacen Contabilidad, el Jefe de contabilidad o Gerencia; la reapertura solo Gerencia, con motivo.
--         Cada cierre y cada reapertura queda en cierre_periodo (inmutable) con quién, cuándo y la foto del checklist con que se cerró.
--   R-DQ  La base se niega a cerrar un periodo con asientos en borrador o con el mayor descuadrado. El resto del checklist (documentos
--         pendientes, conciliaciones, auxiliares, declaraciones) lo comprueba la aplicación antes de llamar a la función.
--   R-DR  Dos puntos del checklist dependen de una persona y se confirman por periodo, con responsable, fecha y nota: asientos recurrentes y
--         provisiones, y revisión del diferencial cambiario. Se confirman con el periodo abierto; no se editan ni se borran, se retiran con motivo.
--   R-DS  Un periodo solo se bloquea estando cerrado.
--   El periodo 13 (cierre del ejercicio) conserva el comportamiento anterior: lo gobierna el cierre del ejercicio, que es otra entrega.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Confirmaciones por periodo
-- ---------------------------------------------------------------------
create table cierre_confirmacion (
  id               uuid primary key default gen_random_uuid(),
  periodo_id       uuid not null references periodo_contable(id),
  codigo           text not null check (codigo in ('recurrentes', 'diferencial_cambiario')),
  nota             text,
  confirmado_por   uuid not null references usuario(id),
  confirmado_at    timestamptz not null default now(),
  retirada_por     uuid references usuario(id),
  retirada_at      timestamptz,
  retirada_motivo  text,
  check ((retirada_at is null) = (retirada_por is null) and (retirada_at is null) = (retirada_motivo is null)),
  check (retirada_motivo is null or length(trim(retirada_motivo)) > 2)
);
create unique index cierre_confirmacion_vigente on cierre_confirmacion (periodo_id, codigo) where retirada_at is null;

create function fn_cierre_confirmacion_antes() returns trigger
language plpgsql as $$
declare
  per periodo_contable;
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una confirmación del cierre no se borra: se retira con motivo';
  end if;
  select * into per from periodo_contable where id = new.periodo_id;
  if per.estado <> 'abierto' or per.mes > 12 then
    raise exception 'Solo se confirma o se retira una confirmación con el periodo mensual abierto';
  end if;
  if tg_op = 'INSERT' then
    v_user := coalesce(new.confirmado_por, fn_usuario_actual());
    if v_user is null
       or not (fn_tiene_rol(v_user, 'contabilidad') or fn_tiene_rol(v_user, 'jefe_contabilidad') or fn_tiene_rol(v_user, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia confirman puntos del cierre';
    end if;
    new.confirmado_por := v_user;
    new.retirada_por := null; new.retirada_at := null; new.retirada_motivo := null;
    return new;
  end if;
  if (to_jsonb(new) - 'retirada_por' - 'retirada_at' - 'retirada_motivo') is distinct from (to_jsonb(old) - 'retirada_por' - 'retirada_at' - 'retirada_motivo') then
    raise exception 'Una confirmación del cierre no se edita: se retira y se confirma de nuevo';
  end if;
  if old.retirada_at is not null then
    raise exception 'Esta confirmación ya fue retirada';
  end if;
  new.retirada_por := coalesce(new.retirada_por, fn_usuario_actual());
  if new.retirada_por is null or not (fn_tiene_rol(new.retirada_por, 'jefe_contabilidad') or fn_tiene_rol(new.retirada_por, 'gerencia')) then
    raise exception 'Solo el Jefe de contabilidad o Gerencia retiran una confirmación del cierre';
  end if;
  new.retirada_at := now();
  return new;
end $$;
create trigger cierre_confirmacion_antes before insert or update or delete on cierre_confirmacion
  for each row execute function fn_cierre_confirmacion_antes();
create trigger cierre_confirmacion_audit after insert or update on cierre_confirmacion for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Historial de cierres y reaperturas (inmutable)
-- ---------------------------------------------------------------------
create table cierre_periodo (
  id          uuid primary key default gen_random_uuid(),
  periodo_id  uuid not null references periodo_contable(id),
  accion      text not null check (accion in ('cierre', 'reapertura')),
  motivo      text,
  checklist   jsonb,
  hecho_por   uuid not null references usuario(id),
  hecho_at    timestamptz not null default now(),
  check (accion <> 'reapertura' or length(trim(coalesce(motivo, ''))) > 2)
);
create index cierre_periodo_periodo_idx on cierre_periodo (periodo_id, hecho_at);

create function fn_cierre_periodo_antes() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'El historial de cierres no se modifica ni se borra';
  end if;
  new.hecho_por := coalesce(new.hecho_por, fn_usuario_actual());
  if new.hecho_por is null then
    raise exception 'Un cierre o una reapertura necesita el usuario que la hace';
  end if;
  if new.accion = 'cierre' and not (fn_tiene_rol(new.hecho_por, 'contabilidad') or fn_tiene_rol(new.hecho_por, 'jefe_contabilidad') or fn_tiene_rol(new.hecho_por, 'gerencia')) then
    raise exception 'Solo Contabilidad o Gerencia cierran un periodo';
  end if;
  if new.accion = 'reapertura' and not fn_tiene_rol(new.hecho_por, 'gerencia') then
    raise exception 'Solo Gerencia reabre un periodo cerrado';
  end if;
  return new;
end $$;
create trigger cierre_periodo_antes before insert or update or delete on cierre_periodo
  for each row execute function fn_cierre_periodo_antes();
create trigger cierre_periodo_audit after insert on cierre_periodo for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Funciones de cierre y reapertura
-- ---------------------------------------------------------------------
create function fn_cerrar_periodo(p_periodo uuid, p_checklist jsonb default null, p_usuario uuid default null) returns void
language plpgsql as $$
declare
  per periodo_contable;
  v_user uuid := coalesce(p_usuario, fn_usuario_actual());
begin
  select * into per from periodo_contable where id = p_periodo for update;
  if not found then
    raise exception 'El periodo no existe';
  end if;
  if per.estado <> 'abierto' then
    raise exception 'El periodo %-% no está abierto', per.anio, per.mes;
  end if;
  if per.mes <= 12 then
    if exists (select 1 from asiento where periodo_id = per.id and estado = 'borrador') then
      raise exception 'El periodo %-% tiene asientos en borrador: resuélvalos antes de cerrar', per.anio, per.mes;
    end if;
    if exists (select 1 from vw_control_cuadre where diferencia_ves <> 0 or diferencia_usd <> 0) then
      raise exception 'El mayor no cuadra: no se puede cerrar el periodo';
    end if;
  end if;
  insert into cierre_periodo (periodo_id, accion, checklist, hecho_por) values (per.id, 'cierre', p_checklist, v_user);
  perform set_config('app.cierre_periodo', per.id::text, true);
  update periodo_contable set estado = 'cerrado', cambiado_por = v_user where id = per.id;
end $$;

create function fn_reabrir_periodo(p_periodo uuid, p_motivo text, p_usuario uuid default null) returns void
language plpgsql as $$
declare
  per periodo_contable;
  v_user uuid := coalesce(p_usuario, fn_usuario_actual());
begin
  select * into per from periodo_contable where id = p_periodo for update;
  if not found then
    raise exception 'El periodo no existe';
  end if;
  if per.estado <> 'cerrado' then
    raise exception 'Solo se reabre un periodo cerrado (el bloqueado no se reabre)';
  end if;
  insert into cierre_periodo (periodo_id, accion, motivo, hecho_por) values (per.id, 'reapertura', p_motivo, v_user);
  perform set_config('app.reapertura_periodo', per.id::text, true);
  update periodo_contable set estado = 'abierto', cambiado_por = v_user where id = per.id;
end $$;

-- Un UPDATE directo del estado de un periodo mensual no pasa: se cierra y se reabre con las funciones de arriba.
create function fn_periodo_cierre_control() returns trigger
language plpgsql as $$
begin
  if new.estado = old.estado or new.mes > 12 then
    return new;
  end if;
  if old.estado = 'abierto' and new.estado = 'cerrado'
     and coalesce(current_setting('app.cierre_periodo', true), '') <> old.id::text then
    raise exception 'Un periodo mensual se cierra con el cierre mensual (Contabilidad → Cierre mensual), no cambiando su estado';
  end if;
  if old.estado = 'cerrado' and new.estado = 'abierto'
     and coalesce(current_setting('app.reapertura_periodo', true), '') <> old.id::text then
    raise exception 'Un periodo mensual cerrado se reabre con la reapertura de Gerencia (Contabilidad → Cierre mensual), no cambiando su estado';
  end if;
  if old.estado = 'abierto' and new.estado = 'bloqueado' then
    raise exception 'Un periodo se bloquea solo después de cerrarlo';
  end if;
  return new;
end $$;
create trigger periodo_cierre_control before update on periodo_contable
  for each row execute function fn_periodo_cierre_control();
