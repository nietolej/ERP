-- =====================================================================
-- 0011 · Segmentación de productos: código común, categorías jerárquicas,
--        aplicación vehicular y atributos (§5.3). Base para pronósticos,
--        elasticidad de precio y análisis de promociones (Fase 8).
--
--   R-R  Un código común (producto_base) agrupa el mismo artículo en varias marcas:
--        cada producto de marca pertenece a un código común y hay uno solo por marca.
--   R-S  La categoría del producto es la de su código común (se sincroniza en la base).
--   R-T  Las categorías forman un árbol: un nodo no puede ser su propio ancestro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Categorías jerárquicas (sistema → subsistema…), reemplazan la "familia" en texto libre.
-- ---------------------------------------------------------------------
create table categoria_producto (
  id       uuid primary key default gen_random_uuid(),
  codigo   varchar(20) not null unique check (codigo ~ '^[A-Z0-9][A-Z0-9._\-]*$'),
  nombre   text not null check (length(trim(nombre)) > 1),
  padre_id uuid references categoria_producto(id),
  activa   boolean not null default true
);

create function fn_categoria_sin_ciclos() returns trigger
language plpgsql as $$
begin
  if new.padre_id is not null and exists (
    with recursive ancestros(id) as (
      select new.padre_id
      union
      select c.padre_id from categoria_producto c join ancestros a on c.id = a.id where c.padre_id is not null
    )
    select 1 from ancestros where id = new.id
  ) then
    raise exception 'Una categoría no puede quedar dentro de sí misma';
  end if;
  return new;
end $$;

create trigger categoria_sin_ciclos
  before insert or update on categoria_producto
  for each row execute function fn_categoria_sin_ciclos();

-- Ruta legible de una categoría ("Frenos › Pastillas").
create function fn_categoria_ruta(p_id uuid) returns text
language sql stable as $$
  with recursive camino(id, nombre, padre_id, nivel) as (
    select id, nombre, padre_id, 0 from categoria_producto where id = p_id
    union all
    select c.id, c.nombre, c.padre_id, k.nivel + 1 from categoria_producto c join camino k on c.id = k.padre_id
  )
  select string_agg(nombre, ' › ' order by nivel desc) from camino
$$;

-- ---------------------------------------------------------------------
-- Código común: el artículo genérico que se vende en una o varias marcas.
-- ---------------------------------------------------------------------
create table producto_base (
  id           uuid primary key default gen_random_uuid(),
  codigo       varchar(30) not null check (codigo ~ '^[A-Z0-9][A-Z0-9\-./]*$'),
  descripcion  text not null check (length(trim(descripcion)) > 2),
  categoria_id uuid references categoria_producto(id),
  estado       text not null default 'activo' check (estado in ('activo', 'inactivo')),
  created_at   timestamptz not null default now(),
  created_by   uuid references usuario(id)
);
create unique index producto_base_codigo_unico on producto_base (upper(codigo));
create index producto_base_descripcion_idx on producto_base (fn_nombre_normalizado(descripcion));

create function fn_producto_base_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.codigo <> old.codigo then
    raise exception 'El código común no se cambia';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
  end if;
  return new;
end $$;

create trigger producto_base_antes
  before insert or update on producto_base
  for each row execute function fn_producto_base_antes();

-- Aplicación vehicular: un repuesto sirve para varios modelos y años.
create table producto_base_aplicacion (
  id               uuid primary key default gen_random_uuid(),
  producto_base_id uuid not null references producto_base(id) on delete cascade,
  grupo_id         uuid not null references grupo_producto(id),     -- modelo de vehículo
  anio_desde       smallint check (anio_desde between 1950 and 2100),
  anio_hasta       smallint check (anio_hasta between 1950 and 2100),
  motor            varchar(30),
  check (anio_hasta is null or anio_desde is null or anio_hasta >= anio_desde)
);
create unique index producto_base_aplicacion_unica
  on producto_base_aplicacion (producto_base_id, grupo_id, coalesce(anio_desde, 0), coalesce(motor, ''));

-- ---------------------------------------------------------------------
-- Producto de marca: código común, categoría (heredada), línea de calidad y origen.
-- La "familia" en texto libre se reemplaza por la categoría.
-- ---------------------------------------------------------------------
alter table producto drop column familia;
alter table producto
  add column producto_base_id uuid references producto_base(id),
  add column categoria_id     uuid references categoria_producto(id),
  add column linea_calidad    text check (linea_calidad in ('original', 'oem', 'alterna')),
  add column pais_origen      char(2) check (pais_origen ~ '^[A-Z]{2}$'),
  add constraint producto_base_requiere_marca check (producto_base_id is null or marca_id is not null);
-- R-R: una sola marca por código común.
create unique index producto_base_marca_unica on producto (producto_base_id, marca_id) where producto_base_id is not null;
create index producto_base_idx on producto (producto_base_id);

-- R-S: la categoría del producto es la de su código común.
create function fn_producto_categoria() returns trigger
language plpgsql as $$
begin
  if new.producto_base_id is not null then
    select categoria_id into new.categoria_id from producto_base where id = new.producto_base_id;
  end if;
  return new;
end $$;

create trigger producto_categoria
  before insert or update on producto
  for each row execute function fn_producto_categoria();

create function fn_producto_base_categoria_propaga() returns trigger
language plpgsql as $$
begin
  if new.categoria_id is distinct from old.categoria_id then
    update producto set categoria_id = new.categoria_id where producto_base_id = new.id;
  end if;
  return null;
end $$;

create trigger producto_base_categoria_propaga
  after update on producto_base
  for each row execute function fn_producto_base_categoria_propaga();

create trigger categoria_producto_audit       after insert or update or delete on categoria_producto       for each row execute function fn_audit();
create trigger producto_base_audit            after insert or update or delete on producto_base            for each row execute function fn_audit();
create trigger producto_base_aplicacion_audit after insert or update or delete on producto_base_aplicacion for each row execute function fn_audit();
