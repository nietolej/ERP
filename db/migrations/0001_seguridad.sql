-- =====================================================================
-- 0001 · Seguridad: usuarios, roles, sesiones y auditoría (§4.3)
-- =====================================================================

create table usuario (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null unique check (email = lower(email) and email like '%_@_%'),
  nombre                text not null check (length(trim(nombre)) > 0),
  password_hash         text not null,
  debe_cambiar_password boolean not null default true,
  activo                boolean not null default true,
  ultimo_acceso         timestamptz,
  created_at            timestamptz not null default now()
);

create table rol (
  codigo      text primary key,
  nombre      text not null,
  descripcion text
);

create table usuario_rol (
  usuario_id uuid not null references usuario(id) on delete cascade,
  rol        text not null references rol(codigo),
  primary key (usuario_id, rol)
);

-- Sesiones en base de datos: la cookie lleva un token aleatorio; aquí solo se guarda su hash.
create table sesion (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references usuario(id) on delete cascade,
  token_hash  text not null unique,
  expira_at   timestamptz not null,
  created_at  timestamptz not null default now()
);
create index sesion_usuario_idx on sesion (usuario_id);

-- ---------------------------------------------------------------------
-- Auditoría: quién, cuándo, qué cambió. Inmutable.
-- La aplicación identifica al usuario con: select set_config('app.usuario_id', '<uuid>', true)
-- ---------------------------------------------------------------------
create table audit_log (
  id          bigint generated always as identity primary key,
  usuario_id  uuid,
  accion      text not null,
  entidad     text not null,
  entidad_id  text,
  antes       jsonb,
  despues     jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_entidad_idx on audit_log (entidad, entidad_id);

create function fn_usuario_actual() returns uuid
language sql stable as $$
  select nullif(current_setting('app.usuario_id', true), '')::uuid
$$;

create function fn_audit() returns trigger
language plpgsql as $$
declare
  v_antes   jsonb;
  v_despues jsonb;
begin
  -- Nunca se auditan secretos
  if tg_op in ('UPDATE', 'DELETE') then
    v_antes := to_jsonb(old) - 'password_hash' - 'token_hash';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_despues := to_jsonb(new) - 'password_hash' - 'token_hash';
  end if;
  insert into audit_log (usuario_id, accion, entidad, entidad_id, antes, despues)
  values (fn_usuario_actual(), tg_op, tg_table_name,
          coalesce(v_despues ->> 'id', v_antes ->> 'id'), v_antes, v_despues);
  return coalesce(new, old);
end $$;

create function fn_audit_log_inmutable() returns trigger
language plpgsql as $$
begin
  raise exception 'El registro de auditoría no se puede modificar ni borrar';
end $$;

create trigger audit_log_inmutable
  before update or delete on audit_log
  for each row execute function fn_audit_log_inmutable();

create trigger usuario_audit     after insert or update or delete on usuario     for each row execute function fn_audit();
create trigger usuario_rol_audit after insert or update or delete on usuario_rol for each row execute function fn_audit();
