-- =====================================================================
-- 0012 · Bancos (§5.4, §10.2)
--
--   R-R  El código del banco es único sin importar mayúsculas y no se cambia.
--        El nombre también es único, sin importar mayúsculas ni espacios de más.
--   R-S  Un banco no se borra: se inactiva. Las cuentas bancarias (Fase 3) lo
--        referenciarán con llave foránea.
--
-- Solo el catálogo. Las cuentas bancarias, sus movimientos y la conciliación
-- pertenecen a la Fase 3. Ningún banco se siembra: los registra Tesorería.
-- =====================================================================

create table banco (
  id         uuid primary key default gen_random_uuid(),
  codigo     varchar(10) not null check (codigo ~ '^[A-Z0-9]+$'),
  nombre     text not null check (length(trim(nombre)) > 1),
  pais       char(2) not null default 'VE' check (pais ~ '^[A-Z]{2}$'),
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index banco_codigo_unico on banco (upper(codigo));
create unique index banco_nombre_unico on banco (lower(trim(nombre)));

create function fn_banco_inmutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un banco no se borra: inactívelo';
  end if;
  if new.codigo <> old.codigo then
    raise exception 'El código del banco no se cambia';
  end if;
  return new;
end $$;

create trigger banco_inmutable
  before update or delete on banco
  for each row execute function fn_banco_inmutable();

create trigger banco_audit after insert or update or delete on banco
  for each row execute function fn_audit();
