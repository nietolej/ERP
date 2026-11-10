-- =====================================================================
-- 0058 · CRM y postventa (módulo CR, §6.5, Fase 7)
--
--   R-CR1  Un prospecto es un tercero (RIF válido y único) sin ficha de cliente, asignado a un vendedor. Al
--          registrarse su ficha de cliente (alta con aprobación de Gerencia, §5.5) queda 'convertido'. Como no
--          tiene ficha de cliente, la base no admite pedirle ni facturarle (documento_venta.cliente_id → cliente).
--   R-CR2  La cotización es un documento propio, en USD, con vigencia, numerado al emitir sin huecos y que no se
--          edita una vez emitida. No reserva existencia ni pasa por crédito. Se cotiza a un cliente activo o a un
--          prospecto activo. Al ganar la oportunidad se copia a un pedido en borrador ('convertida').
--   R-CR3  Las etapas de una oportunidad avanzan una a una (prospecto → calificada → cotizada → negociacion →
--          ganada); 'cotizada' exige una cotización emitida del mismo tercero; 'perdida' se alcanza desde
--          cualquier etapa abierta y exige su motivo del catálogo. Una oportunidad cerrada no cambia, salvo
--          enlazar una sola vez el pedido que generó.
--   R-CR4  Las actividades son hechos: no se editan ni se borran.
--   R-CR5  Un caso de postventa avanza abierto → en_analisis → resuelto → cerrado (resuelto puede volver a
--          en_analisis). Un caso de devolución nace de una factura emitida del cliente, no mueve inventario y
--          solo se resuelve con su nota de crédito por devolución de esa factura ya emitida (§6.2).
--   R-CR6  Las probabilidades por etapa y los días sin contacto son parámetros editables (parametro_reporte).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Parámetros (R-CR6): editables en Configuración → Parámetros de reportes e inventario
-- ---------------------------------------------------------------------
insert into parametro_reporte (codigo, descripcion, valor, unidad) values
  ('CRM_SIN_CONTACTO_DIAS',      'CRM: un cliente activo sin actividades en estos días aparece en «Clientes sin contacto»', 30, 'dias'),
  ('CRM_PROB_PROSPECTO_PCT',     'CRM: probabilidad de cierre de una oportunidad en etapa Prospecto (valor ponderado del embudo)', 10, 'porcentaje'),
  ('CRM_PROB_CALIFICADA_PCT',    'CRM: probabilidad de cierre de una oportunidad en etapa Calificada', 25, 'porcentaje'),
  ('CRM_PROB_COTIZADA_PCT',      'CRM: probabilidad de cierre de una oportunidad en etapa Cotizada', 50, 'porcentaje'),
  ('CRM_PROB_NEGOCIACION_PCT',   'CRM: probabilidad de cierre de una oportunidad en etapa Negociación', 75, 'porcentaje');

insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('cotizacion', 'A', '', 1),
  ('caso_postventa', 'A', '', 1);

create function fn_hoy_caracas() returns date
language sql stable as $$ select (now() at time zone 'America/Caracas')::date $$;

-- ---------------------------------------------------------------------
-- Prospectos (R-CR1)
-- ---------------------------------------------------------------------
create table prospecto (
  tercero_id        uuid primary key references tercero(id),
  vendedor_id       uuid not null references vendedor(id),
  origen            text,                                   -- cómo llegó: referido, visita, feria…
  estado            text not null default 'activo' check (estado in ('activo', 'convertido', 'descartado')),
  descartado_motivo text,
  created_at        timestamptz not null default now(),
  created_by        uuid not null references usuario(id),
  check (estado <> 'descartado' or length(trim(coalesce(descartado_motivo, ''))) > 2)
);
create index prospecto_vendedor_idx on prospecto (vendedor_id, estado);

create function fn_prospecto_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from cliente where tercero_id = new.tercero_id) then
      raise exception 'Ese RIF ya es cliente: no se registra como prospecto';
    end if;
    if new.estado <> 'activo' then
      raise exception 'Un prospecto nace activo';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Un prospecto no se borra: se descarta con su motivo';
  end if;
  if new.tercero_id <> old.tercero_id or new.created_at <> old.created_at or new.created_by <> old.created_by then
    raise exception 'El tercero de un prospecto no cambia';
  end if;
  if old.estado = 'convertido' and (new.estado <> 'convertido' or new.vendedor_id <> old.vendedor_id) then
    raise exception 'Un prospecto convertido en cliente ya no cambia';
  end if;
  if new.estado = 'convertido' and old.estado <> 'convertido'
     and not exists (select 1 from cliente where tercero_id = new.tercero_id) then
    raise exception 'Un prospecto se convierte solo al registrarse su ficha de cliente';
  end if;
  if new.estado = 'activo' then
    new.descartado_motivo := null;
  end if;
  return new;
end $$;

create trigger prospecto_antes
  before insert or update or delete on prospecto
  for each row execute function fn_prospecto_antes();

-- Al registrarse la ficha de cliente, el prospecto queda convertido.
create function fn_cliente_convierte_prospecto() returns trigger
language plpgsql as $$
begin
  update prospecto set estado = 'convertido' where tercero_id = new.tercero_id and estado <> 'convertido';
  return null;
end $$;

create trigger cliente_convierte_prospecto
  after insert on cliente
  for each row execute function fn_cliente_convierte_prospecto();

-- ¿Se le puede ofrecer algo? Cliente activo o prospecto activo.
create function fn_tercero_comercial(p_tercero uuid) returns boolean
language sql stable as $$
  select exists (select 1 from cliente where tercero_id = p_tercero and estado = 'activo')
      or exists (select 1 from prospecto where tercero_id = p_tercero and estado = 'activo')
$$;

-- ---------------------------------------------------------------------
-- Contactos
-- ---------------------------------------------------------------------
create table contacto (
  id         uuid primary key default gen_random_uuid(),
  tercero_id uuid not null references tercero(id),
  nombre     text not null check (length(trim(nombre)) > 1),
  cargo      text,
  telefono   text,
  correo     text check (correo is null or correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  principal  boolean not null default false,
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references usuario(id),
  check (activo or not principal)
);
create index contacto_tercero_idx on contacto (tercero_id);
create unique index contacto_principal_unico on contacto (tercero_id) where principal;

create function fn_contacto_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un contacto no se borra: se inactiva';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
  elsif new.tercero_id <> old.tercero_id then
    raise exception 'El tercero de un contacto no cambia';
  end if;
  return new;
end $$;

create trigger contacto_antes
  before insert or update or delete on contacto
  for each row execute function fn_contacto_antes();

-- ---------------------------------------------------------------------
-- Cotización (R-CR2)
-- ---------------------------------------------------------------------
create table cotizacion (
  id              uuid primary key default gen_random_uuid(),
  serie           varchar(4) not null default 'A',
  numero          bigint,                                       -- lo asigna el numerador al emitir
  estado          text not null default 'borrador' check (estado in ('borrador', 'emitida', 'convertida', 'anulada')),
  tercero_id      uuid not null references tercero(id),
  vendedor_id     uuid not null references vendedor(id),
  sucursal_id     uuid not null references sucursal(id),
  almacen_id      uuid not null references almacen(id),
  lista_precio    char(1) not null references lista_precio(codigo),
  fecha_emision   timestamptz,
  vigente_hasta   date,
  moneda          char(3) not null default 'USD' references moneda(codigo) check (moneda = 'USD'),
  tasa            numeric(18,6) check (tasa > 0),               -- VES por USD, congelada al emitir
  subtotal        numeric(16,2) not null default 0,
  descuento       numeric(16,2) not null default 0,
  base_imponible  numeric(16,2) not null default 0,
  exento          numeric(16,2) not null default 0,
  iva             numeric(16,2) not null default 0,
  total           numeric(16,2) not null default 0,
  total_ves       numeric(18,2) not null default 0,
  observaciones   text,
  pedido_id       uuid references documento_venta(id),
  anulado_por     uuid references usuario(id),
  anulado_at      timestamptz,
  anulado_motivo  text,
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  unique (serie, numero),
  check ((estado = 'borrador') = (numero is null)),
  check (estado = 'borrador' or (tasa is not null and fecha_emision is not null and vigente_hasta is not null)),
  check (estado <> 'anulada' or length(trim(coalesce(anulado_motivo, ''))) > 2),
  check ((estado = 'convertida') = (pedido_id is not null))
);
create index cotizacion_tercero_idx on cotizacion (tercero_id, estado);
create index cotizacion_vendedor_idx on cotizacion (vendedor_id);

create table cotizacion_linea (
  id                  uuid primary key default gen_random_uuid(),
  cotizacion_id       uuid not null references cotizacion(id) on delete cascade,
  linea               int not null check (linea > 0),
  producto_id         uuid not null references producto(id),
  descripcion         text not null,
  cantidad            numeric(14,4) not null check (cantidad > 0),
  precio_lista        numeric(16,4) not null check (precio_lista >= 0),
  precio_unitario     numeric(16,4) not null check (precio_unitario >= 0),
  descuento_pct       numeric(5,2) not null default 0 check (descuento_pct between 0 and 100),
  motivo_descuento_id uuid references motivo(id),
  alicuota_iva_id     uuid not null references alicuota_iva(id),
  alicuota_pct        numeric(6,2) not null default 0,
  base                numeric(16,2) not null default 0,
  iva                 numeric(16,2) not null default 0,
  total               numeric(16,2) not null default 0,
  unique (cotizacion_id, linea),
  unique (cotizacion_id, producto_id),
  check ((descuento_pct = 0) or motivo_descuento_id is not null)
);

create function fn_cotizacion_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'pedido_id', 'anulado_por', 'anulado_at', 'anulado_motivo'];
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Una cotización nace en borrador';
    end if;
    if not fn_tercero_comercial(new.tercero_id) then
      raise exception 'Solo se cotiza a un cliente activo o a un prospecto activo';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Una cotización emitida no se borra: se anula con su motivo';
    end if;
    return old;
  end if;

  if new.tercero_id <> old.tercero_id then
    raise exception 'El cliente o prospecto de una cotización no cambia';
  end if;

  if old.estado = 'borrador' then
    if new.estado not in ('borrador', 'emitida') then
      raise exception 'Un borrador de cotización solo se emite o se elimina';
    end if;
    if new.estado = 'emitida' then
      if not exists (select 1 from cotizacion_linea where cotizacion_id = old.id) then
        raise exception 'No se puede emitir una cotización sin líneas';
      end if;
      if new.vigente_hasta is null or new.vigente_hasta < fn_hoy_caracas() then
        raise exception 'La vigencia de la cotización debe ser hoy o una fecha posterior';
      end if;
      if not fn_tercero_comercial(new.tercero_id) then
        raise exception 'Solo se cotiza a un cliente activo o a un prospecto activo';
      end if;
      new.numero := fn_siguiente_numero('cotizacion', new.serie);
      new.fecha_emision := now();
    end if;
    return new;
  end if;

  if old.estado in ('convertida', 'anulada') then
    raise exception 'Una cotización % no se modifica', old.estado;
  end if;

  -- Emitida: solo pasa a convertida (con su pedido) o a anulada.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Una cotización emitida no se edita: se anula y se hace otra';
  end if;
  if new.estado = 'borrador' then
    raise exception 'Una cotización emitida no vuelve a borrador';
  end if;
  if new.estado = 'convertida' then
    if not exists (select 1 from documento_venta d join cotizacion c on c.id = new.id
                    where d.id = new.pedido_id and d.tipo = 'pedido' and d.cliente_id = c.tercero_id) then
      raise exception 'Una cotización se convierte en un pedido del mismo cliente';
    end if;
  end if;
  if new.estado = 'anulada' then
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := coalesce(new.anulado_at, now());
  end if;
  return new;
end $$;

create trigger cotizacion_antes
  before insert or update or delete on cotizacion
  for each row execute function fn_cotizacion_antes();

create function fn_cotizacion_linea_antes() returns trigger
language plpgsql as $$
declare
  v_estado text;
begin
  select estado into v_estado from cotizacion where id = coalesce(new.cotizacion_id, old.cotizacion_id);
  if v_estado is not null and v_estado <> 'borrador' then
    raise exception 'Las líneas de una cotización emitida no se modifican';
  end if;
  if tg_op <> 'DELETE' and new.motivo_descuento_id is not null then
    perform fn_motivo_valido(new.motivo_descuento_id, 'descuento');
  end if;
  return coalesce(new, old);
end $$;

create trigger cotizacion_linea_antes
  before insert or update or delete on cotizacion_linea
  for each row execute function fn_cotizacion_linea_antes();

-- Base, IVA y totales: la misma aritmética que fn_venta_calcular (§6.1), redondeo a centavos por línea.
create function fn_cotizacion_calcular(p_cotizacion uuid) returns void
language plpgsql as $$
declare
  v_estado text;
  v_hoy    date := fn_hoy_caracas();
  v_tasa   numeric;
begin
  select estado into v_estado from cotizacion where id = p_cotizacion for update;
  if not found then
    raise exception 'La cotización no existe';
  end if;
  if v_estado <> 'borrador' then
    raise exception 'Solo se calculan las cotizaciones en borrador';
  end if;

  update cotizacion_linea l set alicuota_pct = fn_alicuota_iva_pct(l.alicuota_iva_id, v_hoy)
   where l.cotizacion_id = p_cotizacion;
  update cotizacion_linea l set
    base = round(l.cantidad * l.precio_unitario, 2) - round(l.cantidad * l.precio_unitario * l.descuento_pct / 100, 2),
    iva  = round((round(l.cantidad * l.precio_unitario, 2) - round(l.cantidad * l.precio_unitario * l.descuento_pct / 100, 2))
                 * l.alicuota_pct / 100, 2)
   where l.cotizacion_id = p_cotizacion;
  update cotizacion_linea set total = base + iva where cotizacion_id = p_cotizacion;

  v_tasa := fn_tasa('USD', v_hoy);

  update cotizacion c set
    subtotal       = coalesce(s.subtotal, 0),
    descuento      = coalesce(s.descuento, 0),
    base_imponible = coalesce(s.gravado, 0),
    exento         = coalesce(s.exento, 0),
    iva            = coalesce(s.iva, 0),
    total          = coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0),
    total_ves      = round((coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)) * v_tasa, 2),
    tasa           = v_tasa
    from (select sum(round(l.cantidad * l.precio_unitario, 2)) as subtotal,
                 sum(round(l.cantidad * l.precio_unitario * l.descuento_pct / 100, 2)) as descuento,
                 sum(case when l.alicuota_pct > 0 then l.base else 0 end) as gravado,
                 sum(case when l.alicuota_pct = 0 then l.base else 0 end) as exento,
                 sum(l.iva) as iva
            from cotizacion_linea l where l.cotizacion_id = p_cotizacion) s
   where c.id = p_cotizacion;
end $$;

-- ---------------------------------------------------------------------
-- Oportunidades (R-CR3)
-- ---------------------------------------------------------------------
create table oportunidad (
  id                 uuid primary key default gen_random_uuid(),
  titulo             text not null check (length(trim(titulo)) > 2),
  tercero_id         uuid not null references tercero(id),         -- prospecto o cliente
  vendedor_id        uuid not null references vendedor(id),
  etapa              text not null default 'prospecto'
                     check (etapa in ('prospecto', 'calificada', 'cotizada', 'negociacion', 'ganada', 'perdida')),
  monto_estimado_usd numeric(14,2) not null default 0 check (monto_estimado_usd >= 0),
  cierre_estimado    date,
  motivo_perdida_id  uuid references motivo(id),
  motivo_perdida     text,                                         -- detalle del motivo
  cotizacion_id      uuid references cotizacion(id),               -- se enlaza al cotizar
  pedido_id          uuid references documento_venta(id),          -- el pedido que generó al ganarse
  etapa_at           timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  created_by         uuid not null references usuario(id),
  cerrada_at         timestamptz,
  check (etapa <> 'perdida' or motivo_perdida_id is not null),
  check ((etapa in ('ganada', 'perdida')) = (cerrada_at is not null)),
  check (etapa not in ('cotizada', 'negociacion', 'ganada') or cotizacion_id is not null),
  check (pedido_id is null or etapa = 'ganada')
);
create index oportunidad_vendedor_idx on oportunidad (vendedor_id, etapa);
create index oportunidad_tercero_idx on oportunidad (tercero_id);

create function fn_oportunidad_antes() returns trigger
language plpgsql as $$
declare
  v_etapas text[] := array['prospecto', 'calificada', 'cotizada', 'negociacion', 'ganada'];
  v_cot    cotizacion%rowtype;
  v_motivo motivo%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.etapa <> 'prospecto' then
      raise exception 'Una oportunidad nace en la etapa Prospecto';
    end if;
    if not fn_tercero_comercial(new.tercero_id) then
      raise exception 'Una oportunidad es de un cliente activo o de un prospecto activo';
    end if;
    if new.cotizacion_id is not null or new.pedido_id is not null or new.cerrada_at is not null then
      raise exception 'Una oportunidad nueva no tiene cotización, pedido ni cierre';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Una oportunidad no se borra: se cierra como perdida con su motivo';
  end if;

  if new.tercero_id <> old.tercero_id or new.created_at <> old.created_at or new.created_by <> old.created_by then
    raise exception 'El cliente o prospecto de una oportunidad no cambia';
  end if;

  -- Cerrada: solo se enlaza, una vez, el pedido de una oportunidad ganada.
  if old.etapa in ('ganada', 'perdida') then
    if (to_jsonb(new) - 'pedido_id') is distinct from (to_jsonb(old) - 'pedido_id')
       or (old.pedido_id is not null and new.pedido_id is distinct from old.pedido_id) then
      raise exception 'Una oportunidad cerrada no se modifica';
    end if;
    if new.pedido_id is not null and old.pedido_id is null then
      if not exists (select 1 from documento_venta where id = new.pedido_id and tipo = 'pedido' and cliente_id = new.tercero_id) then
        raise exception 'El pedido de la oportunidad debe ser un pedido del mismo cliente';
      end if;
    end if;
    return new;
  end if;

  if new.pedido_id is not null then
    raise exception 'Solo una oportunidad ganada genera su pedido';
  end if;

  -- Cotización enlazada: emitida, del mismo tercero.
  if new.cotizacion_id is distinct from old.cotizacion_id then
    if new.cotizacion_id is null then
      raise exception 'La cotización de una oportunidad no se quita: se enlaza otra';
    end if;
    select * into v_cot from cotizacion where id = new.cotizacion_id;
    if not found then
      raise exception 'La cotización no existe';
    end if;
    if v_cot.tercero_id <> new.tercero_id then
      raise exception 'La cotización debe ser del mismo cliente o prospecto de la oportunidad';
    end if;
    if v_cot.estado <> 'emitida' then
      raise exception 'Solo se enlaza una cotización emitida';
    end if;
    if new.etapa not in ('cotizada', 'negociacion') then
      raise exception 'La cotización se enlaza al pasar a la etapa Cotizada';
    end if;
  end if;

  if new.etapa <> old.etapa then
    if new.etapa = 'perdida' then
      if new.motivo_perdida_id is null then
        raise exception 'Indique el motivo por el que se perdió la oportunidad';
      end if;
      perform fn_motivo_valido(new.motivo_perdida_id, 'venta_perdida');
      select * into v_motivo from motivo where id = new.motivo_perdida_id;
      if v_motivo.codigo = 'OTRO' and length(trim(coalesce(new.motivo_perdida, ''))) < 3 then
        raise exception 'Explique el motivo por el que se perdió la oportunidad';
      end if;
      new.cerrada_at := now();
    else
      if array_position(v_etapas, new.etapa) <> array_position(v_etapas, old.etapa) + 1 then
        raise exception 'Las etapas avanzan una a una: de % solo se pasa a %', old.etapa, v_etapas[array_position(v_etapas, old.etapa) + 1];
      end if;
      if new.etapa = 'ganada' then
        select * into v_cot from cotizacion where id = new.cotizacion_id;
        if v_cot.estado <> 'emitida' then
          raise exception 'Para ganar la oportunidad su cotización debe estar emitida (no anulada ni ya convertida)';
        end if;
        if v_cot.vigente_hasta < fn_hoy_caracas() then
          raise exception 'La cotización venció el %: emita una nueva antes de ganar la oportunidad', to_char(v_cot.vigente_hasta, 'DD-MM-YYYY');
        end if;
        new.cerrada_at := now();
      end if;
    end if;
    new.etapa_at := now();
  elsif new.motivo_perdida_id is distinct from old.motivo_perdida_id or new.cerrada_at is distinct from old.cerrada_at then
    raise exception 'El motivo de pérdida y el cierre se registran al cerrar la oportunidad';
  end if;
  return new;
end $$;

create trigger oportunidad_antes
  before insert or update or delete on oportunidad
  for each row execute function fn_oportunidad_antes();

-- ---------------------------------------------------------------------
-- Actividades (R-CR4)
-- ---------------------------------------------------------------------
create table actividad_crm (
  id             uuid primary key default gen_random_uuid(),
  tercero_id     uuid not null references tercero(id),
  oportunidad_id uuid references oportunidad(id),
  tipo           text not null check (tipo in ('visita', 'llamada', 'mensaje', 'correo', 'tarea')),
  usuario_id     uuid not null references usuario(id),
  fecha          timestamptz not null,
  resultado      text,
  proxima_accion text,
  proxima_fecha  date,
  created_at     timestamptz not null default now(),
  check (length(trim(coalesce(resultado, ''))) > 2 or length(trim(coalesce(proxima_accion, ''))) > 2),
  check ((proxima_fecha is null) or length(trim(coalesce(proxima_accion, ''))) > 2)
);
create index actividad_crm_tercero_idx on actividad_crm (tercero_id, fecha desc);
create index actividad_crm_usuario_idx on actividad_crm (usuario_id, fecha);

create function fn_actividad_crm_antes() returns trigger
language plpgsql as $$
begin
  if new.oportunidad_id is not null
     and not exists (select 1 from oportunidad where id = new.oportunidad_id and tercero_id = new.tercero_id) then
    raise exception 'La oportunidad de la actividad debe ser del mismo cliente o prospecto';
  end if;
  if not exists (select 1 from cliente where tercero_id = new.tercero_id)
     and not exists (select 1 from prospecto where tercero_id = new.tercero_id) then
    raise exception 'Las actividades se registran a un cliente o a un prospecto';
  end if;
  if new.fecha > now() + interval '1 day' then
    raise exception 'Una actividad se registra cuando ocurrió: para planificarla use la próxima acción';
  end if;
  return new;
end $$;

create trigger actividad_crm_antes
  before insert on actividad_crm
  for each row execute function fn_actividad_crm_antes();

create trigger actividad_crm_inmutable
  before update or delete on actividad_crm
  for each row execute function fn_inmutable();

-- ---------------------------------------------------------------------
-- Casos de postventa (R-CR5)
-- ---------------------------------------------------------------------
create table caso_postventa (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint not null unique,
  tercero_id         uuid not null references cliente(tercero_id),
  documento_venta_id uuid references documento_venta(id),          -- factura a la que se refiere
  tipo               text not null check (tipo in ('reclamo', 'garantia', 'devolucion', 'consulta')),
  estado             text not null default 'abierto' check (estado in ('abierto', 'en_analisis', 'resuelto', 'cerrado')),
  responsable_id     uuid references usuario(id),
  descripcion        text not null check (length(trim(descripcion)) > 4),
  causa              text,
  solucion           text,
  nota_credito_id    uuid references documento_venta(id),          -- devolución: su NC por devolución
  abierto_at         timestamptz not null default now(),
  resuelto_at        timestamptz,
  cerrado_at         timestamptz,
  created_by         uuid not null references usuario(id),
  check (tipo <> 'devolucion' or documento_venta_id is not null),
  check (nota_credito_id is null or tipo = 'devolucion'),
  check ((estado in ('resuelto', 'cerrado')) = (resuelto_at is not null)),
  check ((estado = 'cerrado') = (cerrado_at is not null)),
  check (estado not in ('resuelto', 'cerrado') or length(trim(coalesce(solucion, ''))) > 2)
);
create index caso_postventa_tercero_idx on caso_postventa (tercero_id);
create index caso_postventa_estado_idx on caso_postventa (estado);

create function fn_caso_postventa_antes() returns trigger
language plpgsql as $$
declare
  v_sig text[];
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'abierto' then
      raise exception 'Un caso nace abierto';
    end if;
    if new.documento_venta_id is not null
       and not exists (select 1 from documento_venta where id = new.documento_venta_id and tipo = 'factura'
                          and estado = 'emitido' and cliente_id = new.tercero_id) then
      raise exception 'El caso se refiere a una factura emitida del mismo cliente';
    end if;
    if new.nota_credito_id is not null then
      raise exception 'La nota de crédito se enlaza después de abrir el caso';
    end if;
    new.numero := fn_siguiente_numero('caso_postventa', 'A');
    new.abierto_at := now();
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Un caso de postventa no se borra: se cierra';
  end if;

  if new.numero <> old.numero or new.tercero_id <> old.tercero_id or new.tipo <> old.tipo
     or new.documento_venta_id is distinct from old.documento_venta_id or new.descripcion <> old.descripcion
     or new.abierto_at <> old.abierto_at or new.created_by <> old.created_by then
    raise exception 'El cliente, el tipo, la factura y la descripción de un caso no cambian';
  end if;
  if old.estado = 'cerrado' then
    raise exception 'Un caso cerrado no se modifica';
  end if;

  if new.nota_credito_id is distinct from old.nota_credito_id then
    if old.nota_credito_id is not null
       and exists (select 1 from documento_venta where id = old.nota_credito_id and estado <> 'anulado') then
      raise exception 'El caso ya tiene su nota de crédito';
    end if;
    if new.nota_credito_id is null
       or not exists (select 1 from documento_venta where id = new.nota_credito_id and tipo = 'nota_credito'
                         and motivo_nc = 'devolucion' and documento_origen_id = new.documento_venta_id and estado <> 'anulado') then
      raise exception 'Enlace una nota de crédito por devolución de la factura del caso';
    end if;
  end if;

  if new.estado <> old.estado then
    v_sig := case old.estado
               when 'abierto'     then array['en_analisis', 'resuelto']
               when 'en_analisis' then array['resuelto']
               when 'resuelto'    then array['en_analisis', 'cerrado']
             end;
    if not new.estado = any(v_sig) then
      raise exception 'Un caso % no pasa a %', old.estado, new.estado;
    end if;
    if new.estado = 'resuelto' then
      if new.tipo = 'devolucion' and not exists (
           select 1 from documento_venta where id = new.nota_credito_id and estado = 'emitido') then
        raise exception 'Un caso de devolución se resuelve con su nota de crédito por devolución emitida';
      end if;
      new.resuelto_at := now();
    elsif new.estado = 'en_analisis' then
      new.resuelto_at := null;
    elsif new.estado = 'cerrado' then
      new.cerrado_at := now();
    end if;
  elsif new.resuelto_at is distinct from old.resuelto_at or new.cerrado_at is distinct from old.cerrado_at then
    raise exception 'Las fechas de resolución y cierre las fija el sistema';
  end if;
  return new;
end $$;

create trigger caso_postventa_antes
  before insert or update or delete on caso_postventa
  for each row execute function fn_caso_postventa_antes();

-- ---------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------
create trigger prospecto_audit        after insert or update on prospecto        for each row execute function fn_audit();
create trigger contacto_audit         after insert or update on contacto         for each row execute function fn_audit();
create trigger cotizacion_audit       after insert or update or delete on cotizacion for each row execute function fn_audit();
create trigger oportunidad_audit      after insert or update on oportunidad      for each row execute function fn_audit();
create trigger actividad_crm_audit    after insert on actividad_crm              for each row execute function fn_audit();
create trigger caso_postventa_audit   after insert or update on caso_postventa   for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Indicadores (§6.5 regla 6): se calculan aquí, una sola vez
-- ---------------------------------------------------------------------

-- Probabilidad de cierre de cada etapa abierta (parámetro editable).
create function fn_crm_probabilidad(p_etapa text) returns numeric
language sql stable as $$
  select case when p_etapa in ('ganada', 'perdida') then null
              else fn_parametro_reporte('CRM_PROB_' || upper(p_etapa) || '_PCT') end
$$;

-- Embudo: oportunidades abiertas por vendedor y etapa, con su valor ponderado por la probabilidad de la etapa.
create view vw_crm_embudo as
select o.vendedor_id, o.etapa,
       array_position(array['prospecto', 'calificada', 'cotizada', 'negociacion'], o.etapa) as orden,
       count(*)::int as oportunidades,
       sum(o.monto_estimado_usd) as monto_usd,
       fn_crm_probabilidad(o.etapa) as probabilidad_pct,
       round(sum(o.monto_estimado_usd) * fn_crm_probabilidad(o.etapa) / 100, 2) as ponderado_usd
  from oportunidad o
 where o.etapa not in ('ganada', 'perdida')
 group by o.vendedor_id, o.etapa;

-- Conversión: oportunidades cerradas entre dos fechas (fecha de cierre en Caracas), por vendedor.
-- Tasa = ganadas ÷ cerradas; ciclo = días promedio desde la creación hasta el cierre de las ganadas.
create function fn_crm_conversion(p_desde date, p_hasta date)
returns table (vendedor_id uuid, ganadas int, perdidas int, tasa_pct numeric, monto_ganado_usd numeric, ciclo_dias numeric)
language sql stable as $$
  select o.vendedor_id,
         count(*) filter (where o.etapa = 'ganada')::int,
         count(*) filter (where o.etapa = 'perdida')::int,
         round(100.0 * count(*) filter (where o.etapa = 'ganada') / count(*), 2),
         coalesce(sum(o.monto_estimado_usd) filter (where o.etapa = 'ganada'), 0),
         round(avg(extract(epoch from o.cerrada_at - o.created_at) / 86400) filter (where o.etapa = 'ganada'), 1)
    from oportunidad o
   where o.cerrada_at is not null
     and (o.cerrada_at at time zone 'America/Caracas')::date between p_desde and p_hasta
   group by o.vendedor_id
$$;

-- Actividades por usuario y tipo entre dos fechas (fecha de la actividad en Caracas).
create function fn_crm_actividades(p_desde date, p_hasta date)
returns table (usuario_id uuid, vendedor_id uuid, visitas int, llamadas int, mensajes int, correos int, tareas int, total int)
language sql stable as $$
  select a.usuario_id, v.id,
         count(*) filter (where a.tipo = 'visita')::int,
         count(*) filter (where a.tipo = 'llamada')::int,
         count(*) filter (where a.tipo = 'mensaje')::int,
         count(*) filter (where a.tipo = 'correo')::int,
         count(*) filter (where a.tipo = 'tarea')::int,
         count(*)::int
    from actividad_crm a
    left join vendedor v on v.usuario_id = a.usuario_id
   where (a.fecha at time zone 'America/Caracas')::date between p_desde and p_hasta
   group by a.usuario_id, v.id
$$;

-- Último contacto de cada cliente activo. Sin actividades cuenta desde su aprobación.
create view vw_crm_ultimo_contacto as
select c.tercero_id as cliente_id, c.vendedor_id,
       u.ultima as ultima_actividad,
       fn_hoy_caracas() - coalesce((u.ultima at time zone 'America/Caracas')::date,
                                    (c.aprobado_at at time zone 'America/Caracas')::date) as dias_sin_contacto
  from cliente c
  left join lateral (select max(a.fecha) as ultima from actividad_crm a where a.tercero_id = c.tercero_id) u on true
 where c.estado = 'activo';

-- Clientes activos sin contacto en los días del parámetro CRM_SIN_CONTACTO_DIAS.
create view vw_crm_clientes_sin_contacto as
select * from vw_crm_ultimo_contacto
 where dias_sin_contacto >= fn_parametro_reporte('CRM_SIN_CONTACTO_DIAS');

-- Casos: resueltos entre dos fechas (fecha de resolución en Caracas) por tipo, con su tiempo promedio de resolución,
-- y los que siguen pendientes hoy (abiertos o en análisis), sin importar las fechas.
create function fn_crm_casos(p_desde date, p_hasta date)
returns table (tipo text, resueltos int, dias_resolucion numeric, pendientes int)
language sql stable as $$
  select t.tipo,
         (select count(*)::int from caso_postventa c where c.tipo = t.tipo and c.resuelto_at is not null
            and (c.resuelto_at at time zone 'America/Caracas')::date between p_desde and p_hasta),
         (select round(avg(extract(epoch from c.resuelto_at - c.abierto_at) / 86400), 1) from caso_postventa c
           where c.tipo = t.tipo and c.resuelto_at is not null
             and (c.resuelto_at at time zone 'America/Caracas')::date between p_desde and p_hasta),
         (select count(*)::int from caso_postventa c where c.tipo = t.tipo and c.estado in ('abierto', 'en_analisis'))
    from unnest(array['reclamo', 'garantia', 'devolucion', 'consulta']) as t(tipo)
$$;
