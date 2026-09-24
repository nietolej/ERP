-- =====================================================================
-- 0008 · Vendedores: código asignado por el numerador (§5.2)
--
--   R-K  El código visible del vendedor (V001, V002…) lo asigna el numerador,
--        nunca se escribe a mano y nunca cambia.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('vendedor', 'A', 'V', 1);

-- La tabla se creó en 0007 con código obligatorio; ahora lo asigna el trigger.
create function fn_vendedor_antes() returns trigger
language plpgsql as $$
declare v_prefijo text;
begin
  if tg_op = 'INSERT' then
    if new.codigo is not null then
      raise exception 'El código del vendedor lo asigna el sistema';
    end if;
    select prefijo into v_prefijo from numerador where tipo_documento = 'vendedor' and serie = 'A';
    new.codigo := v_prefijo || lpad(fn_siguiente_numero('vendedor', 'A')::text, 3, '0');
    return new;
  end if;
  if new.codigo <> old.codigo then
    raise exception 'El código de un vendedor no se cambia';
  end if;
  return new;
end $$;

create trigger vendedor_antes
  before insert or update on vendedor
  for each row execute function fn_vendedor_antes();
