-- =====================================================================
-- 0013 · Metas de venta con versiones y aprobación (§5.4, spec_reportes §10)
--
--   R-T  Cada carga (por Excel o manual) crea un lote con número de versión, usuario y fecha.
--        Un lote nace 'pendiente' y solo se aprueba o se rechaza, una vez.
--   R-U  Solo Gerencia aprueba o rechaza, y quien cargó el lote no lo aprueba.
--        Cargan Gerencia y Supervisor de ventas.
--   R-V  Las filas de un lote no se editan ni se borran. Cambiar una meta es cargar un lote
--        nuevo; la meta vigente de cada clave es la del último lote aprobado.
--   R-W  Una meta apunta a un cliente, vendedor, producto o grupo que existe; la global no
--        apunta a nadie. Los montos son USD, no negativos, con 2 decimales.
--
-- Cambia la forma de meta_venta de la especificación §5.4: la versión pasa al lote.
-- Se retira el tipo 'sucursal': la carga por Excel (spec_reportes §10) no lo contempla.
-- =====================================================================

create table meta_lote (
  id             uuid primary key default gen_random_uuid(),
  version        int generated always as identity unique,
  origen         text not null check (origen in ('excel', 'manual')),
  archivo        text,                                   -- nombre del archivo cargado (solo Excel)
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  creado_por     uuid not null references usuario(id),
  created_at     timestamptz not null default now(),
  resuelto_por   uuid references usuario(id),
  resuelto_at    timestamptz,
  motivo_rechazo text,
  check ((estado = 'pendiente') = (resuelto_por is null and resuelto_at is null)),
  check (estado <> 'rechazado' or length(trim(coalesce(motivo_rechazo, ''))) > 2)
);

create table meta_venta (
  id         uuid primary key default gen_random_uuid(),
  lote_id    uuid not null references meta_lote(id),
  tipo       text not null check (tipo in ('global', 'vendedor', 'cliente', 'producto', 'grupo')),
  entidad_id uuid,
  anio       smallint not null check (anio between 2000 and 2100),
  mes        smallint check (mes between 1 and 12),     -- null = meta anual
  monto_usd  numeric(14,2) not null check (monto_usd >= 0),
  check ((tipo = 'global') = (entidad_id is null))
);

create unique index meta_venta_clave on meta_venta
  (lote_id, tipo, coalesce(entidad_id, '00000000-0000-0000-0000-000000000000'::uuid), anio, coalesce(mes, 0));
create index meta_venta_vigente_idx on meta_venta (tipo, entidad_id, anio, mes);

-- ---------------------------------------------------------------------
-- Reglas del lote
-- ---------------------------------------------------------------------
create function fn_meta_lote_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un lote de metas no se borra';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Un lote de metas nace pendiente de aprobación';
    end if;
    if not (fn_tiene_rol(new.creado_por, 'gerencia') or fn_tiene_rol(new.creado_por, 'supervisor_ventas')) then
      raise exception 'Solo Gerencia o Supervisor de ventas cargan metas';
    end if;
    return new;
  end if;

  -- UPDATE: solo pasa de pendiente a aprobado o rechazado; lo demás no cambia.
  if old.estado <> 'pendiente' then
    raise exception 'Un lote de metas ya resuelto no se modifica';
  end if;
  if new.version <> old.version or new.origen <> old.origen or new.creado_por <> old.creado_por
     or new.created_at <> old.created_at or new.archivo is distinct from old.archivo then
    raise exception 'Solo se puede aprobar o rechazar un lote de metas';
  end if;
  if new.estado = 'pendiente' then
    raise exception 'Solo se puede aprobar o rechazar un lote de metas';
  end if;
  if new.resuelto_por is null or not fn_tiene_rol(new.resuelto_por, 'gerencia') then
    raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar o rechazar metas';
  end if;
  if new.estado = 'aprobado' then
    if new.resuelto_por = old.creado_por then
      raise exception 'Quien carga las metas no las aprueba';
    end if;
    if not exists (select 1 from meta_venta where lote_id = old.id) then
      raise exception 'No se puede aprobar un lote de metas sin filas';
    end if;
  end if;
  new.resuelto_at := now();
  return new;
end $$;

create trigger meta_lote_reglas
  before insert or update or delete on meta_lote
  for each row execute function fn_meta_lote_reglas();

-- ---------------------------------------------------------------------
-- Reglas de las filas
-- ---------------------------------------------------------------------
create function fn_meta_venta_reglas() returns trigger
language plpgsql as $$
declare v_existe boolean;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Las metas de un lote no se modifican ni se borran: cargue un lote nuevo';
  end if;
  if (select estado from meta_lote where id = new.lote_id) <> 'pendiente' then
    raise exception 'No se agregan metas a un lote ya resuelto';
  end if;
  v_existe := case new.tipo
    when 'global'   then true
    when 'vendedor' then exists (select 1 from vendedor where id = new.entidad_id)
    when 'cliente'  then exists (select 1 from cliente where tercero_id = new.entidad_id)
    when 'producto' then exists (select 1 from producto where id = new.entidad_id)
    when 'grupo'    then exists (select 1 from grupo_producto where id = new.entidad_id)
  end;
  if not v_existe then
    raise exception 'La meta apunta a un % que no existe', new.tipo;
  end if;
  return new;
end $$;

create trigger meta_venta_reglas
  before insert or update or delete on meta_venta
  for each row execute function fn_meta_venta_reglas();

create trigger meta_lote_audit  after insert or update or delete on meta_lote  for each row execute function fn_audit();
create trigger meta_venta_audit after insert or update or delete on meta_venta for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Vistas (spec_reportes §12): las metas se leen siempre desde aquí.
-- ---------------------------------------------------------------------
create function fn_meta_entidad(p_tipo text, p_id uuid) returns text
language sql stable as $$
  select case p_tipo
    when 'global'   then 'Global'
    when 'vendedor' then (select v.codigo || ' · ' || v.nombre from vendedor v where v.id = p_id)
    when 'cliente'  then (select c.codigo || ' · ' || t.razon_social from cliente c join tercero t on t.id = c.tercero_id where c.tercero_id = p_id)
    when 'producto' then (select p.codigo || ' · ' || p.descripcion from producto p where p.id = p_id)
    when 'grupo'    then (select g.codigo || ' · ' || g.nombre from grupo_producto g where g.id = p_id)
  end
$$;

-- Meta aprobada vigente por tipo × entidad × año × mes (mes nulo = meta anual): la del último lote aprobado.
create view vw_meta_periodo as
select distinct on (m.tipo, m.entidad_id, m.anio, m.mes)
       m.tipo, m.entidad_id, fn_meta_entidad(m.tipo, m.entidad_id) as entidad,
       m.anio, m.mes, m.monto_usd, l.id as lote_id, l.version
  from meta_venta m
  join meta_lote l on l.id = m.lote_id and l.estado = 'aprobado'
 order by m.tipo, m.entidad_id, m.anio, m.mes, l.resuelto_at desc, l.version desc;

-- Meta anual efectiva: si hay metas mensuales, su suma; si no, la meta anual.
create view vw_meta_anual as
select tipo, entidad_id, anio,
       case when count(mes) > 0 then sum(monto_usd) filter (where mes is not null) else sum(monto_usd) end as monto_usd
  from vw_meta_periodo
 group by tipo, entidad_id, anio;

-- Meta global de un año: la fila GLOBAL si existe; si no, la suma de las metas de los vendedores.
create function fn_meta_global(p_anio int) returns table (origen text, monto_usd numeric)
language sql stable as $$
  select 'global'::text, monto_usd from vw_meta_anual where tipo = 'global' and anio = p_anio
  union all
  select 'suma_vendedores'::text, sum(monto_usd) from vw_meta_anual
   where tipo = 'vendedor' and anio = p_anio
     and not exists (select 1 from vw_meta_anual where tipo = 'global' and anio = p_anio)
  having count(*) > 0
$$;
