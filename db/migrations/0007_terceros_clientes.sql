-- =====================================================================
-- 0007 · Maestros: terceros, condiciones de pago, vendedores y clientes
--        (§4.2, §5.1, §5.2, §5.5)
--
--   R-G  Un RIF es un solo tercero: formato y dígito verificador validados en la base.
--   R-H  El código visible del cliente lo asigna el numerador, nunca se escribe a mano
--        y nunca cambia.
--   R-I  Un cliente nace 'pendiente' y pasa a 'activo' solo con la aprobación de un
--        usuario activo con el rol Gerencia, que le asigna condición de pago.
--   R-J  Un maestro referenciado no se borra (llaves foráneas restrictivas): se inactiva.
-- =====================================================================

-- ---------------------------------------------------------------------
-- RIF: dígito verificador del SENIAT (módulo 11).
-- Letra V=1, E=2, J=3, P=4, G=5 con peso 4; dígitos con pesos 3,2,7,6,5,4,3,2.
-- Verificador = 11 - (suma mod 11); si da 10 u 11, es 0.
-- ---------------------------------------------------------------------
create function fn_rif_valido(p_rif text) returns boolean
language plpgsql immutable as $$
declare
  v_pesos int[] := array[3, 2, 7, 6, 5, 4, 3, 2];
  v_suma  int;
  v_dv    int;
  i       int;
begin
  if p_rif is null or p_rif !~ '^[VEJPG]-[0-9]{8}-[0-9]$' then
    return false;
  end if;
  v_suma := 4 * (position(substr(p_rif, 1, 1) in 'VEJPG'));
  for i in 1..8 loop
    v_suma := v_suma + substr(p_rif, 2 + i, 1)::int * v_pesos[i];
  end loop;
  v_dv := 11 - (v_suma % 11);
  if v_dv >= 10 then
    v_dv := 0;
  end if;
  return v_dv = substr(p_rif, 12, 1)::int;
end $$;

-- La empresa también: las filas existentes no se revalidan (not valid), las nuevas sí.
alter table empresa add constraint empresa_rif_valido check (fn_rif_valido(rif)) not valid;

-- Nombre normalizado para detectar posibles duplicados ("Repuestos Lara, C.A." = "REPUESTOS LARA CA").
create function fn_nombre_normalizado(p text) returns text
language sql immutable as $$
  select trim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(p, '')), 'áéíóúüñ', 'aeiouun'),
             '\m(c\s*\.?\s*a|s\s*\.?\s*a|s\s*\.?\s*r\s*\.?\s*l|s\s*\.?\s*c|f\s*\.?\s*p)\M\.?', ' ', 'g'),
           '[^a-z0-9]+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------
-- Terceros
-- ---------------------------------------------------------------------
create table tercero (
  id                     uuid primary key default gen_random_uuid(),
  rif                    varchar(12) not null unique check (fn_rif_valido(rif)),
  razon_social           text not null check (length(trim(razon_social)) > 1),
  nombre_comercial       text,
  tipo_persona           char(1) not null check (tipo_persona in ('N', 'J')),
  domiciliado            boolean not null default true,
  contribuyente_especial boolean not null default false,
  agente_retencion_iva   boolean not null default false,
  direccion_fiscal       text,
  telefono               text,
  email                  text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  estado                 text not null default 'activo' check (estado in ('activo', 'inactivo', 'bloqueado')),
  created_at             timestamptz not null default now(),
  created_by             uuid references usuario(id)
);
create index tercero_nombre_idx on tercero (fn_nombre_normalizado(razon_social));

-- La FK de asiento_linea.tercero_id quedó pendiente en la Fase 0 (0003).
alter table asiento_linea add constraint asiento_linea_tercero_fk foreign key (tercero_id) references tercero(id);

-- ---------------------------------------------------------------------
-- Condiciones de pago (§4.2). El descuento por pronto pago lo configura Gerencia:
-- no se escribe en el código ni en esta semilla.
-- ---------------------------------------------------------------------
create table condicion_pago (
  id                  uuid primary key default gen_random_uuid(),
  codigo              varchar(10) not null unique check (codigo ~ '^[A-Z0-9_]+$'),
  nombre              text not null,
  dias                smallint not null check (dias between 0 and 365),
  descuento_pronto_pago_pct numeric(5,2) check (descuento_pronto_pago_pct between 0 and 100),
  dias_pronto_pago    smallint check (dias_pronto_pago between 0 and 365),
  activa              boolean not null default true,
  check ((descuento_pronto_pago_pct is null) = (dias_pronto_pago is null))
);

insert into condicion_pago (codigo, nombre, dias) values
  ('CONTADO', 'Contado', 0),
  ('CR15',    'Crédito 15 días', 15),
  ('CR30',    'Crédito 30 días', 30),
  ('CR45',    'Crédito 45 días', 45);

-- ---------------------------------------------------------------------
-- Vendedores (§5.2). plan_comision_id se agrega en la Fase 6.
-- ---------------------------------------------------------------------
create table vendedor (
  id          uuid primary key default gen_random_uuid(),
  codigo      varchar(6) not null unique check (codigo ~ '^V[0-9]{3,5}$'),
  nombre      text not null check (length(trim(nombre)) > 1),
  tercero_id  uuid references tercero(id),        -- si es externo: retención ISLR sobre comisiones
  tipo        text not null check (tipo in ('interno', 'externo', 'administrativo', 'casa')),
  sucursal_id uuid references sucursal(id),
  usuario_id  uuid unique references usuario(id), -- su usuario del ERP (seguridad por fila)
  estado      text not null default 'activo' check (estado in ('activo', 'inactivo')),
  created_at  timestamptz not null default now(),
  check (tipo <> 'externo' or tercero_id is not null)
);

-- ---------------------------------------------------------------------
-- Clientes (§5.1, §5.5)
-- ---------------------------------------------------------------------
create table cliente (
  tercero_id         uuid primary key references tercero(id),
  codigo             varchar(10) not null unique,
  sucursal_id        uuid references sucursal(id),
  vendedor_id        uuid references vendedor(id),
  zona               text,
  nivel_precio       char(1) not null default 'B' check (nivel_precio in ('A', 'B', 'D')),
  condicion_pago_id  uuid references condicion_pago(id),
  limite_credito_usd numeric(14,2) not null default 0 check (limite_credito_usd >= 0),
  descuento_pct      numeric(5,2) not null default 0 check (descuento_pct between 0 and 100),
  estado             text not null default 'pendiente'
                     check (estado in ('pendiente', 'activo', 'inactivo', 'bloqueado')),
  aprobado_por       uuid references usuario(id),
  aprobado_at        timestamptz,
  created_at         timestamptz not null default now(),
  created_by         uuid references usuario(id),
  -- Fuera de 'pendiente' el cliente ya fue aprobado y tiene condición de pago.
  check (estado = 'pendiente' or (aprobado_por is not null and aprobado_at is not null and condicion_pago_id is not null))
);
create index cliente_vendedor_idx on cliente (vendedor_id);

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('cliente', 'A', 'C', 1);

create function fn_cliente_antes() returns trigger
language plpgsql as $$
declare v_prefijo text;
begin
  if tg_op = 'INSERT' then
    -- R-H: el código lo asigna el numerador (C00001, C00002…).
    if new.codigo is not null then
      raise exception 'El código del cliente lo asigna el sistema';
    end if;
    select prefijo into v_prefijo from numerador where tipo_documento = 'cliente' and serie = 'A';
    new.codigo := v_prefijo || lpad(fn_siguiente_numero('cliente', 'A')::text, 5, '0');
    if new.estado <> 'pendiente' or new.aprobado_por is not null then
      raise exception 'Un cliente nuevo queda pendiente hasta que Gerencia lo apruebe';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;

  if new.codigo <> old.codigo then
    raise exception 'El código de un cliente no se cambia';
  end if;
  if new.estado <> 'pendiente' and new.estado <> old.estado then
    if old.estado = 'pendiente' then
      -- R-I: aprobación inicial.
      if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
        raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar un cliente';
      end if;
      new.aprobado_at := now();
    end if;
  end if;
  if new.estado = 'pendiente' and old.estado <> 'pendiente' then
    raise exception 'Un cliente aprobado no vuelve a pendiente';
  end if;
  if new.aprobado_por is distinct from old.aprobado_por and old.aprobado_por is not null then
    raise exception 'La aprobación de un cliente no se modifica';
  end if;
  return new;
end $$;

create trigger cliente_antes
  before insert or update on cliente
  for each row execute function fn_cliente_antes();

-- Auditoría: el cliente se identifica por tercero_id (no tiene columna id).
create or replace function fn_audit() returns trigger
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
          coalesce(v_despues ->> 'id', v_antes ->> 'id', v_despues ->> 'tercero_id', v_antes ->> 'tercero_id'),
          v_antes, v_despues);
  return coalesce(new, old);
end $$;

create trigger tercero_audit       after insert or update or delete on tercero        for each row execute function fn_audit();
create trigger cliente_audit        after insert or update or delete on cliente        for each row execute function fn_audit();
create trigger vendedor_audit       after insert or update or delete on vendedor       for each row execute function fn_audit();
create trigger condicion_pago_audit after insert or update or delete on condicion_pago for each row execute function fn_audit();
