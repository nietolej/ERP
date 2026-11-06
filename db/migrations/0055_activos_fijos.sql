-- =====================================================================
-- 0055 · Activos fijos y depreciación (spec §12.6; decisión 15)
--
--   R-EB  Método de línea recta, mensual, con una sola depreciación (la contable es la fiscal) y valor residual cero por defecto. Cada categoría
--         lleva su cuenta de activo, de depreciación acumulada y de gasto, y su vida útil en meses: valores de ejemplo hasta que el contador los
--         confirma (se guarda quién y cuándo). Nada de esto va en el código.
--   R-EC  Un activo fijo nace pendiente y lo aprueba Gerencia, distinta de quien lo registró. Esta primera entrega da de alta los activos que ya
--         existen al arranque (costo y depreciación acumulada contra «Saldos de apertura», con la base de datos rechazando altas con la apertura cerrada).
--   R-ED  La depreciación del mes se calcula por el sistema, en un asiento por mes y categoría; un activo no se deprecia por debajo de su valor
--         residual (la última cuota ajusta el resto), ni dos veces el mismo mes, ni saltándose meses. Los valores en USD salen del costo en USD.
--   R-EE  La baja es un documento con aprobación de Gerencia: saca el activo y su depreciación acumulada y lleva la diferencia a pérdida por baja.
-- =====================================================================

insert into cuenta_contable (codigo, nombre, tipo, naturaleza, imputable, controlada_por, padre_id)
select v.codigo, v.nombre, v.tipo, v.naturaleza, true, null, (select id from cuenta_contable where codigo = v.padre)
  from (values
    ('1.4.03', 'Vehículos',                          'activo', 'D', '1.4'),
    ('1.4.04', 'Equipos de computación',             'activo', 'D', '1.4'),
    ('1.4.05', 'Maquinaria y equipos de almacén',    'activo', 'D', '1.4'),
    ('1.4.06', 'Edificaciones y mejoras',            'activo', 'D', '1.4'),
    ('6.2.04', 'Depreciación del ejercicio',         'gasto',  'D', '6.2'),
    ('6.2.05', 'Pérdida por baja de activos fijos',  'gasto',  'D', '6.2')) as v(codigo, nombre, tipo, naturaleza, padre);

-- ---------------------------------------------------------------------
-- Categorías
-- ---------------------------------------------------------------------
create table categoria_activo (
  id                    uuid primary key default gen_random_uuid(),
  codigo                varchar(10) not null unique check (codigo ~ '^[A-Z0-9]+$'),
  nombre                text not null,
  cuenta_activo_id      uuid not null references cuenta_contable(id),
  cuenta_depreciacion_id uuid not null references cuenta_contable(id),
  cuenta_gasto_id       uuid not null references cuenta_contable(id),
  vida_util_meses       int not null check (vida_util_meses between 1 and 1200),
  validada_por          uuid references usuario(id),
  validada_at           timestamptz,
  activa                boolean not null default true,
  check ((validada_por is null) = (validada_at is null))
);

insert into categoria_activo (codigo, nombre, cuenta_activo_id, cuenta_depreciacion_id, cuenta_gasto_id, vida_util_meses)
select v.codigo, v.nombre, a.id, d.id, g.id, v.vida
  from (values
    ('EDIF',  'Edificaciones y mejoras',            '1.4.06', 240),
    ('MAQ',   'Maquinaria y equipos de almacén',    '1.4.05', 120),
    ('VEH',   'Vehículos',                          '1.4.03',  60),
    ('MOB',   'Mobiliario y equipo de oficina',     '1.4.01', 120),
    ('COMP',  'Equipos de computación',             '1.4.04',  48)) as v(codigo, nombre, cuenta, vida)
  join cuenta_contable a on a.codigo = v.cuenta
  join cuenta_contable d on d.codigo = '1.4.02'
  join cuenta_contable g on g.codigo = '6.2.04';

create function fn_categoria_activo_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una categoría de activos no se borra: se inactiva';
  end if;
  if tg_op = 'UPDATE' and new.vida_util_meses <> old.vida_util_meses then
    -- Cambiar la vida útil exige que alguien la valide: la confirmación anterior ya no vale.
    new.validada_por := fn_usuario_actual();
    if new.validada_por is null then
      raise exception 'Cambiar la vida útil de una categoría necesita el usuario que la confirma';
    end if;
    new.validada_at := now();
  end if;
  if new.validada_por is not null and not (fn_tiene_rol(new.validada_por, 'contabilidad') or fn_tiene_rol(new.validada_por, 'jefe_contabilidad') or fn_tiene_rol(new.validada_por, 'gerencia')) then
    raise exception 'Solo Contabilidad o Gerencia confirman la vida útil de una categoría';
  end if;
  return new;
end $$;
create trigger categoria_activo_antes before update or delete on categoria_activo for each row execute function fn_categoria_activo_antes();
create trigger categoria_activo_audit after insert or update on categoria_activo for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Activos
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('activo_fijo', 'A', '', 1), ('baja_activo_fijo', 'A', '', 1);

create table activo_fijo (
  id                        uuid primary key default gen_random_uuid(),
  codigo                    varchar(10) not null unique,
  descripcion               text not null check (length(trim(descripcion)) > 2),
  categoria_id              uuid not null references categoria_activo(id),
  origen                    text not null default 'apertura' check (origen = 'apertura'),
  fecha_adquisicion         date not null,
  ubicacion                 text,
  responsable               text,
  costo_ves                 numeric(18,2) not null check (costo_ves > 0),
  costo_usd                 numeric(16,2) not null check (costo_usd > 0),
  residual_ves              numeric(18,2) not null default 0 check (residual_ves >= 0),
  residual_usd              numeric(16,2) not null default 0 check (residual_usd >= 0),
  vida_util_meses           int not null check (vida_util_meses between 1 and 1200),
  meses_depreciados_apertura int not null default 0 check (meses_depreciados_apertura >= 0),
  dep_apertura_ves          numeric(18,2) not null default 0 check (dep_apertura_ves >= 0),
  dep_apertura_usd          numeric(16,2) not null default 0 check (dep_apertura_usd >= 0),
  inicio_depreciacion       date not null,
  estado                    text not null default 'pendiente' check (estado in ('pendiente', 'activo', 'depreciado', 'dado_de_baja', 'rechazado')),
  created_by                uuid not null references usuario(id),
  created_at                timestamptz not null default now(),
  aprobado_por              uuid references usuario(id),
  aprobado_at               timestamptz,
  rechazo_motivo            text,
  asiento_alta_id           uuid references asiento(id),
  check (residual_ves + dep_apertura_ves <= costo_ves and residual_usd + dep_apertura_usd <= costo_usd),
  check (meses_depreciados_apertura <= vida_util_meses),
  check (estado not in ('activo', 'depreciado', 'dado_de_baja') or (aprobado_por is not null and aprobado_at is not null and asiento_alta_id is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);

create function fn_activo_fijo_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un activo fijo no se borra: se da de baja';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Un activo fijo nace pendiente de aprobación';
    end if;
    if not (fn_tiene_rol(new.created_by, 'contabilidad') or fn_tiene_rol(new.created_by, 'jefe_contabilidad') or fn_tiene_rol(new.created_by, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia registran activos fijos';
    end if;
    new.codigo := 'AF' || lpad(fn_siguiente_numero('activo_fijo', 'A')::text, 5, '0');
    return new;
  end if;
  if new.codigo <> old.codigo or new.categoria_id <> old.categoria_id or new.fecha_adquisicion <> old.fecha_adquisicion or new.costo_ves <> old.costo_ves
     or new.costo_usd <> old.costo_usd or new.residual_ves <> old.residual_ves or new.residual_usd <> old.residual_usd or new.vida_util_meses <> old.vida_util_meses
     or new.meses_depreciados_apertura <> old.meses_depreciados_apertura or new.dep_apertura_ves <> old.dep_apertura_ves or new.dep_apertura_usd <> old.dep_apertura_usd
     or new.inicio_depreciacion <> old.inicio_depreciacion or new.created_by <> old.created_by then
    raise exception 'Los datos de un activo fijo no se modifican';
  end if;
  if new.estado = old.estado then
    return new;
  end if;
  if old.estado = 'pendiente' and new.estado in ('activo', 'depreciado') then
    if new.aprobado_por is null or new.aprobado_por = old.created_by or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Gerencia, distinta de quien registró el activo, lo aprueba';
    end if;
    new.aprobado_at := coalesce(new.aprobado_at, now());
  elsif old.estado = 'pendiente' and new.estado = 'rechazado' then
    null;
  elsif old.estado = 'activo' and new.estado = 'depreciado' then
    null;
  elsif old.estado in ('activo', 'depreciado') and new.estado = 'dado_de_baja' then
    null;
  else
    raise exception 'Cambio de estado del activo no permitido (% → %)', old.estado, new.estado;
  end if;
  return new;
end $$;
create trigger activo_fijo_antes before insert or update or delete on activo_fijo for each row execute function fn_activo_fijo_antes();
create trigger activo_fijo_audit after insert or update on activo_fijo for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Depreciación mensual
-- ---------------------------------------------------------------------
create table depreciacion_activo (
  id          bigint generated always as identity primary key,
  activo_id   uuid not null references activo_fijo(id),
  periodo_id  uuid not null references periodo_contable(id),
  monto_ves   numeric(18,2) not null check (monto_ves >= 0),
  monto_usd   numeric(16,2) not null check (monto_usd >= 0),
  asiento_id  uuid not null references asiento(id),
  created_by  uuid not null references usuario(id),
  created_at  timestamptz not null default now(),
  check (monto_ves + monto_usd > 0),
  unique (activo_id, periodo_id)
);
create function fn_depreciacion_inmutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Una depreciación contabilizada no se modifica ni se borra: se corrige con un asiento';
end $$;
create trigger depreciacion_activo_inmutable before update or delete on depreciacion_activo for each row execute function fn_depreciacion_inmutable();
create trigger depreciacion_activo_audit after insert on depreciacion_activo for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Baja
-- ---------------------------------------------------------------------
create table baja_activo (
  id              uuid primary key default gen_random_uuid(),
  numero          bigint not null unique,
  activo_id       uuid not null references activo_fijo(id),
  fecha           date not null,
  motivo          text not null check (length(trim(motivo)) > 2),
  estado          text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  aprobado_por    uuid references usuario(id),
  aprobado_at     timestamptz,
  rechazo_motivo  text,
  costo_ves       numeric(18,2),
  depreciacion_ves numeric(18,2),
  perdida_ves     numeric(18,2),
  asiento_id      uuid references asiento(id),
  check (estado <> 'aprobada' or (aprobado_por is not null and aprobado_at is not null and asiento_id is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index baja_activo_vigente on baja_activo (activo_id) where estado <> 'rechazada';

create function fn_baja_activo_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una baja de activo no se borra';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Una baja nace pendiente de aprobación';
    end if;
    if not (fn_tiene_rol(new.created_by, 'contabilidad') or fn_tiene_rol(new.created_by, 'jefe_contabilidad') or fn_tiene_rol(new.created_by, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia solicitan la baja de un activo';
    end if;
    new.numero := fn_siguiente_numero('baja_activo_fijo', 'A');
    return new;
  end if;
  if new.numero <> old.numero or new.activo_id <> old.activo_id or new.fecha <> old.fecha or new.motivo <> old.motivo or new.created_by <> old.created_by then
    raise exception 'Una baja de activo no se modifica';
  end if;
  if new.estado = old.estado then
    return new;
  end if;
  if old.estado = 'pendiente' and new.estado = 'aprobada' then
    if new.aprobado_por is null or new.aprobado_por = old.created_by or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Gerencia, distinta de quien solicitó la baja, la aprueba';
    end if;
    new.aprobado_at := coalesce(new.aprobado_at, now());
  elsif old.estado = 'pendiente' and new.estado = 'rechazada' then
    null;
  else
    raise exception 'Cambio de estado de la baja no permitido (% → %)', old.estado, new.estado;
  end if;
  return new;
end $$;
create trigger baja_activo_antes before insert or update or delete on baja_activo for each row execute function fn_baja_activo_antes();
create trigger baja_activo_audit after insert or update on baja_activo for each row execute function fn_audit();

insert into flujo_definicion (objeto_tipo, nombre) values ('activo_fijo', 'Alta de activo fijo'), ('baja_activo_fijo', 'Baja de activo fijo');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo in ('activo_fijo', 'baja_activo_fijo');

alter table configuracion_contable drop constraint configuracion_contable_clave_check;
alter table configuracion_contable add constraint configuracion_contable_clave_check
  check (clave in ('redondeo', 'diferencial_ganancia', 'diferencial_perdida', 'saldos_apertura', 'resultado_ejercicio',
                   'revaluacion_cxp', 'revaluacion_anticipos_clientes', 'revaluacion_anticipos_proveedores', 'perdida_baja_activo'));
insert into configuracion_contable (clave, cuenta_id) select 'perdida_baja_activo', id from cuenta_contable where codigo = '6.2.05';
