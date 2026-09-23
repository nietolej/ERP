-- =====================================================================
-- 0002 · Configuración general: empresa, sucursales, monedas, tasas,
--        parámetros fiscales con vigencia y numeradores (§4.2, §3.4, §3.5)
-- =====================================================================

create table empresa (
  id                      smallint primary key default 1 check (id = 1),   -- una sola fila
  rif                     varchar(12) not null check (rif ~ '^[VEJPG]-[0-9]{8}-[0-9]$'),
  razon_social            text not null,
  domicilio_fiscal        text,
  contribuyente_especial  boolean not null default false,
  agente_retencion_iva    boolean not null default false,
  agente_retencion_islr   boolean not null default false,
  agente_percepcion_igtf  boolean not null default false,
  moneda_funcional        varchar(4) not null default 'VES',
  moneda_gestion          varchar(4) not null default 'USD',
  updated_at              timestamptz not null default now()
);

create table sucursal (
  id         uuid primary key default gen_random_uuid(),
  codigo     varchar(6) not null unique check (codigo ~ '^[A-Z0-9]+$'),
  nombre     text not null,
  direccion  text,
  activa     boolean not null default true,
  created_at timestamptz not null default now()
);

create table moneda (
  codigo  varchar(4) primary key check (codigo ~ '^[A-Z]{3,4}$'),
  nombre  text not null,
  simbolo text not null,
  activa  boolean not null default true
);

-- Tasa = bolívares (VES) por 1 unidad de la moneda. Una fila por fecha, moneda y fuente.
-- BCV es la única fuente válida para registros legales (§3.4).
create table tasa_cambio (
  fecha          date not null,
  moneda         varchar(4) not null references moneda(codigo),
  fuente         text not null default 'BCV' check (fuente in ('BCV', 'PARALELO')),
  tasa           numeric(18,6) not null check (tasa > 0),
  registrado_por uuid references usuario(id),
  created_at     timestamptz not null default now(),
  primary key (fecha, moneda, fuente),
  check (moneda <> 'VES')
);

-- Tasa vigente para una fecha: la última publicada en o antes de esa fecha.
-- Falla si no hay tasa o si la última tiene más de p_max_dias de antigüedad
-- (evita convertir con una tasa vieja por olvido de carga).
create function fn_tasa(p_moneda varchar, p_fecha date, p_fuente text default 'BCV', p_max_dias int default 7)
returns numeric
language plpgsql stable as $$
declare
  v_tasa  numeric;
  v_fecha date;
begin
  if p_moneda = 'VES' then
    return 1;
  end if;
  select tasa, fecha into v_tasa, v_fecha
    from tasa_cambio
   where moneda = p_moneda and fuente = p_fuente and fecha <= p_fecha
   order by fecha desc
   limit 1;
  if v_tasa is null then
    raise exception 'No hay tasa % de % registrada en o antes del %', p_fuente, p_moneda, p_fecha;
  end if;
  if p_fecha - v_fecha > p_max_dias then
    raise exception 'La última tasa % de % es del % (más de % días antes del %). Registre la tasa vigente.',
      p_fuente, p_moneda, v_fecha, p_max_dias, p_fecha;
  end if;
  return v_tasa;
end $$;

-- ---------------------------------------------------------------------
-- Parámetros fiscales con vigencia: ninguna alícuota ni porcentaje en el código (§3.5)
-- ---------------------------------------------------------------------
create table parametro_fiscal (
  id                    uuid primary key default gen_random_uuid(),
  codigo                text not null check (codigo ~ '^[A-Z0-9_]+$'),
  descripcion           text not null,
  valor                 numeric(18,6) not null check (valor >= 0),
  unidad                text not null check (unidad in ('porcentaje', 'bolivares', 'dias', 'factor')),
  vigente_desde         date not null,
  vigente_hasta         date,
  fuente_normativa      text,
  validado_por_contador boolean not null default false,
  created_by            uuid references usuario(id),
  created_at            timestamptz not null default now(),
  unique (codigo, vigente_desde),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);

-- Dos vigencias del mismo parámetro no pueden solaparse.
create function fn_parametro_fiscal_sin_solape() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from parametro_fiscal p
     where p.codigo = new.codigo and p.id <> new.id
       and daterange(p.vigente_desde, coalesce(p.vigente_hasta, 'infinity'::date), '[]')
        && daterange(new.vigente_desde, coalesce(new.vigente_hasta, 'infinity'::date), '[]')
  ) then
    raise exception 'El parámetro % ya tiene una vigencia que se solapa con % – %',
      new.codigo, new.vigente_desde, coalesce(new.vigente_hasta::text, 'sin fin');
  end if;
  return new;
end $$;

create trigger parametro_fiscal_sin_solape
  before insert or update on parametro_fiscal
  for each row execute function fn_parametro_fiscal_sin_solape();

create function fn_parametro_fiscal(p_codigo text, p_fecha date) returns numeric
language plpgsql stable as $$
declare v numeric;
begin
  select valor into v
    from parametro_fiscal
   where codigo = p_codigo
     and vigente_desde <= p_fecha
     and (vigente_hasta is null or vigente_hasta >= p_fecha);
  if v is null then
    raise exception 'No hay valor vigente del parámetro fiscal % al %', p_codigo, p_fecha;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Numeradores: correlativos sin huecos (§3.3).
-- fn_siguiente_numero bloquea la fila con UPDATE: dos transacciones simultáneas
-- esperan su turno, y si la transacción se revierte el número no se pierde.
-- ---------------------------------------------------------------------
create table numerador (
  id              uuid primary key default gen_random_uuid(),
  tipo_documento  text not null,
  serie           varchar(6) not null default 'A',
  sucursal_id     uuid references sucursal(id),
  prefijo         text not null default '',
  siguiente       bigint not null default 1 check (siguiente > 0),
  unique (tipo_documento, serie)
);

create function fn_siguiente_numero(p_tipo text, p_serie text default 'A') returns bigint
language plpgsql as $$
declare v bigint;
begin
  update numerador
     set siguiente = siguiente + 1
   where tipo_documento = p_tipo and serie = p_serie
  returning siguiente - 1 into v;
  if v is null then
    raise exception 'No existe numerador para % serie %', p_tipo, p_serie;
  end if;
  return v;
end $$;

create trigger empresa_audit          after insert or update or delete on empresa          for each row execute function fn_audit();
create trigger sucursal_audit         after insert or update or delete on sucursal         for each row execute function fn_audit();
create trigger tasa_cambio_audit      after insert or update or delete on tasa_cambio      for each row execute function fn_audit();
create trigger parametro_fiscal_audit after insert or update or delete on parametro_fiscal for each row execute function fn_audit();
-- El numerador se audita al crearlo, borrarlo o cambiar su configuración; no en cada número emitido.
create trigger numerador_audit        after insert or delete on numerador                  for each row execute function fn_audit();
create trigger numerador_audit_config after update of tipo_documento, serie, sucursal_id, prefijo on numerador
  for each row execute function fn_audit();
-- Un salto manual del contador (distinto de +1) sí queda auditado: es la forma de crear huecos.
create trigger numerador_audit_salto after update of siguiente on numerador
  for each row when (new.siguiente <> old.siguiente + 1) execute function fn_audit();
