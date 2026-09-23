-- =====================================================================
-- 0003 · Contabilidad general: plan de cuentas, periodos, asientos y
--        motor de reglas (§3.2, §12.2, §12.3)
--
-- Reglas garantizadas por la base de datos (no solo por la aplicación):
--   R-A  Un asiento se contabiliza solo si cuadra en VES y en USD (≥ 2 líneas).
--   R-B  Un asiento contabilizado y sus líneas no se editan ni se borran.
--        Se corrigen con un asiento de reverso (fn_reversar_asiento).
--   R-C  Periodo 'abierto' acepta todo; 'cerrado' solo reversos y cierre;
--        'bloqueado' nada.
--   R-D  Solo las cuentas imputables y activas reciben líneas; las cuentas
--        controladas por un auxiliar no aceptan asientos manuales.
--   R-E  Un documento no genera dos veces el mismo asiento (idempotencia).
-- =====================================================================

create table cuenta_contable (
  id             uuid primary key default gen_random_uuid(),
  codigo         varchar(20) not null unique check (codigo ~ '^[0-9]+(\.[0-9]+)*$'),
  nombre         text not null,
  tipo           text not null check (tipo in ('activo', 'pasivo', 'patrimonio', 'ingreso', 'costo', 'gasto')),
  naturaleza     char(1) not null check (naturaleza in ('D', 'A')),   -- D = deudora, A = acreedora
  padre_id       uuid references cuenta_contable(id),
  imputable      boolean not null default true,                     -- solo las hojas reciben movimientos
  moneda         varchar(4) references moneda(codigo),              -- fijada, p. ej. un banco en USD
  controlada_por text check (controlada_por in ('cxc', 'cxp', 'inventario', 'banco', 'comisiones', 'apertura')),
  activa         boolean not null default true,
  created_at     timestamptz not null default now()
);

create table centro_costo (
  id          uuid primary key default gen_random_uuid(),
  codigo      varchar(10) not null unique,
  nombre      text not null,
  sucursal_id uuid references sucursal(id),
  activo      boolean not null default true
);

-- Mes 13 = periodo de cierre del ejercicio (asientos de cierre, fecha 31/12).
create table periodo_contable (
  id          uuid primary key default gen_random_uuid(),
  anio        smallint not null check (anio between 2000 and 2100),
  mes         smallint not null check (mes between 1 and 13),
  inicio      date not null,
  fin         date not null,
  estado      text not null default 'abierto' check (estado in ('abierto', 'cerrado', 'bloqueado')),
  cambiado_por uuid references usuario(id),
  cambiado_at  timestamptz,
  unique (anio, mes),
  check (fin >= inicio)
);

-- Un periodo bloqueado no se reabre (quedó auditado o declarado).
create function fn_periodo_transicion() returns trigger
language plpgsql as $$
begin
  if old.estado = 'bloqueado' and new.estado <> 'bloqueado' then
    raise exception 'El periodo %-% está bloqueado y no se puede reabrir', old.anio, old.mes;
  end if;
  if new.estado <> old.estado then
    new.cambiado_por := coalesce(fn_usuario_actual(), new.cambiado_por);
    new.cambiado_at  := now();
  end if;
  return new;
end $$;

create trigger periodo_transicion
  before update on periodo_contable
  for each row execute function fn_periodo_transicion();

create function fn_crear_periodos(p_anio int) returns int
language plpgsql as $$
declare
  m int;
  n int := 0;
begin
  for m in 1..12 loop
    insert into periodo_contable (anio, mes, inicio, fin)
    values (p_anio, m, make_date(p_anio, m, 1), (make_date(p_anio, m, 1) + interval '1 month - 1 day')::date)
    on conflict (anio, mes) do nothing;
    if found then n := n + 1; end if;
  end loop;
  insert into periodo_contable (anio, mes, inicio, fin)
  values (p_anio, 13, make_date(p_anio, 12, 31), make_date(p_anio, 12, 31))
  on conflict (anio, mes) do nothing;
  if found then n := n + 1; end if;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Asientos
-- ---------------------------------------------------------------------
create table asiento (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint unique,                     -- se asigna al contabilizar (correlativo sin huecos)
  periodo_id        uuid not null references periodo_contable(id),
  fecha             date not null,
  tipo              text not null check (tipo in ('automatico', 'manual', 'reverso', 'cierre', 'apertura', 'ajuste_cambiario')),
  descripcion       text not null check (length(trim(descripcion)) > 0),
  origen_tipo       text,
  origen_id         uuid,
  reversa_de        uuid unique references asiento(id),  -- un asiento se reversa una sola vez
  estado            text not null default 'borrador' check (estado in ('borrador', 'contabilizado')),
  aprobado_por      uuid references usuario(id),
  contabilizado_por uuid references usuario(id),
  contabilizado_at  timestamptz,
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  unique (origen_tipo, origen_id, tipo),               -- R-E idempotencia
  check ((origen_tipo is null) = (origen_id is null)),
  check (estado = 'borrador' or (numero is not null and contabilizado_at is not null)),
  check ((tipo = 'reverso') = (reversa_de is not null))
);
create index asiento_fecha_idx on asiento (fecha);

create table asiento_linea (
  id              bigint generated always as identity primary key,
  asiento_id      uuid not null references asiento(id) on delete cascade,
  cuenta_id       uuid not null references cuenta_contable(id),
  centro_costo_id uuid references centro_costo(id),
  tercero_id      uuid,                                 -- FK a tercero se agrega en la Fase 1
  debe_ves        numeric(18,2) not null default 0 check (debe_ves >= 0),
  haber_ves       numeric(18,2) not null default 0 check (haber_ves >= 0),
  debe_usd        numeric(16,2) not null default 0 check (debe_usd >= 0),
  haber_usd       numeric(16,2) not null default 0 check (haber_usd >= 0),
  moneda_original varchar(4) not null references moneda(codigo),
  monto_original  numeric(18,2) not null check (monto_original >= 0),
  tasa            numeric(18,6) not null check (tasa > 0),   -- VES por 1 unidad de la moneda original
  glosa           text,
  -- una línea va al debe o al haber, nunca a ambos
  check (not ((debe_ves > 0 or debe_usd > 0) and (haber_ves > 0 or haber_usd > 0))),
  check (debe_ves + haber_ves + debe_usd + haber_usd > 0)
);
create index asiento_linea_asiento_idx on asiento_linea (asiento_id);
create index asiento_linea_cuenta_idx  on asiento_linea (cuenta_id);

-- Periodo que corresponde a una fecha (mes 13 solo para asientos de cierre).
create function fn_periodo_de(p_fecha date, p_tipo text) returns periodo_contable
language plpgsql stable as $$
declare p periodo_contable;
begin
  select * into p
    from periodo_contable
   where p_fecha between inicio and fin
     and ((p_tipo = 'cierre' and mes = 13) or (p_tipo <> 'cierre' and mes <> 13));
  if p.id is null then
    raise exception 'No existe periodo contable para el % (cree los periodos del año)', p_fecha;
  end if;
  return p;
end $$;

-- R-C: qué tipos de asiento acepta cada estado de periodo.
create function fn_validar_periodo(p periodo_contable, p_tipo text) returns void
language plpgsql as $$
begin
  if p.estado = 'bloqueado' then
    raise exception 'El periodo %-% está bloqueado: no admite asientos', p.anio, p.mes;
  end if;
  if p.estado = 'cerrado' and p_tipo not in ('reverso', 'cierre') then
    raise exception 'El periodo %-% está cerrado: solo admite reversos y asientos de cierre', p.anio, p.mes;
  end if;
end $$;

create function fn_asiento_antes() returns trigger
language plpgsql as $$
declare p periodo_contable;
begin
  if tg_op = 'DELETE' then
    if old.estado = 'contabilizado' then
      raise exception 'El asiento N° % está contabilizado: no se puede borrar. Use un asiento de reverso.', old.numero;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un asiento nace en borrador y se contabiliza después de cargar sus líneas';
    end if;
  else  -- UPDATE
    if old.estado = 'contabilizado' then
      raise exception 'El asiento N° % está contabilizado: no se puede modificar. Use un asiento de reverso.', old.numero;
    end if;
  end if;

  p := fn_periodo_de(new.fecha, new.tipo);
  new.periodo_id := p.id;

  if new.estado = 'contabilizado' then          -- transición borrador → contabilizado
    perform fn_validar_periodo(p, new.tipo);
    new.numero            := fn_siguiente_numero('asiento', 'A');
    new.contabilizado_at  := now();
    new.contabilizado_por := coalesce(new.contabilizado_por, fn_usuario_actual());
  end if;
  return new;
end $$;

create trigger asiento_antes
  before insert or update or delete on asiento
  for each row execute function fn_asiento_antes();

-- R-A: cuadre al contabilizar. Diferido hasta el COMMIT, como pide la §12.2.
create function fn_asiento_cuadre() returns trigger
language plpgsql as $$
declare
  v_lineas int;
  v_dv numeric; v_hv numeric; v_du numeric; v_hu numeric;
begin
  select count(*), coalesce(sum(debe_ves), 0), coalesce(sum(haber_ves), 0),
         coalesce(sum(debe_usd), 0), coalesce(sum(haber_usd), 0)
    into v_lineas, v_dv, v_hv, v_du, v_hu
    from asiento_linea where asiento_id = new.id;
  if v_lineas < 2 then
    raise exception 'El asiento N° % necesita al menos dos líneas', new.numero;
  end if;
  if v_dv <> v_hv then
    raise exception 'El asiento N° % no cuadra en VES: debe % ≠ haber %', new.numero, v_dv, v_hv;
  end if;
  if v_du <> v_hu then
    raise exception 'El asiento N° % no cuadra en USD: debe % ≠ haber %', new.numero, v_du, v_hu;
  end if;
  return null;
end $$;

create constraint trigger asiento_cuadre
  after update on asiento
  deferrable initially deferred
  for each row
  when (new.estado = 'contabilizado' and old.estado = 'borrador')
  execute function fn_asiento_cuadre();

-- R-B y R-D en las líneas.
create function fn_asiento_linea_antes() returns trigger
language plpgsql as $$
declare
  a asiento;
  c cuenta_contable;
begin
  select * into a from asiento where id = coalesce(new.asiento_id, old.asiento_id);
  if a.estado = 'contabilizado' then
    raise exception 'El asiento N° % está contabilizado: sus líneas no se pueden modificar', a.numero;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select * into c from cuenta_contable where id = new.cuenta_id;
  if not c.imputable then
    raise exception 'La cuenta % (%) es de agrupación: no recibe movimientos', c.codigo, c.nombre;
  end if;
  if not c.activa then
    raise exception 'La cuenta % (%) está inactiva', c.codigo, c.nombre;
  end if;
  if c.controlada_por is not null and a.tipo = 'manual' then
    raise exception 'La cuenta % (%) es controlada por el auxiliar de %: no admite asientos manuales',
      c.codigo, c.nombre, c.controlada_por;
  end if;
  return new;
end $$;

create trigger asiento_linea_antes
  before insert or update or delete on asiento_linea
  for each row execute function fn_asiento_linea_antes();

-- Corrección de un asiento contabilizado: asiento espejo (debe ↔ haber), contabilizado.
create function fn_reversar_asiento(p_asiento uuid, p_fecha date, p_motivo text) returns uuid
language plpgsql as $$
declare
  a asiento;
  v_nuevo uuid;
begin
  select * into a from asiento where id = p_asiento;
  if a.id is null then
    raise exception 'El asiento % no existe', p_asiento;
  end if;
  if a.estado <> 'contabilizado' then
    raise exception 'Solo se reversan asientos contabilizados (un borrador se corrige o se borra)';
  end if;
  if a.tipo = 'reverso' then
    raise exception 'Un asiento de reverso no se reversa: registre un asiento nuevo';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'El reverso requiere un motivo';
  end if;

  insert into asiento (fecha, tipo, descripcion, origen_tipo, origen_id, reversa_de, created_by)
  values (p_fecha, 'reverso', 'Reverso del asiento N° ' || a.numero || ': ' || p_motivo,
          a.origen_tipo, a.origen_id, a.id, coalesce(fn_usuario_actual(), a.created_by))
  returning id into v_nuevo;

  insert into asiento_linea (asiento_id, cuenta_id, centro_costo_id, tercero_id,
                             debe_ves, haber_ves, debe_usd, haber_usd,
                             moneda_original, monto_original, tasa, glosa)
  select v_nuevo, cuenta_id, centro_costo_id, tercero_id,
         haber_ves, debe_ves, haber_usd, debe_usd,
         moneda_original, monto_original, tasa, glosa
    from asiento_linea where asiento_id = a.id order by id;

  update asiento set estado = 'contabilizado' where id = v_nuevo;
  return v_nuevo;
end $$;

-- ---------------------------------------------------------------------
-- Motor de reglas contables (§12.3): cada evento de negocio se traduce en
-- líneas según esta tabla. La aplicación la lee (src/lib/contabilidad/motor.ts).
-- ---------------------------------------------------------------------
create table regla_contable (
  id          uuid primary key default gen_random_uuid(),
  evento      text not null check (evento ~ '^[a-z_]+$'),
  orden       smallint not null,
  lado        char(1) not null check (lado in ('D', 'H')),
  cuenta_id   uuid not null references cuenta_contable(id),
  importe     text not null check (importe ~ '^[a-z_]+$'),   -- clave del importe dentro del evento: 'base', 'iva', 'total'…
  glosa       text,
  activa      boolean not null default true,
  unique (evento, orden)
);

-- Cuentas especiales que usa el motor.
create table configuracion_contable (
  clave     text primary key check (clave in ('redondeo', 'diferencial_ganancia', 'diferencial_perdida', 'saldos_apertura', 'resultado_ejercicio')),
  cuenta_id uuid not null references cuenta_contable(id)
);

-- ---------------------------------------------------------------------
-- Controles
-- ---------------------------------------------------------------------
create view vw_balance_comprobacion as
select c.codigo, c.nombre, c.tipo, c.naturaleza,
       sum(l.debe_ves)  as debe_ves,  sum(l.haber_ves)  as haber_ves,
       sum(l.debe_usd)  as debe_usd,  sum(l.haber_usd)  as haber_usd,
       sum(l.debe_ves - l.haber_ves) as saldo_ves,
       sum(l.debe_usd - l.haber_usd) as saldo_usd
  from asiento_linea l
  join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado'
  join cuenta_contable c on c.id = l.cuenta_id
 group by c.codigo, c.nombre, c.tipo, c.naturaleza;

-- Alerta de integridad: debe dar cero. Distinto de cero = se saltaron las reglas (§12.2).
create view vw_control_cuadre as
select coalesce(sum(l.debe_ves - l.haber_ves), 0) as diferencia_ves,
       coalesce(sum(l.debe_usd - l.haber_usd), 0) as diferencia_usd
  from asiento_linea l
  join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado';

create trigger cuenta_contable_audit    after insert or update or delete on cuenta_contable    for each row execute function fn_audit();
create trigger periodo_contable_audit   after insert or update or delete on periodo_contable   for each row execute function fn_audit();
create trigger asiento_audit            after insert or update or delete on asiento            for each row execute function fn_audit();
create trigger regla_contable_audit     after insert or update or delete on regla_contable     for each row execute function fn_audit();
create trigger configuracion_contable_audit after insert or update or delete on configuracion_contable for each row execute function fn_audit();
