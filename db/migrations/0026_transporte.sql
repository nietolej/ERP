-- =====================================================================
-- 0026 · Direcciones de entrega, transportistas, vehículos, tarifas y transporte con paradas (§5.1, §5.4, §6.4)
--
--   R-BJ  Un cliente tiene una o más direcciones de entrega con ubicación (latitud y longitud, ambas o ninguna, dentro de
--         Venezuela) y un horario de recepción por día. La ventana es blanda por defecto. Una sola dirección vigente es la
--         predeterminada; no se inactiva una dirección con un transporte en curso.
--   R-BK  Un transportista es flota propia o un proveedor de servicios ya aprobado (carga o encomienda). La modalidad y el
--         proveedor no cambian. Los vehículos no aplican a la encomienda; la placa es única.
--   R-BL  Las tarifas de un transportista de terceros no se editan ni se borran: una nueva tarifa trae su vigencia y no se
--         solapa con otra del mismo destino y unidad. Solo se puede cerrar la vigencia de una abierta.
--   R-BM  El transporte avanza por transiciones válidas: planificado → cargado → en_ruta → entregado → cerrado. Solo se anula
--         uno planificado. Las marcas de hora las pone la base de datos. Cargar exige que la mercancía de todas sus notas
--         ya haya salido del almacén (la salida la confirma el almacén con el asiento de §6.4).
--   R-BN  Una nota de entrega solo tiene una parada vigente: no puede estar en dos transportes a la vez. Al cerrar un transporte,
--         las paradas no entregadas quedan libres para otro transporte.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Direcciones de entrega del cliente
-- ---------------------------------------------------------------------
create table cliente_direccion_entrega (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid not null references cliente(tercero_id),
  nombre            text not null check (length(trim(nombre)) > 1),
  direccion         text not null check (length(trim(direccion)) > 4),
  ciudad            text not null check (length(trim(ciudad)) > 1),
  entidad_federal   text not null check (length(trim(entidad_federal)) > 1),
  latitud           numeric(9,6),
  longitud          numeric(9,6),
  contacto_nombre   text,
  contacto_telefono text,
  minutos_descarga  smallint not null default 15 check (minutos_descarga between 1 and 480),
  ventana_tipo      text not null default 'blanda' check (ventana_tipo in ('blanda', 'dura')),
  observaciones     text,
  predeterminada    boolean not null default false,
  activa            boolean not null default true,
  created_at        timestamptz not null default now(),
  created_by        uuid references usuario(id),
  check ((latitud is null) = (longitud is null)),
  -- Cuadro que contiene a Venezuela: atrapa lo más común, la latitud y la longitud invertidas.
  check (latitud is null or (latitud between 0.5 and 12.5 and longitud between -73.5 and -59.5)),
  check (not predeterminada or activa)
);
create index cliente_direccion_cliente_idx on cliente_direccion_entrega (cliente_id, activa);
create unique index cliente_direccion_predeterminada on cliente_direccion_entrega (cliente_id) where predeterminada;

create table cliente_direccion_ventana (
  id           uuid primary key default gen_random_uuid(),
  direccion_id uuid not null references cliente_direccion_entrega(id),
  dia_semana   smallint not null check (dia_semana between 1 and 7),     -- 1 = lunes … 7 = domingo (ISO)
  hora_desde   time not null,                                             -- hora de Caracas
  hora_hasta   time not null,
  check (hora_hasta > hora_desde)
);
create index cliente_direccion_ventana_idx on cliente_direccion_ventana (direccion_id, dia_semana);

-- ¿Un instante cae dentro de la ventana de recepción? null si la dirección no tiene ventana (recibe a cualquier hora).
create function fn_en_ventana(p_direccion uuid, p_instante timestamptz) returns boolean
language sql stable as $$
  select case
    when not exists (select 1 from cliente_direccion_ventana where direccion_id = p_direccion) then null
    else exists (
      select 1 from cliente_direccion_ventana v
       where v.direccion_id = p_direccion
         and v.dia_semana = extract(isodow from (p_instante at time zone 'America/Caracas'))::int
         and (p_instante at time zone 'America/Caracas')::time between v.hora_desde and v.hora_hasta)
  end
$$;

create function fn_cliente_direccion_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una dirección de entrega no se borra: se inactiva';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    -- La primera dirección vigente de un cliente es la predeterminada.
    if new.activa and not new.predeterminada
       and not exists (select 1 from cliente_direccion_entrega where cliente_id = new.cliente_id and predeterminada) then
      new.predeterminada := true;
    end if;
  else
    if new.cliente_id <> old.cliente_id then
      raise exception 'Una dirección de entrega no cambia de cliente';
    end if;
    if old.activa and not new.activa and exists (
         select 1 from transporte_parada p join transporte t on t.id = p.transporte_id
          where p.direccion_entrega_id = old.id and p.vigente and t.estado in ('planificado', 'cargado', 'en_ruta')) then
      raise exception 'La dirección tiene un transporte en curso: no se puede inactivar';
    end if;
  end if;

  if not new.activa then
    new.predeterminada := false;
  end if;
  if new.predeterminada then
    -- Solo una predeterminada por cliente: la anterior deja de serlo.
    update cliente_direccion_entrega set predeterminada = false
     where cliente_id = new.cliente_id and predeterminada and id is distinct from new.id;
  end if;
  return new;
end $$;

create trigger cliente_direccion_antes
  before insert or update or delete on cliente_direccion_entrega
  for each row execute function fn_cliente_direccion_antes();

create function fn_cliente_direccion_ventana_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and new.direccion_id <> old.direccion_id then
    raise exception 'Una ventana de recepción no cambia de dirección';
  end if;
  if exists (
       select 1 from cliente_direccion_ventana v
        where v.direccion_id = new.direccion_id and v.dia_semana = new.dia_semana and v.id is distinct from new.id
          and v.hora_desde < new.hora_hasta and new.hora_desde < v.hora_hasta) then
    raise exception 'Los horarios de recepción de un mismo día no pueden solaparse';
  end if;
  return new;
end $$;

create trigger cliente_direccion_ventana_antes
  before insert or update or delete on cliente_direccion_ventana
  for each row execute function fn_cliente_direccion_ventana_antes();

-- ---------------------------------------------------------------------
-- Transportistas, vehículos y tarifas
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('transportista', 'A', 'T', 1);
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('transporte', 'A', '', 1);

create table transportista (
  id                uuid primary key default gen_random_uuid(),
  codigo            varchar(10) not null unique,
  nombre            text not null check (length(trim(nombre)) > 1),
  modalidad         text not null check (modalidad in ('flota_propia', 'carga', 'encomienda')),
  proveedor_id      uuid references proveedor(tercero_id),
  contacto_telefono text,
  observaciones     text,
  activo            boolean not null default true,
  created_at        timestamptz not null default now(),
  created_by        uuid references usuario(id),
  check ((modalidad = 'flota_propia') = (proveedor_id is null))
);
create unique index transportista_nombre_unico on transportista (fn_nombre_normalizado(nombre));
create unique index transportista_proveedor_modalidad on transportista (proveedor_id, modalidad) where proveedor_id is not null;

create function fn_transportista_antes() returns trigger
language plpgsql as $$
declare v_prefijo text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un transportista no se borra: se inactiva';
  end if;
  if tg_op = 'INSERT' then
    if new.codigo is not null then
      raise exception 'El código del transportista lo asigna el sistema';
    end if;
    select prefijo into v_prefijo from numerador where tipo_documento = 'transportista' and serie = 'A';
    new.codigo := v_prefijo || lpad(fn_siguiente_numero('transportista', 'A')::text, 5, '0');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.proveedor_id is not null and not exists (
         select 1 from proveedor where tercero_id = new.proveedor_id and tipo = 'servicios' and estado = 'activo') then
      raise exception 'El transportista de terceros debe ser un proveedor de servicios ya aprobado y activo';
    end if;
    return new;
  end if;

  if new.codigo <> old.codigo or new.modalidad <> old.modalidad or new.proveedor_id is distinct from old.proveedor_id then
    raise exception 'El código, la modalidad y el proveedor de un transportista no se cambian';
  end if;
  if old.activo and not new.activo and exists (
       select 1 from transporte where transportista_id = old.id and estado in ('planificado', 'cargado', 'en_ruta')) then
    raise exception 'El transportista tiene un transporte en curso: no se puede inactivar';
  end if;
  return new;
end $$;

create trigger transportista_antes
  before insert or update or delete on transportista
  for each row execute function fn_transportista_antes();

create table vehiculo (
  id               uuid primary key default gen_random_uuid(),
  transportista_id uuid not null references transportista(id),
  placa            varchar(10) not null unique check (placa ~ '^[A-Z0-9]{5,10}$'),
  descripcion      text not null check (length(trim(descripcion)) > 1),
  capacidad_kg     numeric(10,2) check (capacidad_kg > 0),
  capacidad_m3     numeric(8,3) check (capacidad_m3 > 0),
  costo_km_usd     numeric(10,4) check (costo_km_usd >= 0),
  costo_hora_usd   numeric(10,2) check (costo_hora_usd >= 0),
  activo           boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid references usuario(id)
);
create index vehiculo_transportista_idx on vehiculo (transportista_id, activo);

create function fn_vehiculo_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un vehículo no se borra: se inactiva';
  end if;
  new.placa := upper(regexp_replace(trim(new.placa), '[\s-]', '', 'g'));
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if (select modalidad from transportista where id = new.transportista_id) = 'encomienda' then
      raise exception 'Un servicio de encomienda no tiene vehículos propios';
    end if;
    return new;
  end if;
  if new.transportista_id <> old.transportista_id then
    raise exception 'Un vehículo no cambia de transportista';
  end if;
  if old.activo and not new.activo and exists (
       select 1 from transporte where vehiculo_id = old.id and estado in ('planificado', 'cargado', 'en_ruta')) then
    raise exception 'El vehículo tiene un transporte en curso: no se puede inactivar';
  end if;
  return new;
end $$;

create trigger vehiculo_antes
  before insert or update or delete on vehiculo
  for each row execute function fn_vehiculo_antes();

create table transportista_tarifa (
  id               uuid primary key default gen_random_uuid(),
  transportista_id uuid not null references transportista(id),
  entidad_federal  text,
  ciudad           text,
  unidad_cobro     text not null check (unidad_cobro in ('por_viaje', 'por_kg', 'por_m3', 'por_bulto')),
  moneda           char(3) not null references moneda(codigo),
  monto            numeric(14,4) not null check (monto >= 0),
  minimo           numeric(14,2) not null default 0 check (minimo >= 0),
  vigente_desde    date not null,
  vigente_hasta    date,
  created_at       timestamptz not null default now(),
  created_by       uuid references usuario(id),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  check (ciudad is null or entidad_federal is not null)
);
create index transportista_tarifa_idx on transportista_tarifa (transportista_id, unidad_cobro);

create function fn_transportista_tarifa_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una tarifa no se borra: se cierra su vigencia';
  end if;

  if tg_op = 'UPDATE' then
    -- Solo se cierra (o se acorta) la vigencia.
    if (to_jsonb(new) - 'vigente_hasta') is distinct from (to_jsonb(old) - 'vigente_hasta') then
      raise exception 'Una tarifa no se edita: se cierra su vigencia y se carga una nueva';
    end if;
    if new.vigente_hasta is null or (old.vigente_hasta is not null and new.vigente_hasta > old.vigente_hasta) then
      raise exception 'Solo se puede cerrar o acortar la vigencia de una tarifa';
    end if;
    return new;
  end if;

  new.created_by := coalesce(new.created_by, fn_usuario_actual());
  if (select modalidad from transportista where id = new.transportista_id) = 'flota_propia' then
    raise exception 'La flota propia no tiene tarifas: su costo sale de los vehículos';
  end if;
  if new.vigente_desde < (now() at time zone 'America/Caracas')::date then
    raise exception 'La vigencia de una tarifa no puede empezar en el pasado';
  end if;
  new.entidad_federal := nullif(trim(new.entidad_federal), '');
  new.ciudad := nullif(trim(new.ciudad), '');
  if exists (
       select 1 from transportista_tarifa t
        where t.transportista_id = new.transportista_id and t.unidad_cobro = new.unidad_cobro
          and fn_nombre_normalizado(t.entidad_federal) = fn_nombre_normalizado(new.entidad_federal)
          and fn_nombre_normalizado(t.ciudad) = fn_nombre_normalizado(new.ciudad)
          and daterange(t.vigente_desde, t.vigente_hasta, '[]') && daterange(new.vigente_desde, new.vigente_hasta, '[]')) then
    raise exception 'Ya hay una tarifa de ese transportista, destino y unidad que cubre esas fechas';
  end if;
  return new;
end $$;

create trigger transportista_tarifa_antes
  before insert or update or delete on transportista_tarifa
  for each row execute function fn_transportista_tarifa_antes();

-- ---------------------------------------------------------------------
-- Transporte
-- ---------------------------------------------------------------------
create table transporte (
  id               uuid primary key default gen_random_uuid(),
  serie            varchar(4) not null default 'A',
  numero           bigint not null,
  estado           text not null default 'planificado'
                   check (estado in ('planificado', 'cargado', 'en_ruta', 'entregado', 'cerrado', 'anulado')),
  almacen_id       uuid not null references almacen(id),
  transportista_id uuid not null references transportista(id),
  vehiculo_id      uuid references vehiculo(id),
  chofer           text,
  fecha_programada date not null,
  cargado_at       timestamptz,
  salida_at        timestamptz,
  cierre_at        timestamptz,
  flete_usd        numeric(14,2) not null default 0 check (flete_usd >= 0),
  observaciones    text,
  anulado_por      uuid references usuario(id),
  anulado_at       timestamptz,
  anulado_motivo   text,
  created_by       uuid not null references usuario(id),
  created_at       timestamptz not null default now(),
  unique (serie, numero),
  check (estado <> 'anulado' or length(trim(coalesce(anulado_motivo, ''))) > 2),
  check ((estado = 'anulado') = (anulado_at is not null))
);
create index transporte_estado_idx on transporte (estado, fecha_programada);
create index transporte_transportista_idx on transporte (transportista_id);

create table transporte_parada (
  id                   uuid primary key default gen_random_uuid(),
  transporte_id        uuid not null references transporte(id),
  nota_entrega_id      uuid not null references documento_venta(id),
  direccion_entrega_id uuid not null references cliente_direccion_entrega(id),
  orden                smallint not null check (orden > 0),
  llegada_at           timestamptz,
  resultado            text check (resultado in ('entregada', 'no_entregada')),
  resultado_at         timestamptz,
  recibido_por         text,
  incidencia           text,
  vigente              boolean not null default true,
  unique (transporte_id, nota_entrega_id),
  unique (transporte_id, orden) deferrable initially deferred,
  check ((resultado is null) = (resultado_at is null)),
  check (resultado is distinct from 'entregada' or length(trim(coalesce(recibido_por, ''))) > 1),
  check (resultado is distinct from 'no_entregada' or length(trim(coalesce(incidencia, ''))) > 2)
);
create unique index transporte_parada_nota_vigente on transporte_parada (nota_entrega_id) where vigente;
create index transporte_parada_direccion_idx on transporte_parada (direccion_entrega_id);

-- Valida el transportista y el vehículo asignados a un transporte.
create function fn_transporte_validar_asignacion(t transporte) returns void
language plpgsql as $$
declare v_modalidad text;
begin
  if not exists (select 1 from almacen where id = t.almacen_id and activo) then
    raise exception 'El almacén de salida debe estar activo';
  end if;
  select modalidad into v_modalidad from transportista where id = t.transportista_id and activo;
  if v_modalidad is null then
    raise exception 'El transportista debe estar activo';
  end if;
  if t.vehiculo_id is not null and not exists (
       select 1 from vehiculo where id = t.vehiculo_id and transportista_id = t.transportista_id and activo) then
    raise exception 'El vehículo debe estar activo y pertenecer al transportista';
  end if;
end $$;

create function fn_transporte_antes() returns trigger
language plpgsql as $$
declare
  v_hoy       date := (now() at time zone 'America/Caracas')::date;
  v_modalidad text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un transporte no se borra: se anula';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'planificado' then
      raise exception 'Un transporte nace planificado';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un transporte necesita el usuario que lo crea';
    end if;
    if new.fecha_programada < v_hoy then
      raise exception 'La fecha programada no puede ser anterior a hoy';
    end if;
    perform fn_transporte_validar_asignacion(new);
    new.numero := fn_siguiente_numero('transporte', new.serie);
    new.cargado_at := null; new.salida_at := null; new.cierre_at := null;
    new.anulado_por := null; new.anulado_at := null;
    return new;
  end if;

  if new.serie <> old.serie or new.numero <> old.numero or new.almacen_id <> old.almacen_id
     or new.created_at <> old.created_at or new.created_by <> old.created_by then
    raise exception 'Un transporte no cambia de serie, número, almacén ni creador';
  end if;
  if old.estado in ('cerrado', 'anulado') then
    raise exception 'Un transporte % no se modifica', old.estado;
  end if;
  -- Las marcas de hora las pone la base de datos.
  new.cargado_at := old.cargado_at; new.salida_at := old.salida_at; new.cierre_at := old.cierre_at;
  new.anulado_por := old.anulado_por; new.anulado_at := old.anulado_at;
  if new.estado = old.estado then
    new.anulado_motivo := old.anulado_motivo;
  end if;

  if (new.transportista_id, new.vehiculo_id, new.chofer, new.fecha_programada)
       is distinct from (old.transportista_id, old.vehiculo_id, old.chofer, old.fecha_programada) then
    if old.estado <> 'planificado' then
      raise exception 'El transportista, el vehículo, el chofer y la fecha solo se cambian mientras el transporte está planificado';
    end if;
    if new.fecha_programada < v_hoy and new.fecha_programada is distinct from old.fecha_programada then
      raise exception 'La fecha programada no puede ser anterior a hoy';
    end if;
    perform fn_transporte_validar_asignacion(new);
  end if;

  if new.estado = old.estado then
    return new;
  end if;

  if (old.estado, new.estado) = ('planificado', 'cargado') then
    if not exists (select 1 from transporte_parada where transporte_id = old.id) then
      raise exception 'Agregue al menos una parada antes de cargar';
    end if;
    if exists (select 1 from transporte_parada p join documento_venta d on d.id = p.nota_entrega_id
                where p.transporte_id = old.id and d.salida_at is null) then
      raise exception 'Confirme la salida de mercancía de todas las notas antes de cargar';
    end if;
    select modalidad into v_modalidad from transportista where id = new.transportista_id;
    if v_modalidad <> 'encomienda' and (new.vehiculo_id is null or length(trim(coalesce(new.chofer, ''))) < 2) then
      raise exception 'Indique el vehículo y el chofer antes de cargar';
    end if;
    new.cargado_at := now();
  elsif (old.estado, new.estado) = ('planificado', 'anulado') then
    if length(trim(coalesce(new.anulado_motivo, ''))) < 3 then
      raise exception 'Indique el motivo de la anulación';
    end if;
    new.anulado_por := coalesce(fn_usuario_actual(), new.anulado_por);
    new.anulado_at := now();
  elsif (old.estado, new.estado) = ('cargado', 'en_ruta') then
    new.salida_at := now();
  elsif (old.estado, new.estado) = ('en_ruta', 'entregado') then
    if exists (select 1 from transporte_parada where transporte_id = old.id and resultado is null) then
      raise exception 'Quedan paradas sin resultado';
    end if;
  elsif (old.estado, new.estado) = ('entregado', 'cerrado') then
    new.cierre_at := now();
  else
    raise exception 'Un transporte % no pasa a %', old.estado, new.estado;
  end if;
  return new;
end $$;

create trigger transporte_antes
  before insert or update or delete on transporte
  for each row execute function fn_transporte_antes();

-- Al anular o cerrar, las paradas no entregadas quedan libres para otro transporte (R-BN).
create function fn_transporte_despues() returns trigger
language plpgsql as $$
begin
  if new.estado = 'anulado' then
    update transporte_parada set vigente = false where transporte_id = new.id and vigente;
  elsif new.estado = 'cerrado' then
    update transporte_parada set vigente = false
     where transporte_id = new.id and vigente and resultado is distinct from 'entregada';
  end if;
  return null;
end $$;

create trigger transporte_despues
  after update of estado on transporte
  for each row when (new.estado is distinct from old.estado)
  execute function fn_transporte_despues();

create function fn_transporte_parada_antes() returns trigger
language plpgsql as $$
declare
  t transporte%rowtype;
  n documento_venta%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into t from transporte where id = old.transporte_id;
    if t.estado <> 'planificado' then
      raise exception 'Solo se quitan paradas de un transporte planificado';
    end if;
    return old;
  end if;

  select * into t from transporte where id = new.transporte_id;

  if tg_op = 'INSERT' then
    if t.estado <> 'planificado' then
      raise exception 'Solo se agregan paradas a un transporte planificado';
    end if;
    select * into n from documento_venta where id = new.nota_entrega_id;
    if n.tipo is distinct from 'nota_entrega' or n.estado is distinct from 'emitido' then
      raise exception 'Solo se despacha una nota de entrega emitida';
    end if;
    if n.almacen_id <> t.almacen_id then
      raise exception 'La nota de entrega sale de otro almacén';
    end if;
    if (select usa_picking from almacen where id = n.almacen_id) and not exists (
         select 1 from orden_picking where nota_entrega_id = n.id and estado = 'completa' and empacada_at is not null) then
      raise exception 'El picking de la nota debe estar completo y empacado';
    end if;
    if exists (select 1 from transporte_parada where nota_entrega_id = new.nota_entrega_id and vigente) then
      raise exception 'La nota de entrega ya está en otro transporte';
    end if;
    if not exists (select 1 from cliente_direccion_entrega
                    where id = new.direccion_entrega_id and cliente_id = n.cliente_id and activa) then
      raise exception 'La dirección de entrega debe ser una dirección activa del cliente de la nota';
    end if;
    new.vigente := true;
    new.llegada_at := null; new.resultado := null; new.resultado_at := null; new.recibido_por := null; new.incidencia := null;
    return new;
  end if;

  if new.transporte_id <> old.transporte_id or new.nota_entrega_id <> old.nota_entrega_id then
    raise exception 'Una parada no cambia de transporte ni de nota';
  end if;

  if new.vigente is distinct from old.vigente then
    -- Solo la libera el cierre o la anulación del transporte.
    if old.vigente and not new.vigente and t.estado in ('cerrado', 'anulado')
       and (to_jsonb(new) - 'vigente') = (to_jsonb(old) - 'vigente') then
      return new;
    end if;
    raise exception 'La vigencia de una parada la define el cierre o la anulación del transporte';
  end if;

  if t.estado = 'planificado' then
    if (new.llegada_at, new.resultado, new.resultado_at, new.recibido_por, new.incidencia)
         is distinct from (old.llegada_at, old.resultado, old.resultado_at, old.recibido_por, old.incidencia) then
      raise exception 'El transporte aún no salió: no se registran llegadas ni resultados';
    end if;
    if new.direccion_entrega_id <> old.direccion_entrega_id then
      select * into n from documento_venta where id = new.nota_entrega_id;
      if not exists (select 1 from cliente_direccion_entrega
                      where id = new.direccion_entrega_id and cliente_id = n.cliente_id and activa) then
        raise exception 'La dirección de entrega debe ser una dirección activa del cliente de la nota';
      end if;
    end if;
    return new;
  end if;

  if t.estado = 'en_ruta' then
    if new.orden <> old.orden or new.direccion_entrega_id <> old.direccion_entrega_id then
      raise exception 'Con el transporte en ruta no se cambia el orden ni la dirección de las paradas';
    end if;
    if old.llegada_at is not null then
      new.llegada_at := old.llegada_at;
    elsif new.llegada_at is not null then
      new.llegada_at := now();
    end if;
    if old.resultado is not null then
      if (new.resultado, new.recibido_por, new.incidencia) is distinct from (old.resultado, old.recibido_por, old.incidencia) then
        raise exception 'El resultado de una parada no se modifica';
      end if;
      new.resultado_at := old.resultado_at;
    elsif new.resultado is not null then
      new.resultado_at := now();
      new.llegada_at := coalesce(new.llegada_at, now());
    else
      new.resultado_at := null;
    end if;
    return new;
  end if;

  raise exception 'Con el transporte % no se modifican sus paradas', t.estado;
end $$;

create trigger transporte_parada_antes
  before insert or update or delete on transporte_parada
  for each row execute function fn_transporte_parada_antes();

-- ---------------------------------------------------------------------
-- Indicadores (R-AM): calculados una sola vez, aquí
-- ---------------------------------------------------------------------
-- Peso y volumen de lo que lleva cada transporte, con las medidas del producto (§5.3).
create view vw_transporte_carga as
select t.id as transporte_id,
       coalesce(sum(l.cantidad * p.peso_kg), 0)::numeric(14,3) as peso_kg,
       coalesce(sum(l.cantidad * p.volumen_unitario_m3), 0)::numeric(14,4) as volumen_m3,
       count(*) filter (where p.peso_kg is null or p.volumen_unitario_m3 is null)::int as lineas_sin_medidas
  from transporte t
  join transporte_parada pa on pa.transporte_id = t.id
  join documento_venta_linea l on l.documento_id = pa.nota_entrega_id
  join producto p on p.id = l.producto_id and p.inventariable
 group by t.id;

create view vw_transporte_resumen as
select t.id as transporte_id, t.numero, t.estado, t.fecha_programada, t.salida_at, t.cierre_at, t.flete_usd,
       a.paradas, a.entregadas, a.no_entregadas, a.con_incidencia, a.con_ventana, a.en_ventana,
       ((t.salida_at at time zone 'America/Caracas')::date = t.fecha_programada) as salio_en_fecha,
       case when t.salida_at is not null and a.paradas > 0 and a.paradas = a.resueltas
            then extract(epoch from (a.ultimo_resultado - t.salida_at))::bigint end as transito_seg
  from transporte t
  cross join lateral (
    select count(*)::int as paradas,
           count(*) filter (where resultado = 'entregada')::int as entregadas,
           count(*) filter (where resultado = 'no_entregada')::int as no_entregadas,
           count(*) filter (where incidencia is not null)::int as con_incidencia,
           count(*) filter (where resultado is not null)::int as resueltas,
           max(resultado_at) as ultimo_resultado,
           count(*) filter (where llegada_at is not null and fn_en_ventana(direccion_entrega_id, llegada_at) is not null)::int as con_ventana,
           count(*) filter (where llegada_at is not null and fn_en_ventana(direccion_entrega_id, llegada_at))::int as en_ventana
      from transporte_parada where transporte_id = t.id) a
 where t.estado <> 'anulado';

-- ---------------------------------------------------------------------
-- Adjuntos: la constancia de entrega firmada de cada parada (§4.2, §6.4)
-- ---------------------------------------------------------------------
alter table adjunto drop constraint adjunto_entidad_tipo_check;
alter table adjunto add constraint adjunto_entidad_tipo_check
  check (entidad_tipo in ('cliente', 'proveedor', 'producto', 'transporte_parada'));

create or replace function fn_adjunto_reglas() returns trigger
language plpgsql as $$
declare v_existe boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un adjunto no se borra: se anula';
  end if;

  if tg_op = 'INSERT' then
    v_existe := case new.entidad_tipo
      when 'cliente'           then exists (select 1 from cliente where tercero_id = new.entidad_id)
      when 'proveedor'         then exists (select 1 from proveedor where tercero_id = new.entidad_id)
      when 'producto'          then exists (select 1 from producto where id = new.entidad_id)
      when 'transporte_parada' then exists (select 1 from transporte_parada where id = new.entidad_id)
    end;
    if not v_existe then
      raise exception 'El adjunto apunta a un % que no existe', new.entidad_tipo;
    end if;
    if new.anulado_at is not null then
      raise exception 'Un adjunto nace vigente';
    end if;
    return new;
  end if;

  -- UPDATE: solo la anulación, una vez.
  if old.anulado_at is not null then
    raise exception 'Un adjunto anulado no se modifica';
  end if;
  if new.entidad_tipo <> old.entidad_tipo or new.entidad_id <> old.entidad_id or new.nombre <> old.nombre
     or new.tipo_contenido <> old.tipo_contenido or new.tamano_bytes <> old.tamano_bytes
     or new.hash_sha256 <> old.hash_sha256 or new.descripcion is distinct from old.descripcion
     or new.subido_por <> old.subido_por or new.created_at <> old.created_at then
    raise exception 'Un adjunto no se edita: anúlelo y suba otro';
  end if;
  if new.anulado_por is null then
    raise exception 'Un adjunto solo cambia al anularse';
  end if;
  if new.anulado_por <> old.subido_por and not fn_tiene_rol(new.anulado_por, 'gerencia') then
    raise exception 'Solo quien subió el adjunto o Gerencia lo pueden anular';
  end if;
  new.anulado_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------
create trigger cliente_direccion_entrega_audit after insert or update or delete on cliente_direccion_entrega for each row execute function fn_audit();
create trigger cliente_direccion_ventana_audit after insert or update or delete on cliente_direccion_ventana for each row execute function fn_audit();
create trigger transportista_audit             after insert or update or delete on transportista             for each row execute function fn_audit();
create trigger vehiculo_audit                  after insert or update or delete on vehiculo                  for each row execute function fn_audit();
create trigger transportista_tarifa_audit      after insert or update or delete on transportista_tarifa      for each row execute function fn_audit();
create trigger transporte_audit                after insert or update or delete on transporte                for each row execute function fn_audit();
create trigger transporte_parada_audit         after insert or update or delete on transporte_parada         for each row execute function fn_audit();
