-- =====================================================================
-- 0006 · Asientos manuales con aprobación (§3.1, §4.3)
--
--   R-F  Un asiento manual o de apertura se contabiliza solo con la aprobación
--        de un usuario activo con el rol jefe_contabilidad, distinto de quien lo
--        registró (segregación de funciones).
-- =====================================================================

insert into rol (codigo, nombre, descripcion) values
  ('jefe_contabilidad', 'Jefe de contabilidad', 'Aprobación de asientos manuales');

create function fn_tiene_rol(p_usuario uuid, p_rol text) returns boolean
language sql stable as $$
  select exists (
    select 1 from usuario_rol ur join usuario u on u.id = ur.usuario_id
     where ur.usuario_id = p_usuario and ur.rol = p_rol and u.activo)
$$;

create function fn_asiento_aprobacion() returns trigger
language plpgsql as $$
begin
  if new.tipo not in ('manual', 'apertura') then
    return new;
  end if;
  if new.estado = 'borrador' and new.aprobado_por is not null then
    raise exception 'La aprobación de un asiento manual se registra al contabilizarlo';
  end if;
  if tg_op = 'UPDATE' and new.estado = 'contabilizado' and old.estado = 'borrador' then
    if new.aprobado_por is null then
      raise exception 'El asiento manual necesita la aprobación del jefe de contabilidad para contabilizarse';
    end if;
    if new.aprobado_por = new.created_by then
      raise exception 'Quien registra un asiento manual no puede aprobarlo';
    end if;
    if not fn_tiene_rol(new.aprobado_por, 'jefe_contabilidad') then
      raise exception 'Solo un usuario activo con el rol Jefe de contabilidad puede aprobar asientos manuales';
    end if;
  end if;
  return new;
end $$;

create trigger asiento_aprobacion
  before insert or update on asiento
  for each row execute function fn_asiento_aprobacion();
