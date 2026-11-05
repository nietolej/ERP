-- =====================================================================
-- 0050 · Checklist de arranque (spec §14.6)
--
--   R-DN  Lo que el sistema puede comprobar solo (configuración, conteos, saldos, usuarios, primera factura) se calcula; lo que depende de una
--         persona (revisión del contador, cuadre con estados de cuenta y con los totales conocidos, capacitación, respaldo probado y las firmas
--         de Gerencia y del contador) se CONFIRMA aquí, con su responsable, fecha y nota. Cada confirmación solo la hace el rol que corresponde.
--   R-DO  Una confirmación no se edita ni se borra: se retira con motivo (solo Gerencia) y se vuelve a confirmar.
-- =====================================================================

create table arranque_confirmacion (
  id               uuid primary key default gen_random_uuid(),
  codigo           text not null check (codigo in ('configuracion', 'bancos', 'cartera', 'capacitacion', 'respaldo', 'firma_gerencia', 'firma_contador')),
  nota             text,
  confirmado_por   uuid not null references usuario(id),
  confirmado_at    timestamptz not null default now(),
  retirada_por     uuid references usuario(id),
  retirada_at      timestamptz,
  retirada_motivo  text,
  check ((retirada_at is null) = (retirada_por is null) and (retirada_at is null) = (retirada_motivo is null)),
  check (retirada_motivo is null or length(trim(retirada_motivo)) > 2)
);
create unique index arranque_confirmacion_vigente on arranque_confirmacion (codigo) where retirada_at is null;

create function fn_arranque_confirmacion_antes() returns trigger
language plpgsql as $$
declare
  v_ok boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una confirmación del checklist no se borra: se retira con motivo';
  end if;
  if tg_op = 'INSERT' then
    new.confirmado_por := coalesce(new.confirmado_por, fn_usuario_actual());
    if new.confirmado_por is null then
      raise exception 'Una confirmación necesita el usuario que la hace';
    end if;
    v_ok := case new.codigo
      when 'configuracion'  then fn_tiene_rol(new.confirmado_por, 'contabilidad') or fn_tiene_rol(new.confirmado_por, 'jefe_contabilidad') or fn_tiene_rol(new.confirmado_por, 'gerencia')
      when 'bancos'         then fn_tiene_rol(new.confirmado_por, 'tesoreria') or fn_tiene_rol(new.confirmado_por, 'gerencia')
      when 'cartera'        then fn_tiene_rol(new.confirmado_por, 'contabilidad') or fn_tiene_rol(new.confirmado_por, 'jefe_contabilidad') or fn_tiene_rol(new.confirmado_por, 'gerencia')
      when 'capacitacion'   then fn_tiene_rol(new.confirmado_por, 'gerencia') or fn_tiene_rol(new.confirmado_por, 'administrador')
      when 'respaldo'       then fn_tiene_rol(new.confirmado_por, 'administrador') or fn_tiene_rol(new.confirmado_por, 'gerencia')
      when 'firma_gerencia' then fn_tiene_rol(new.confirmado_por, 'gerencia')
      when 'firma_contador' then fn_tiene_rol(new.confirmado_por, 'contabilidad') or fn_tiene_rol(new.confirmado_por, 'jefe_contabilidad')
    end;
    if not coalesce(v_ok, false) then
      raise exception 'Su rol no puede hacer la confirmación «%»', new.codigo;
    end if;
    new.retirada_por := null; new.retirada_at := null; new.retirada_motivo := null;
    return new;
  end if;
  if (to_jsonb(new) - 'retirada_por' - 'retirada_at' - 'retirada_motivo') is distinct from (to_jsonb(old) - 'retirada_por' - 'retirada_at' - 'retirada_motivo') then
    raise exception 'Una confirmación del checklist no se edita: se retira y se confirma de nuevo';
  end if;
  if old.retirada_at is not null then
    raise exception 'Esta confirmación ya fue retirada';
  end if;
  new.retirada_por := coalesce(new.retirada_por, fn_usuario_actual());
  if new.retirada_por is null or not fn_tiene_rol(new.retirada_por, 'gerencia') then
    raise exception 'Solo Gerencia retira una confirmación';
  end if;
  new.retirada_at := now();
  return new;
end $$;
create trigger arranque_confirmacion_antes before insert or update or delete on arranque_confirmacion
  for each row execute function fn_arranque_confirmacion_antes();
create trigger arranque_confirmacion_audit after insert or update on arranque_confirmacion for each row execute function fn_audit();
