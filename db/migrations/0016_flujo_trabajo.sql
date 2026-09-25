-- =====================================================================
-- 0016 · Flujo de trabajo y aprobaciones (§4.5)
--
--   R-AB  Un motor único decide QUIÉN aprueba cada objeto. Los pasos, los roles y los umbrales
--         viven en tablas (flujo_definicion y flujo_paso), no en el código.
--   R-AC  Al crear una solicitud se guarda una COPIA de los pasos que aplican (`pasos`): cambiar
--         la definición después no altera las solicitudes en curso.
--   R-AD  Cada decisión la valida la base de datos con fn_flujo_puede_decidir: el usuario tiene el
--         rol del paso (o el de escalamiento si venció el plazo, o es sustituto de quien lo tiene),
--         no es quien solicitó (si el paso lo exige) y no decidió antes en la misma solicitud.
--   R-AE  Un flujo conserva siempre al menos un paso sin condición: así ningún objeto puede quedar
--         sin aprobador aunque se cambien los umbrales. Una definición no se borra: se inactiva.
--   R-AF  Los triggers de cada módulo (aprobación de clientes, asientos, etc.) siguen como última barrera.
--
-- Las aprobaciones que ya existían (clientes, proveedores, cambios de proveedor, asientos manuales
-- y lotes de metas) pasan a este motor con los mismos roles; sus reglas no cambian.
-- =====================================================================

create table flujo_definicion (
  id          uuid primary key default gen_random_uuid(),
  objeto_tipo text not null unique check (objeto_tipo ~ '^[a-z_]+$'),
  nombre      text not null check (length(trim(nombre)) > 1),
  activo      boolean not null default true
);

create table flujo_paso (
  id                   uuid primary key default gen_random_uuid(),
  definicion_id        uuid not null references flujo_definicion(id),
  orden                smallint not null check (orden > 0),
  condicion_campo      text check (condicion_campo is null or condicion_campo ~ '^[a-z_]+$'),
  condicion_operador   text check (condicion_operador in ('>', '>=', '<', '<=', '=')),
  condicion_valor      numeric(16,2),
  rol_aprobador        text not null references rol(codigo),
  distinto_del_creador boolean not null default true,
  horas_para_escalar   integer check (horas_para_escalar > 0),
  escalar_a_rol        text references rol(codigo),
  unique (definicion_id, orden),
  check ((condicion_campo is null) = (condicion_operador is null) and (condicion_campo is null) = (condicion_valor is null)),
  check ((horas_para_escalar is null) = (escalar_a_rol is null)),
  check (escalar_a_rol is null or escalar_a_rol <> rol_aprobador)
);

create table solicitud_aprobacion (
  id            uuid primary key default gen_random_uuid(),
  objeto_tipo   text not null references flujo_definicion(objeto_tipo),
  objeto_id     uuid not null,
  estado        text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  contexto      jsonb not null default '{}'::jsonb check (jsonb_typeof(contexto) = 'object'),
  pasos         jsonb not null check (jsonb_typeof(pasos) = 'array' and jsonb_array_length(pasos) > 0),
  paso_actual   smallint not null default 1 check (paso_actual > 0),
  solicitante_id uuid not null references usuario(id),
  created_at    timestamptz not null default now(),
  paso_desde    timestamptz not null default now(),
  resuelta_at   timestamptz,
  check (paso_actual <= jsonb_array_length(pasos)),
  check ((estado = 'pendiente') = (resuelta_at is null))
);
create unique index solicitud_pendiente_unica on solicitud_aprobacion (objeto_tipo, objeto_id) where estado = 'pendiente';
create index solicitud_objeto_idx on solicitud_aprobacion (objeto_tipo, objeto_id);
create index solicitud_estado_idx on solicitud_aprobacion (estado, created_at);

create table aprobacion_decision (
  id           bigint generated always as identity primary key,
  solicitud_id uuid not null references solicitud_aprobacion(id),
  paso         smallint not null,
  usuario_id   uuid not null references usuario(id),
  en_nombre_de uuid references usuario(id),              -- quien delegó, si decidió un sustituto
  decision     text not null check (decision in ('aprobada', 'rechazada')),
  comentario   text,
  datos        jsonb check (datos is null or jsonb_typeof(datos) = 'object'),
  created_at   timestamptz not null default now(),
  check (decision <> 'rechazada' or length(trim(coalesce(comentario, ''))) > 2)
);
create index aprobacion_decision_solicitud_idx on aprobacion_decision (solicitud_id);

create table delegacion_aprobacion (
  id         uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuario(id),
  sustituto_id uuid not null references usuario(id),
  desde      date not null,
  hasta      date not null,
  created_at timestamptz not null default now(),
  check (hasta >= desde),
  check (usuario_id <> sustituto_id)
);
create index delegacion_sustituto_idx on delegacion_aprobacion (sustituto_id, desde, hasta);

-- ---------------------------------------------------------------------
-- Reglas de la definición (R-AE)
-- ---------------------------------------------------------------------
create function fn_flujo_definicion_no_borrar() returns trigger
language plpgsql as $$
begin
  raise exception 'Un flujo de aprobación no se borra: se inactiva';
end $$;

create trigger flujo_definicion_no_borrar
  before delete on flujo_definicion
  for each row execute function fn_flujo_definicion_no_borrar();

create function fn_flujo_paso_incondicional() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from flujo_paso where definicion_id = old.definicion_id and condicion_campo is null) then
    raise exception 'Un flujo debe conservar al menos un paso sin condición: sin él, un documento podría quedar sin aprobador';
  end if;
  return null;
end $$;

create trigger flujo_paso_incondicional
  after delete or update on flujo_paso
  for each row execute function fn_flujo_paso_incondicional();

-- ---------------------------------------------------------------------
-- Crear una solicitud: copia los pasos que aplican al contexto (R-AC)
-- ---------------------------------------------------------------------
create function fn_flujo_condicion(p_valor text, p_operador text, p_umbral numeric) returns boolean
language sql immutable as $$
  -- Si el dato no viene en el contexto, el paso aplica: ante la duda, se exige la aprobación.
  select case
    when p_valor is null then true
    else case p_operador
      when '>'  then p_valor::numeric >  p_umbral
      when '>=' then p_valor::numeric >= p_umbral
      when '<'  then p_valor::numeric <  p_umbral
      when '<=' then p_valor::numeric <= p_umbral
      when '='  then p_valor::numeric =  p_umbral
    end
  end
$$;

create function fn_flujo_solicitar(p_tipo text, p_objeto uuid, p_solicitante uuid, p_contexto jsonb default '{}'::jsonb)
returns uuid
language plpgsql as $$
declare
  v_def   flujo_definicion%rowtype;
  v_pasos jsonb;
  v_id    uuid;
begin
  select * into v_def from flujo_definicion where objeto_tipo = p_tipo;
  if not found then
    raise exception 'No hay un flujo de aprobación definido para %', p_tipo;
  end if;
  if not v_def.activo then
    raise exception 'El flujo de aprobación de % está inactivo', p_tipo;
  end if;

  select id into v_id from solicitud_aprobacion where objeto_tipo = p_tipo and objeto_id = p_objeto and estado = 'pendiente';
  if found then
    return v_id;                                   -- idempotente: ya hay una solicitud abierta
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'orden', p.orden, 'rol', p.rol_aprobador, 'distinto', p.distinto_del_creador,
           'horas', p.horas_para_escalar, 'escalar_a', p.escalar_a_rol) order by p.orden), '[]'::jsonb)
    into v_pasos
    from flujo_paso p
   where p.definicion_id = v_def.id
     and (p.condicion_campo is null
          or fn_flujo_condicion(p_contexto ->> p.condicion_campo, p.condicion_operador, p.condicion_valor));

  insert into solicitud_aprobacion (objeto_tipo, objeto_id, contexto, pasos, solicitante_id)
  values (p_tipo, p_objeto, p_contexto, v_pasos, p_solicitante)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- ¿Puede este usuario decidir el paso actual? Única fuente de la regla (R-AD):
-- la usan el trigger de decisiones y la bandeja.
-- ---------------------------------------------------------------------
create function fn_flujo_puede_decidir(p_usuario uuid, p_solicitud uuid) returns boolean
language plpgsql stable as $$
declare
  s          solicitud_aprobacion%rowtype;
  v          jsonb;
  v_rol      text;
  v_escalar  text;
  v_horas    int;
  v_distinto boolean;
  v_vencido  boolean;
  v_hoy      date := (now() at time zone 'America/Caracas')::date;
begin
  select * into s from solicitud_aprobacion where id = p_solicitud;
  if not found or s.estado <> 'pendiente' then return false; end if;
  if not exists (select 1 from usuario where id = p_usuario and activo) then return false; end if;
  -- Un mismo usuario no decide dos pasos de la misma solicitud.
  if exists (select 1 from aprobacion_decision where solicitud_id = s.id and usuario_id = p_usuario) then return false; end if;

  v := s.pasos -> (s.paso_actual - 1);
  v_rol := v ->> 'rol';
  v_escalar := v ->> 'escalar_a';
  v_horas := (v ->> 'horas')::int;
  v_distinto := coalesce((v ->> 'distinto')::boolean, true);
  v_vencido := v_horas is not null and now() >= s.paso_desde + make_interval(hours => v_horas);

  if fn_tiene_rol(p_usuario, v_rol) or (v_vencido and v_escalar is not null and fn_tiene_rol(p_usuario, v_escalar)) then
    return not (v_distinto and p_usuario = s.solicitante_id);
  end if;

  -- Sustituto de alguien que tiene el rol, dentro de la vigencia de la delegación.
  return exists (
    select 1 from delegacion_aprobacion g
     where g.sustituto_id = p_usuario and v_hoy between g.desde and g.hasta
       and (fn_tiene_rol(g.usuario_id, v_rol) or (v_vencido and v_escalar is not null and fn_tiene_rol(g.usuario_id, v_escalar)))
       and not (v_distinto and (p_usuario = s.solicitante_id or g.usuario_id = s.solicitante_id)));
end $$;

-- ---------------------------------------------------------------------
-- Decisiones: validación antes de guardar, avance de la solicitud después
-- ---------------------------------------------------------------------
create function fn_aprobacion_decision_validar() returns trigger
language plpgsql as $$
declare
  s        solicitud_aprobacion%rowtype;
  v_rol    text;
  v_hoy    date := (now() at time zone 'America/Caracas')::date;
  v_deleg  uuid;
begin
  select * into s from solicitud_aprobacion where id = new.solicitud_id for update;
  if s.estado <> 'pendiente' then
    raise exception 'La solicitud ya fue resuelta';
  end if;
  if new.paso <> s.paso_actual then
    raise exception 'La decisión no corresponde al paso actual de la solicitud';
  end if;
  if (s.pasos -> (s.paso_actual - 1) ->> 'distinto')::boolean is not false and new.usuario_id = s.solicitante_id then
    raise exception 'Quien solicita no aprueba su propia solicitud';
  end if;
  if not fn_flujo_puede_decidir(new.usuario_id, s.id) then
    raise exception 'No puede decidir esta solicitud: no tiene el rol que exige el paso, ya decidió antes o no es sustituto vigente';
  end if;

  -- Si decide como sustituto, queda registrado a nombre de quién.
  v_rol := s.pasos -> (s.paso_actual - 1) ->> 'rol';
  if not fn_tiene_rol(new.usuario_id, v_rol)
     and not coalesce((select fn_tiene_rol(new.usuario_id, s.pasos -> (s.paso_actual - 1) ->> 'escalar_a')), false) then
    select g.usuario_id into v_deleg from delegacion_aprobacion g
     where g.sustituto_id = new.usuario_id and v_hoy between g.desde and g.hasta
       and fn_tiene_rol(g.usuario_id, v_rol)
     order by g.created_at desc limit 1;
    new.en_nombre_de := v_deleg;
  end if;
  return new;
end $$;

create trigger aprobacion_decision_validar
  before insert on aprobacion_decision
  for each row execute function fn_aprobacion_decision_validar();

create function fn_aprobacion_decision_aplicar() returns trigger
language plpgsql as $$
declare
  s solicitud_aprobacion%rowtype;
begin
  select * into s from solicitud_aprobacion where id = new.solicitud_id;
  perform set_config('app.flujo_interno', 'on', true);
  if new.decision = 'rechazada' then
    update solicitud_aprobacion set estado = 'rechazada', resuelta_at = now() where id = s.id;
  elsif s.paso_actual < jsonb_array_length(s.pasos) then
    update solicitud_aprobacion set paso_actual = paso_actual + 1, paso_desde = now() where id = s.id;
  else
    update solicitud_aprobacion set estado = 'aprobada', resuelta_at = now() where id = s.id;
  end if;
  perform set_config('app.flujo_interno', 'off', true);
  return null;
end $$;

create trigger aprobacion_decision_aplicar
  after insert on aprobacion_decision
  for each row execute function fn_aprobacion_decision_aplicar();

create function fn_aprobacion_decision_inmutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Una decisión de aprobación no se modifica ni se borra';
end $$;

create trigger aprobacion_decision_inmutable
  before update or delete on aprobacion_decision
  for each row execute function fn_aprobacion_decision_inmutable();

-- ---------------------------------------------------------------------
-- Reglas de la solicitud: solo avanza por decisiones (o se cancela)
-- ---------------------------------------------------------------------
create function fn_solicitud_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una solicitud de aprobación no se borra: se cancela';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' or new.paso_actual <> 1 then
      raise exception 'Una solicitud de aprobación nace pendiente, en el primer paso';
    end if;
    return new;
  end if;

  if old.estado <> 'pendiente' then
    raise exception 'Una solicitud ya resuelta no se modifica';
  end if;
  if new.objeto_tipo <> old.objeto_tipo or new.objeto_id <> old.objeto_id or new.pasos <> old.pasos
     or new.contexto <> old.contexto or new.solicitante_id <> old.solicitante_id or new.created_at <> old.created_at then
    raise exception 'Una solicitud de aprobación no se edita';
  end if;
  if new.estado = 'cancelada' then
    new.resuelta_at := now();
    return new;
  end if;
  -- Aprobar, rechazar o avanzar de paso solo lo hace el motor, al registrar una decisión.
  if coalesce(current_setting('app.flujo_interno', true), 'off') <> 'on' then
    raise exception 'Una solicitud solo se resuelve registrando una decisión de aprobación';
  end if;
  return new;
end $$;

create trigger solicitud_reglas
  before insert or update or delete on solicitud_aprobacion
  for each row execute function fn_solicitud_reglas();

create trigger flujo_definicion_audit    after insert or update or delete on flujo_definicion    for each row execute function fn_audit();
create trigger flujo_paso_audit          after insert or update or delete on flujo_paso          for each row execute function fn_audit();
create trigger solicitud_aprobacion_audit after insert or update or delete on solicitud_aprobacion for each row execute function fn_audit();
create trigger aprobacion_decision_audit after insert or update or delete on aprobacion_decision for each row execute function fn_audit();
create trigger delegacion_aprobacion_audit after insert or update or delete on delegacion_aprobacion for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Configuración inicial: las aprobaciones que ya existían, con sus mismos roles (§4.3)
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values
  ('cliente',          'Alta de cliente'),
  ('proveedor',        'Alta de proveedor'),
  ('proveedor_cambio', 'Cambio de datos sensibles de un proveedor'),
  ('asiento_manual',   'Asiento manual'),
  ('meta_lote',        'Lote de metas de venta');

insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, case objeto_tipo when 'asiento_manual' then 'jefe_contabilidad' else 'gerencia' end
  from flujo_definicion;

-- ---------------------------------------------------------------------
-- Solicitudes de lo que ya estaba pendiente (bases de desarrollo; en producción no hay nada)
-- ---------------------------------------------------------------------
select fn_flujo_solicitar('cliente', tercero_id, created_by) from cliente where estado = 'pendiente' and created_by is not null;
select fn_flujo_solicitar('proveedor', tercero_id, created_by) from proveedor where estado = 'pendiente' and created_by is not null;
select fn_flujo_solicitar('proveedor_cambio', id, solicitado_por) from proveedor_cambio where estado = 'pendiente';
select fn_flujo_solicitar('asiento_manual', id, created_by) from asiento where tipo = 'manual' and estado = 'borrador';
select fn_flujo_solicitar('meta_lote', id, creado_por) from meta_lote where estado = 'pendiente';
