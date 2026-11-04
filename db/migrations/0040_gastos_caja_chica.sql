-- =====================================================================
-- 0040 · Gastos de proveedor y caja chica (spec §10.1, §12.3)
--
--   R-CG  Cada categoría de gasto apunta a una cuenta contable de gasto (y, si se quiere, a un centro de costo). La factura de gasto de un
--         proveedor de servicios (alquiler, servicios, publicidad…) nace PENDIENTE y no mueve nada; la aprueba Gerencia (distinta de quien la
--         registró). Al aprobarse, en una sola transacción: retenciones de IVA e ISLR, cuenta por pagar (neta de retención) y asiento.
--   R-CH  El IVA de un gasto es crédito fiscal solo si la categoría lo permite; si no, se suma al gasto. El soporte (PDF o imagen) es obligatorio
--         y la base de datos lo verifica al confirmar la transacción.
--   R-CI  Caja chica: fondo fijo por custodio y moneda. Gerencia fija el monto del fondo y el tope por vale. El fondo se constituye y se repone
--         desde una cuenta bancaria (misma moneda) con la aprobación de Gerencia, distinta de quien la solicitó. Cada vale gasta el fondo al
--         registrarse (sin aprobación, bajo el tope) y exige su soporte; no puede exceder el saldo del fondo.
--   R-CJ  La reposición devuelve el fondo a su monto fijo: reúne los vales aún no repuestos y su monto es exactamente la suma de esos vales.
--         Un vale se anula con motivo mientras no esté en una reposición; el asiento se reversa.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('gasto_proveedor',  'A', '',   1),
  ('fondo_caja',       'A', 'CC', 1),
  ('vale_caja',        'A', '',   1),
  ('reposicion_caja',  'A', '',   1);

-- ---------------------------------------------------------------------
-- Categorías de gasto
-- ---------------------------------------------------------------------
create table categoria_gasto (
  id                 uuid primary key default gen_random_uuid(),
  codigo             varchar(30) not null unique check (codigo ~ '^[A-Z0-9_]+$'),
  nombre             text not null check (length(trim(nombre)) > 2),
  cuenta_contable_id uuid not null references cuenta_contable(id),
  centro_costo_id    uuid references centro_costo(id),
  iva_deducible      boolean not null default true,       -- el IVA de estos gastos es crédito fiscal
  activa             boolean not null default true,
  created_at         timestamptz not null default now()
);

create function fn_categoria_gasto_antes() returns trigger
language plpgsql as $$
declare c cuenta_contable%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una categoría de gasto no se borra: se inactiva';
  end if;
  select * into c from cuenta_contable where id = new.cuenta_contable_id;
  if not found or c.tipo <> 'gasto' or not c.imputable or not c.activa then
    raise exception 'La cuenta de la categoría debe ser una cuenta de gasto activa que reciba movimientos';
  end if;
  if tg_op = 'UPDATE' and new.codigo <> old.codigo then
    raise exception 'El código de una categoría no se cambia';
  end if;
  return new;
end $$;
create trigger categoria_gasto_antes before insert or update or delete on categoria_gasto
  for each row execute function fn_categoria_gasto_antes();

insert into categoria_gasto (codigo, nombre, cuenta_contable_id, iva_deducible)
select v.codigo, v.nombre, c.id, v.deducible
  from (values
    ('ALQUILER',            'Alquiler',                      '6.2.02', true),
    ('SERVICIOS',           'Servicios (electricidad, agua, teléfono, internet)', '6.2.03', true),
    ('FLETES_VENTA',        'Fletes de venta',               '6.1.02', true),
    ('PUBLICIDAD',          'Publicidad',                    '6.1.03', true),
    ('COMISIONES_BANCARIAS','Comisiones bancarias',          '6.3.01', false)) as v(codigo, nombre, cuenta, deducible)
  join cuenta_contable c on c.codigo = v.cuenta;

-- ---------------------------------------------------------------------
-- Factura de gasto de un proveedor
-- ---------------------------------------------------------------------
create table gasto_proveedor (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint not null unique,
  proveedor_id        uuid not null references proveedor(tercero_id),
  categoria_id        uuid not null references categoria_gasto(id),
  descripcion         text not null check (length(trim(descripcion)) > 2),
  numero_factura      varchar(40) not null check (length(trim(numero_factura)) > 0),
  numero_control      varchar(40) not null check (length(trim(numero_control)) > 0),
  fecha_factura       date not null,
  fecha_vencimiento   date not null,
  moneda              char(3) not null references moneda(codigo),
  tasa                numeric(18,6) not null check (tasa > 0),
  base                numeric(16,2) not null check (base > 0),
  alicuota_iva_id     uuid not null references alicuota_iva(id),
  alicuota_pct        numeric(6,2) not null check (alicuota_pct >= 0),
  iva                 numeric(16,2) not null check (iva >= 0),
  total               numeric(16,2) not null,
  total_usd           numeric(16,2) not null check (total_usd >= 0),
  iva_deducible       boolean not null,                      -- se copia de la categoría al registrar
  retencion_iva_total boolean not null default false,
  estado              text not null default 'pendiente' check (estado in ('pendiente', 'contabilizado', 'rechazado')),
  created_by          uuid not null references usuario(id),
  created_at          timestamptz not null default now(),
  aprobado_por        uuid references usuario(id),
  aprobado_at         timestamptz,
  rechazo_motivo      text,
  check (total = base + iva),
  check (fecha_vencimiento >= fecha_factura),
  check (estado <> 'contabilizado' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index gasto_proveedor_factura_unica on gasto_proveedor (proveedor_id, upper(trim(numero_factura))) where estado <> 'rechazado';
create index gasto_proveedor_estado_idx on gasto_proveedor (estado, fecha_factura);

create function fn_gasto_proveedor_antes() returns trigger
language plpgsql as $$
declare
  v_hoy   date := (now() at time zone 'America/Caracas')::date;
  v_cat   categoria_gasto%rowtype;
  v_usd   numeric;
  v_aprob uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una factura de gasto no se borra: se rechaza';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Una factura de gasto nace pendiente';
    end if;
    if not exists (select 1 from proveedor where tercero_id = new.proveedor_id and estado = 'activo') then
      raise exception 'El proveedor debe estar activo';
    end if;
    select * into v_cat from categoria_gasto where id = new.categoria_id;
    if not found or not v_cat.activa then
      raise exception 'La categoría de gasto debe existir y estar activa';
    end if;
    if new.fecha_factura > v_hoy then
      raise exception 'La fecha de la factura no puede ser futura';
    end if;
    new.iva_deducible := v_cat.iva_deducible;
    -- IVA y totales con la alícuota vigente a la fecha de la factura (mismo redondeo del motor).
    new.tasa := fn_tasa(new.moneda, new.fecha_factura);
    v_usd := fn_tasa('USD', new.fecha_factura);
    new.alicuota_pct := fn_alicuota_iva_pct(new.alicuota_iva_id, new.fecha_factura);
    new.iva := round(new.base * new.alicuota_pct / 100, 2);
    new.total := new.base + new.iva;
    new.total_usd := case when new.moneda = 'USD' then new.total else round(round(new.total * new.tasa, 2) / v_usd, 2) end;
    new.numero := fn_siguiente_numero('gasto_proveedor', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una factura de gasto necesita el usuario que la registra';
    end if;
    new.aprobado_por := null; new.aprobado_at := null; new.rechazo_motivo := null;
    return new;
  end if;

  if (to_jsonb(new) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo') is distinct from
     (to_jsonb(old) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo') then
    raise exception 'Una factura de gasto no se edita: se rechaza o se corrige con una nota del proveedor';
  end if;
  if new.estado = old.estado then
    new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at; new.rechazo_motivo := old.rechazo_motivo;
    return new;
  end if;
  if old.estado <> 'pendiente' then
    raise exception 'Una factura de gasto % no cambia de estado', old.estado;
  end if;
  v_aprob := new.aprobado_por;
  if new.estado = 'contabilizado' then
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar una factura de gasto';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien registró la factura de gasto no la aprueba';
    end if;
    new.aprobado_at := now();
    new.rechazo_motivo := null;
    return new;
  elsif new.estado = 'rechazado' then
    new.aprobado_por := null; new.aprobado_at := null;
    return new;
  end if;
  raise exception 'Una factura de gasto pendiente solo se aprueba o se rechaza';
end $$;
create trigger gasto_proveedor_antes before insert or update or delete on gasto_proveedor
  for each row execute function fn_gasto_proveedor_antes();

-- La cuenta por pagar y las retenciones también nacen de una factura de gasto.
alter table partida_cxp
  add column gasto_proveedor_id uuid unique references gasto_proveedor(id),
  drop constraint partida_cxp_origen,
  add constraint partida_cxp_origen check (
    ((factura_id is not null)::int + (gasto_id is not null)::int + (nota_id is not null)::int + (gasto_proveedor_id is not null)::int) = 1);

create or replace function fn_partida_cxp_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una partida de cuentas por pagar no se borra';
  end if;
  if tg_op = 'INSERT' then
    new.saldo_ves := coalesce(new.saldo_ves, round(new.monto_original * new.tasa, 2));
    new.saldo_usd := coalesce(new.saldo_usd, new.monto_usd);
    return new;
  end if;
  if new.proveedor_id <> old.proveedor_id or new.factura_id is distinct from old.factura_id or new.gasto_id is distinct from old.gasto_id
     or new.nota_id is distinct from old.nota_id or new.gasto_proveedor_id is distinct from old.gasto_proveedor_id
     or new.fecha <> old.fecha or new.vencimiento <> old.vencimiento
     or new.moneda <> old.moneda or new.tasa <> old.tasa or new.monto_original <> old.monto_original or new.monto_usd <> old.monto_usd then
    raise exception 'Una partida de cuentas por pagar solo cambia su saldo';
  end if;
  if (new.saldo <> old.saldo or new.saldo_ves <> old.saldo_ves or new.saldo_usd <> old.saldo_usd or new.estado <> old.estado)
     and coalesce(current_setting('app.cxp_interno', true), '') <> '1' then
    raise exception 'El saldo de una cuenta por pagar solo cambia con un pago, una nota del proveedor o una retención';
  end if;
  return new;
end $$;

alter table retencion_compra add column gasto_proveedor_id uuid references gasto_proveedor(id);
alter table retencion_compra drop constraint retencion_compra_origen;
alter table retencion_compra add constraint retencion_compra_origen
  check (((factura_id is not null)::int + (gasto_id is not null)::int + (nota_id is not null)::int + (gasto_proveedor_id is not null)::int) = 1);
create unique index retencion_compra_gasto_proveedor_unica on retencion_compra (gasto_proveedor_id, impuesto) where gasto_proveedor_id is not null;

-- ---------------------------------------------------------------------
-- Caja chica: fondo, reposición y vales
-- ---------------------------------------------------------------------
create table fondo_caja (
  id                 uuid primary key default gen_random_uuid(),
  codigo             varchar(10) not null unique,
  nombre             text not null check (length(trim(nombre)) > 2),
  custodio_id        uuid not null references usuario(id),
  cuenta_bancaria_id uuid not null unique references cuenta_bancaria(id),   -- la caja donde está el efectivo del fondo
  moneda             char(3) not null references moneda(codigo),
  monto_fijo         numeric(16,2) not null check (monto_fijo > 0),
  tope_vale          numeric(16,2) not null check (tope_vale > 0),
  activo             boolean not null default true,
  created_by         uuid not null references usuario(id),
  created_at         timestamptz not null default now(),
  check (tope_vale <= monto_fijo)
);

create function fn_fondo_caja_antes() returns trigger
language plpgsql as $$
declare cb cuenta_bancaria%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un fondo de caja chica no se borra: se inactiva';
  end if;
  if tg_op = 'INSERT' then
    if new.codigo is not null then
      raise exception 'El código del fondo lo asigna el sistema';
    end if;
    select * into cb from cuenta_bancaria where id = new.cuenta_bancaria_id;
    if not found or cb.tipo <> 'caja' or not cb.activa then
      raise exception 'El efectivo del fondo debe estar en una cuenta de tipo caja activa';
    end if;
    new.moneda := cb.moneda;
    if not exists (select 1 from usuario where id = new.custodio_id and activo) then
      raise exception 'El custodio debe ser un usuario activo';
    end if;
    new.codigo := (select prefijo from numerador where tipo_documento = 'fondo_caja' and serie = 'A') || lpad(fn_siguiente_numero('fondo_caja', 'A')::text, 3, '0');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un fondo necesita el usuario que lo crea';
    end if;
    return new;
  end if;
  if new.codigo <> old.codigo or new.cuenta_bancaria_id <> old.cuenta_bancaria_id or new.moneda <> old.moneda or new.monto_fijo <> old.monto_fijo
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'El código, la caja, la moneda y el monto fijo de un fondo no se cambian: cree otro fondo';
  end if;
  if new.custodio_id <> old.custodio_id and not exists (select 1 from usuario where id = new.custodio_id and activo) then
    raise exception 'El custodio debe ser un usuario activo';
  end if;
  return new;
end $$;
create trigger fondo_caja_antes before insert or update or delete on fondo_caja
  for each row execute function fn_fondo_caja_antes();

create table reposicion_caja (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint not null unique,
  fondo_id          uuid not null references fondo_caja(id),
  tipo              text not null check (tipo in ('constitucion', 'reposicion')),
  cuenta_origen_id  uuid not null references cuenta_bancaria(id),       -- el banco de donde sale el dinero
  monto             numeric(16,2) not null check (monto > 0),
  moneda            char(3) not null references moneda(codigo),
  referencia        text,
  estado            text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  aprobado_por      uuid references usuario(id),
  aprobado_at       timestamptz,
  rechazo_motivo    text,
  check (estado <> 'aprobada' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index reposicion_caja_constitucion_unica on reposicion_caja (fondo_id) where tipo = 'constitucion' and estado <> 'rechazada';
create unique index reposicion_caja_pendiente_unica on reposicion_caja (fondo_id) where estado = 'pendiente';

create table vale_caja (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint not null unique,
  fondo_id          uuid not null references fondo_caja(id),
  fecha             date not null,
  categoria_id      uuid not null references categoria_gasto(id),
  beneficiario      text not null check (length(trim(beneficiario)) > 2),
  descripcion       text not null check (length(trim(descripcion)) > 2),
  comprobante       varchar(40),                                       -- número de la factura o recibo
  control           varchar(40),                                       -- número de control: con él el IVA es crédito fiscal
  moneda            char(3) not null references moneda(codigo),
  tasa              numeric(18,6) not null check (tasa > 0),
  base              numeric(16,2) not null check (base > 0),
  alicuota_iva_id   uuid not null references alicuota_iva(id),
  alicuota_pct      numeric(6,2) not null check (alicuota_pct >= 0),
  iva               numeric(16,2) not null check (iva >= 0),
  total             numeric(16,2) not null,
  total_usd         numeric(16,2) not null check (total_usd >= 0),
  iva_credito       boolean not null,                                  -- el IVA va a crédito fiscal (categoría deducible y con número de control)
  estado            text not null default 'registrado' check (estado in ('registrado', 'repuesto', 'anulado')),
  reposicion_id     uuid references reposicion_caja(id),
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  anulado_motivo    text,
  anulado_por       uuid references usuario(id),
  anulado_at        timestamptz,
  check (total = base + iva),
  check ((estado = 'anulado') = (anulado_at is not null)),
  check (estado <> 'anulado' or (anulado_por is not null and length(trim(coalesce(anulado_motivo, ''))) > 2)),
  check (estado <> 'repuesto' or reposicion_id is not null)
);
create index vale_caja_fondo_idx on vale_caja (fondo_id, estado);
create index vale_caja_reposicion_idx on vale_caja (reposicion_id);

-- Saldo del fondo: lo constituido y repuesto (aprobado) menos lo gastado en vales vigentes.
create view vw_fondo_caja_saldo as
select f.id as fondo_id, f.codigo, f.moneda, f.monto_fijo,
       (coalesce((select sum(r.monto) from reposicion_caja r where r.fondo_id = f.id and r.estado = 'aprobada'), 0)
        - coalesce((select sum(v.total) from vale_caja v where v.fondo_id = f.id and v.estado <> 'anulado'), 0))::numeric(16,2) as saldo,
       coalesce((select sum(v.total) from vale_caja v where v.fondo_id = f.id and v.estado = 'registrado' and v.reposicion_id is null), 0)::numeric(16,2) as por_reponer,
       coalesce((select sum(v.total) from vale_caja v where v.fondo_id = f.id and v.estado = 'registrado' and v.reposicion_id is not null), 0)::numeric(16,2) as en_reposicion
  from fondo_caja f;

create function fn_reposicion_caja_antes() returns trigger
language plpgsql as $$
declare
  f       fondo_caja%rowtype;
  cb      cuenta_bancaria%rowtype;
  v_aprob uuid;
  v_vales numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una reposición de caja no se borra: se rechaza';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Una reposición de caja nace pendiente';
    end if;
    select * into f from fondo_caja where id = new.fondo_id for update;
    if not found or not f.activo then
      raise exception 'El fondo de caja chica no existe o está inactivo';
    end if;
    select * into cb from cuenta_bancaria where id = new.cuenta_origen_id;
    if not found or not cb.activa or cb.tipo = 'caja' then
      raise exception 'El dinero debe salir de una cuenta bancaria activa (no de una caja)';
    end if;
    if cb.moneda <> f.moneda then
      raise exception 'La cuenta de origen debe estar en la misma moneda del fondo (%)', f.moneda;
    end if;
    new.moneda := f.moneda;
    if new.tipo = 'constitucion' then
      if new.monto <> f.monto_fijo then
        raise exception 'La constitución del fondo es por su monto fijo (%)', f.monto_fijo;
      end if;
    else
      if not exists (select 1 from reposicion_caja where fondo_id = f.id and tipo = 'constitucion' and estado = 'aprobada') then
        raise exception 'El fondo todavía no se ha constituido';
      end if;
    end if;
    new.numero := fn_siguiente_numero('reposicion_caja', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una reposición necesita el usuario que la solicita';
    end if;
    new.aprobado_por := null; new.aprobado_at := null; new.rechazo_motivo := null;
    return new;
  end if;

  if (to_jsonb(new) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo') is distinct from
     (to_jsonb(old) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo') then
    raise exception 'Una reposición de caja no se edita: se rechaza y se solicita otra';
  end if;
  if new.estado = old.estado then
    new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at; new.rechazo_motivo := old.rechazo_motivo;
    return new;
  end if;
  if old.estado <> 'pendiente' then
    raise exception 'Una reposición % no cambia de estado', old.estado;
  end if;
  v_aprob := new.aprobado_por;
  if new.estado = 'aprobada' then
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar una reposición de caja';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien solicitó la reposición no la aprueba';
    end if;
    if old.tipo = 'reposicion' then
      select coalesce(sum(total), 0) into v_vales from vale_caja where reposicion_id = old.id and estado = 'registrado';
      if v_vales <> old.monto then
        raise exception 'La reposición (%) debe ser exactamente la suma de sus vales (%)', old.monto, v_vales;
      end if;
    end if;
    new.aprobado_at := now();
    new.rechazo_motivo := null;
    return new;
  elsif new.estado = 'rechazada' then
    new.aprobado_por := null; new.aprobado_at := null;
    return new;
  end if;
  raise exception 'Una reposición pendiente solo se aprueba o se rechaza';
end $$;
create trigger reposicion_caja_antes before insert or update or delete on reposicion_caja
  for each row execute function fn_reposicion_caja_antes();

create function fn_vale_caja_antes() returns trigger
language plpgsql as $$
declare
  v_hoy   date := (now() at time zone 'America/Caracas')::date;
  f       fondo_caja%rowtype;
  v_cat   categoria_gasto%rowtype;
  v_usd   numeric;
  v_saldo numeric;
  v_gen   boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un vale de caja chica no se borra: se anula';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'registrado' or new.reposicion_id is not null then
      raise exception 'Un vale nace registrado y sin reposición';
    end if;
    select * into f from fondo_caja where id = new.fondo_id for update;
    if not found or not f.activo then
      raise exception 'El fondo de caja chica no existe o está inactivo';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un vale necesita el usuario que lo registra';
    end if;
    if new.created_by <> f.custodio_id and not fn_tiene_rol(new.created_by, 'gerencia') then
      raise exception 'Solo el custodio del fondo (o Gerencia) registra vales';
    end if;
    if new.fecha > v_hoy then
      raise exception 'La fecha del vale no puede ser futura';
    end if;
    select * into v_cat from categoria_gasto where id = new.categoria_id;
    if not found or not v_cat.activa then
      raise exception 'La categoría de gasto debe existir y estar activa';
    end if;
    new.moneda := f.moneda;
    new.tasa := fn_tasa(new.moneda, new.fecha);
    v_usd := fn_tasa('USD', new.fecha);
    new.alicuota_pct := fn_alicuota_iva_pct(new.alicuota_iva_id, new.fecha);
    new.iva := round(new.base * new.alicuota_pct / 100, 2);
    new.total := new.base + new.iva;
    new.total_usd := case when new.moneda = 'USD' then new.total else round(round(new.total * new.tasa, 2) / v_usd, 2) end;
    new.iva_credito := v_cat.iva_deducible and new.iva > 0 and length(trim(coalesce(new.control, ''))) > 0;
    if new.total > f.tope_vale then
      raise exception 'El vale (% %) excede el tope por vale del fondo (% %): regístrelo como factura de gasto', new.moneda, new.total, f.moneda, f.tope_vale;
    end if;
    select saldo into v_saldo from vw_fondo_caja_saldo where fondo_id = f.id;
    if new.total > v_saldo then
      raise exception 'El vale (% %) excede el saldo del fondo (% %)', new.moneda, new.total, f.moneda, v_saldo;
    end if;
    new.numero := fn_siguiente_numero('vale_caja', 'A');
    new.anulado_motivo := null; new.anulado_por := null; new.anulado_at := null;
    return new;
  end if;

  -- UPDATE: solo reservar o liberar para una reposición, marcarlo repuesto o anularlo; siempre desde la aplicación (R-CJ).
  if (to_jsonb(new) - 'estado' - 'reposicion_id' - 'anulado_motivo' - 'anulado_por' - 'anulado_at') is distinct from
     (to_jsonb(old) - 'estado' - 'reposicion_id' - 'anulado_motivo' - 'anulado_por' - 'anulado_at') then
    raise exception 'Un vale de caja chica no se edita: se anula y se registra otro';
  end if;
  if coalesce(current_setting('app.caja_interno', true), '') <> '1' then
    raise exception 'El estado de un vale solo cambia con una reposición o al anularlo';
  end if;
  if old.estado = 'anulado' then
    raise exception 'Un vale anulado no se modifica';
  end if;
  v_gen := false;
  if new.estado = 'anulado' then
    if old.estado <> 'registrado' or old.reposicion_id is not null then
      raise exception 'Solo se anula un vale que no esté en una reposición';
    end if;
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := now();
    return new;
  end if;
  new.anulado_motivo := old.anulado_motivo; new.anulado_por := old.anulado_por; new.anulado_at := old.anulado_at;
  if old.estado = 'registrado' and new.estado = 'registrado' and (old.reposicion_id is null) <> (new.reposicion_id is null) then
    return new;                                                     -- reservar o liberar
  end if;
  if old.estado = 'registrado' and new.estado = 'repuesto' and new.reposicion_id is not distinct from old.reposicion_id and old.reposicion_id is not null then
    return new;
  end if;
  raise exception 'Cambio de estado no permitido en un vale';
end $$;
create trigger vale_caja_antes before insert or update or delete on vale_caja
  for each row execute function fn_vale_caja_antes();

-- ---------------------------------------------------------------------
-- Soportes: adjuntos de la factura de gasto y del vale (§4.2, §10.1). Obligatorios al confirmar la transacción.
-- ---------------------------------------------------------------------
alter table adjunto drop constraint adjunto_entidad_tipo_check;
alter table adjunto add constraint adjunto_entidad_tipo_check
  check (entidad_tipo in ('cliente', 'proveedor', 'producto', 'transporte_parada', 'cobro', 'gasto_proveedor', 'vale_caja'));

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
      when 'cobro'             then exists (select 1 from cobro where id = new.entidad_id)
      when 'gasto_proveedor'   then exists (select 1 from gasto_proveedor where id = new.entidad_id)
      when 'vale_caja'         then exists (select 1 from vale_caja where id = new.entidad_id)
    end;
    if not v_existe then
      raise exception 'El adjunto apunta a un % que no existe', new.entidad_tipo;
    end if;
    if new.anulado_at is not null then
      raise exception 'Un adjunto nace vigente';
    end if;
    return new;
  end if;

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

-- Un gasto o un vale sin soporte vigente no se confirma (se verifica al terminar la transacción).
create function fn_exigir_soporte() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from adjunto where entidad_tipo = tg_argv[0] and entidad_id = new.id and anulado_at is null) then
    raise exception 'Adjunte el soporte (PDF o imagen) de %', case tg_argv[0] when 'vale_caja' then 'el vale' else 'la factura de gasto' end;
  end if;
  return null;
end $$;
create constraint trigger gasto_proveedor_soporte after insert on gasto_proveedor
  deferrable initially deferred for each row execute function fn_exigir_soporte('gasto_proveedor');
create constraint trigger vale_caja_soporte after insert on vale_caja
  deferrable initially deferred for each row execute function fn_exigir_soporte('vale_caja');

-- ---------------------------------------------------------------------
-- Flujo de aprobación: Gerencia, distinta de quien registró (R-CG, R-CI)
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values
  ('gasto_proveedor', 'Factura de gasto de proveedor'),
  ('reposicion_caja', 'Constitución o reposición de caja chica');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo in ('gasto_proveedor', 'reposicion_caja');

-- ---------------------------------------------------------------------
-- Reglas contables (§12.3), en la moneda del documento
--   factura de gasto: gasto (cuenta de la categoría) e IVA crédito fiscal contra cuentas por pagar (neto) y retenciones
--   vale:             gasto e IVA contra la caja del fondo
--   reposición:       caja del fondo contra el banco de origen
-- ---------------------------------------------------------------------
insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('gasto_proveedor', 1, 'D', null,     'gasto', 'gasto',   'Gasto según su categoría'),
    ('gasto_proveedor', 2, 'D', '1.2.03', null,    'iva',     'IVA crédito fiscal'),
    ('gasto_proveedor', 3, 'H', '2.1.01', null,    'neto',    'Cuentas por pagar a proveedores (neto de retenciones)'),
    ('gasto_proveedor', 4, 'H', '2.1.04', null,    'ret_iva', 'Retenciones de IVA por enterar'),
    ('gasto_proveedor', 5, 'H', '2.1.05', null,    'ret_islr','Retenciones de ISLR por enterar'),
    ('vale_caja',       1, 'D', null,     'gasto', 'gasto',   'Gasto de caja chica según su categoría'),
    ('vale_caja',       2, 'D', '1.2.03', null,    'iva',     'IVA crédito fiscal'),
    ('vale_caja',       3, 'H', null,     'caja',  'total',   'Salida de la caja chica'),
    ('reposicion_caja', 1, 'D', null,     'caja',  'monto',   'Entrada a la caja chica'),
    ('reposicion_caja', 2, 'H', null,     'banco', 'monto',   'Salida del banco')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;

create trigger categoria_gasto_audit  after insert or update or delete on categoria_gasto  for each row execute function fn_audit();
create trigger gasto_proveedor_audit  after insert or update or delete on gasto_proveedor  for each row execute function fn_audit();
create trigger fondo_caja_audit       after insert or update or delete on fondo_caja       for each row execute function fn_audit();
create trigger reposicion_caja_audit  after insert or update or delete on reposicion_caja  for each row execute function fn_audit();
create trigger vale_caja_audit        after insert or update or delete on vale_caja        for each row execute function fn_audit();
