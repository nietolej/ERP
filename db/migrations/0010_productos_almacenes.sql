-- =====================================================================
-- 0010 · Productos, catálogos, alícuotas de IVA, listas de precio y almacenes (§5.3, §4.3)
--
--   R-O  La alícuota de IVA de un producto es una categoría; su porcentaje sale de
--        parametro_fiscal con vigencia por fecha. Ningún porcentaje vive aquí.
--   R-P  Un precio no se edita ni se borra: un cambio es una fila nueva con su vigencia,
--        que no puede empezar antes de hoy (no se reescribe el pasado).
--   R-Q  El código del producto es único sin importar mayúsculas y no se cambia.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Alícuotas de IVA: categorías. `parametros` son los códigos de parametro_fiscal que se
-- suman (el lujo = general + adicional). Vacío = 0 % (exento, exonerado).
-- ---------------------------------------------------------------------
create table alicuota_iva (
  id         uuid primary key default gen_random_uuid(),
  codigo     varchar(12) not null unique check (codigo ~ '^[A-Z_]+$'),
  nombre     text not null,
  parametros text[] not null default '{}',
  tipo_libro text not null check (tipo_libro in ('gravada', 'exenta', 'exonerada', 'no_sujeta')),
  activa     boolean not null default true,
  check ((tipo_libro = 'gravada') = (cardinality(parametros) > 0))
);

create function fn_alicuota_iva_parametros() returns trigger
language plpgsql as $$
declare c text;
begin
  foreach c in array new.parametros loop
    if not exists (select 1 from parametro_fiscal where codigo = c) then
      raise exception 'El parámetro fiscal % no existe', c;
    end if;
  end loop;
  return new;
end $$;

create trigger alicuota_iva_parametros
  before insert or update on alicuota_iva
  for each row execute function fn_alicuota_iva_parametros();

insert into alicuota_iva (codigo, nombre, parametros, tipo_libro) values
  ('GENERAL',   'General',                    array['IVA_GENERAL'],                        'gravada'),
  ('REDUCIDA',  'Reducida',                   array['IVA_REDUCIDA'],                       'gravada'),
  ('LUJO',      'General + adicional (lujo)', array['IVA_GENERAL', 'IVA_LUJO_ADICIONAL'],  'gravada'),
  ('EXENTO',    'Exento',                     '{}',                                        'exenta'),
  ('EXONERADO', 'Exonerado',                  '{}',                                        'exonerada');

-- Porcentaje vigente de una alícuota en una fecha.
create function fn_alicuota_iva_pct(p_alicuota uuid, p_fecha date) returns numeric
language plpgsql stable as $$
declare
  v_param text[];
  v_total numeric := 0;
  c       text;
begin
  select parametros into v_param from alicuota_iva where id = p_alicuota;
  if v_param is null then
    raise exception 'La alícuota de IVA % no existe', p_alicuota;
  end if;
  foreach c in array v_param loop
    v_total := v_total + fn_parametro_fiscal(c, p_fecha);
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------------
-- Catálogos que crea el usuario
-- ---------------------------------------------------------------------
create table grupo_producto (
  id     uuid primary key default gen_random_uuid(),
  codigo varchar(20) not null unique check (codigo ~ '^[A-Z0-9][A-Z0-9 ._\-]*$'),
  nombre text not null,
  activo boolean not null default true
);

create table marca (
  id     uuid primary key default gen_random_uuid(),
  codigo varchar(20) not null unique check (codigo ~ '^[A-Z0-9][A-Z0-9 ._\-]*$'),
  nombre text not null,
  activo boolean not null default true
);

-- ---------------------------------------------------------------------
-- Productos
-- ---------------------------------------------------------------------
create table producto (
  id              uuid primary key default gen_random_uuid(),
  codigo          varchar(30) not null check (codigo ~ '^[A-Z0-9][A-Z0-9\-./]*$'),
  descripcion     text not null check (length(trim(descripcion)) > 2),
  grupo_id        uuid references grupo_producto(id),
  marca_id        uuid references marca(id),
  familia         text,
  unidad          varchar(10) not null default 'UND' check (unidad ~ '^[A-Z]{1,10}$'),
  alicuota_iva_id uuid not null references alicuota_iva(id),
  inventariable   boolean not null default true,
  codigo_alterno  varchar(30),
  peso_kg         numeric(10,3) check (peso_kg is null or peso_kg >= 0),
  foto_url        text,                                      -- se llena con el módulo de adjuntos
  estado          text not null default 'activo' check (estado in ('activo', 'inactivo')),
  created_at      timestamptz not null default now(),
  created_by      uuid references usuario(id)
);
create unique index producto_codigo_unico on producto (upper(codigo));
create index producto_descripcion_idx on producto (fn_nombre_normalizado(descripcion));

create function fn_producto_codigo_fijo() returns trigger
language plpgsql as $$
begin
  if new.codigo <> old.codigo then
    raise exception 'El código de un producto no se cambia';
  end if;
  return new;
end $$;

create trigger producto_codigo_fijo
  before update on producto
  for each row execute function fn_producto_codigo_fijo();

-- Referencias cruzadas OEM y alternas por fabricante.
create table producto_referencia (
  id          uuid primary key default gen_random_uuid(),
  producto_id uuid not null references producto(id) on delete cascade,
  tipo        text not null check (tipo in ('oem', 'alterna')),
  fabricante  text not null check (length(trim(fabricante)) > 0),
  referencia  varchar(40) not null check (length(trim(referencia)) > 0),
  created_at  timestamptz not null default now(),
  unique (producto_id, fabricante, referencia)
);
-- Para buscar por referencia sin guiones, puntos ni espacios.
create index producto_referencia_busqueda on producto_referencia (upper(regexp_replace(referencia, '[^A-Za-z0-9]', '', 'g')));

-- ---------------------------------------------------------------------
-- Listas y precios (USD). El costo NO es una lista: sale del inventario (§8).
-- ---------------------------------------------------------------------
create table lista_precio (
  codigo char(1) primary key check (codigo ~ '^[A-Z]$'),
  nombre text not null,
  moneda varchar(4) not null references moneda(codigo)
);
insert into lista_precio (codigo, nombre, moneda) values
  ('A', 'Lista A', 'USD'), ('B', 'Lista B', 'USD'), ('D', 'Lista D', 'USD');

create table precio (
  id            uuid primary key default gen_random_uuid(),
  producto_id   uuid not null references producto(id),
  lista         char(1) not null references lista_precio(codigo),
  precio        numeric(14,2) not null check (precio >= 0),
  vigente_desde date not null,
  created_by    uuid references usuario(id),
  created_at    timestamptz not null default now(),
  unique (producto_id, lista, vigente_desde)
);

create function fn_precio_inmutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    -- R-P: no se reescribe el pasado (fecha de Venezuela).
    if new.vigente_desde < (now() at time zone 'America/Caracas')::date then
      raise exception 'Un precio no puede empezar a regir antes de hoy';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;
  raise exception 'Un precio no se modifica ni se borra: registre un precio nuevo con su fecha de vigencia';
end $$;

create trigger precio_inmutable
  before insert or update or delete on precio
  for each row execute function fn_precio_inmutable();

-- Precio vigente de un producto en una lista y una fecha (null si no tiene).
create function fn_precio(p_producto uuid, p_lista char, p_fecha date) returns numeric
language sql stable as $$
  select precio from precio
   where producto_id = p_producto and lista = p_lista and vigente_desde <= p_fecha
   order by vigente_desde desc limit 1
$$;

-- ---------------------------------------------------------------------
-- Almacenes y almacenes visibles por usuario (§4.3)
-- ---------------------------------------------------------------------
create table almacen (
  id            uuid primary key default gen_random_uuid(),
  codigo        varchar(6) not null unique check (codigo ~ '^[A-Z0-9]+$'),
  nombre        text not null check (length(trim(nombre)) > 1),
  sucursal_id   uuid not null references sucursal(id),
  es_comercial  boolean not null default true,
  permite_venta boolean not null default true,
  activo        boolean not null default true,
  created_at    timestamptz not null default now(),
  check (not permite_venta or es_comercial)          -- solo un almacén comercial vende
);

create table usuario_almacen (
  usuario_id uuid not null references usuario(id) on delete cascade,
  almacen_id uuid not null references almacen(id),
  primary key (usuario_id, almacen_id)
);

create trigger alicuota_iva_audit     after insert or update or delete on alicuota_iva     for each row execute function fn_audit();
create trigger grupo_producto_audit   after insert or update or delete on grupo_producto   for each row execute function fn_audit();
create trigger marca_audit            after insert or update or delete on marca            for each row execute function fn_audit();
create trigger producto_audit         after insert or update or delete on producto         for each row execute function fn_audit();
create trigger producto_referencia_audit after insert or update or delete on producto_referencia for each row execute function fn_audit();
create trigger precio_audit           after insert on precio                               for each row execute function fn_audit();
create trigger almacen_audit          after insert or update or delete on almacen          for each row execute function fn_audit();
create trigger usuario_almacen_audit  after insert or update or delete on usuario_almacen  for each row execute function fn_audit();
