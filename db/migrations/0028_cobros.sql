-- =====================================================================
-- 0028 · Cobros, su aplicación a las cuentas por cobrar y su asiento; cuentas bancarias e instrumentos de pago (§6.3, §12.3)
--
--   R-BR  Cada partida de cuentas por cobrar guarda lo que queda de su valor en USD a la tasa de su factura (saldo_usd). Así el
--         auxiliar cuadra con el mayor al centavo en bolívares y en dólares, aunque se cobre por partes.
--   R-BS  El saldo de una partida solo lo mueve una aplicación de cobro (o la anulación de su factura): lo hace el trigger de
--         aplicacion_cobro, que además CALCULA los importes de la aplicación (bolívares que cancela, USD históricos, valor en los
--         libros de lo cobrado). La aplicación no se edita ni se borra; al anular el cobro se revierte.
--   R-BT  Un cobro nace sin aplicar con la tasa BCV de su fecha (la fija la base de datos). Lo que no se aplica queda como anticipo y
--         se aplica después a facturas del mismo cliente. Un cobro no se edita: se anula con motivo mientras no esté conciliado
--         ni tenga un anticipo ya aplicado. El número es correlativo y la referencia no se repite por cuenta.
--   R-BU  Cada cuenta bancaria o caja tiene su subcuenta contable propia. Una cuenta no se borra: se inactiva.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Partidas: valor en USD pendiente (R-BR)
-- ---------------------------------------------------------------------
alter table partida_cxc add column saldo_usd numeric(16,2);
update partida_cxc set saldo_usd = case when estado = 'abierta' then round(monto_usd * saldo / monto_original, 2) else 0 end;
alter table partida_cxc
  alter column saldo_usd set not null,
  add constraint partida_cxc_saldo_usd check (saldo_usd >= 0 and saldo_usd <= monto_usd),
  add constraint partida_cxc_saldo_usd_cero check (saldo > 0 or saldo_usd = 0);

create or replace function fn_partida_cxc_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una partida de cuentas por cobrar no se borra: se anula con su factura';
  end if;
  if tg_op = 'INSERT' then
    new.saldo_usd := coalesce(new.saldo_usd, new.monto_usd);
    return new;
  end if;
  if new.cliente_id <> old.cliente_id or new.documento_id <> old.documento_id or new.fecha <> old.fecha or new.vencimiento <> old.vencimiento
     or new.moneda <> old.moneda or new.tasa <> old.tasa or new.monto_original <> old.monto_original or new.monto_usd <> old.monto_usd then
    raise exception 'Una partida de cuentas por cobrar solo cambia su saldo';
  end if;
  if (new.saldo <> old.saldo or new.saldo_usd <> old.saldo_usd or new.estado <> old.estado)
     and coalesce(current_setting('app.cxc_interno', true), '') <> '1' then
    raise exception 'El saldo de una cuenta por cobrar solo cambia con un cobro, una nota de crédito o la anulación de su factura';
  end if;
  if new.estado = 'anulada' then
    new.saldo_usd := 0;
  end if;
  return new;
end $$;

-- El crédito del cliente cuenta lo que realmente debe: el valor en USD que queda de cada partida.
create or replace function fn_exposicion_credito_usd(p_cliente uuid) returns numeric
language sql stable as $$
  select coalesce((select sum(p.saldo_usd) from partida_cxc p where p.cliente_id = p_cliente and p.estado = 'abierta'), 0)
       + coalesce((select sum(n.total_usd) from documento_venta n
                    where n.cliente_id = p_cliente and n.tipo = 'nota_entrega' and n.estado = 'emitido' and n.factura_id is null), 0)
       + coalesce((select sum(round(l.total * greatest(l.cantidad - coalesce(en.cant, 0), 0) / l.cantidad, 2))
                     from documento_venta p
                     join documento_venta_linea l on l.documento_id = p.id
                     left join lateral (select sum(nl.cantidad) as cant
                                          from documento_venta_linea nl
                                          join documento_venta nn on nn.id = nl.documento_id and nn.estado = 'emitido'
                                         where nl.linea_origen_id = l.id) en on true
                    where p.cliente_id = p_cliente and p.tipo = 'pedido' and p.estado = 'emitido' and p.situacion = 'aprobado'), 0)
$$;

-- ---------------------------------------------------------------------
-- Instrumentos de pago
-- ---------------------------------------------------------------------
create table instrumento_pago (
  id          uuid primary key default gen_random_uuid(),
  codigo      varchar(20) not null unique check (codigo ~ '^[A-Z0-9_]+$'),
  nombre      text not null check (length(trim(nombre)) > 2),
  genera_igtf boolean not null default false,
  activo      boolean not null default true
);
insert into instrumento_pago (codigo, nombre, genera_igtf) values
  ('TRANSFERENCIA',   'Transferencia bancaria',  false),
  ('PAGO_MOVIL',      'Pago móvil',              false),
  ('PUNTO_VENTA',     'Punto de venta',          false),
  ('CHEQUE',          'Cheque',                  false),
  ('EFECTIVO_VES',    'Efectivo en bolívares',   false),
  ('EFECTIVO_USD',    'Efectivo en dólares',     true),
  ('ZELLE',           'Zelle',                   true),
  ('USDT',            'USDT',                    true);
create trigger instrumento_pago_audit after insert or update or delete on instrumento_pago for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Cuentas bancarias y cajas (R-BU)
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('cuenta_bancaria', 'A', 'CB', 1);
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('cobro', 'A', '', 1);

create table cuenta_bancaria (
  id                 uuid primary key default gen_random_uuid(),
  codigo             varchar(10) not null unique,
  nombre             text not null check (length(trim(nombre)) > 2),
  banco_id           uuid references banco(id),
  numero             text,
  tipo               text not null check (tipo in ('banco', 'caja', 'custodia', 'exterior', 'digital')),
  moneda             char(3) not null references moneda(codigo),
  cuenta_contable_id uuid not null unique references cuenta_contable(id),
  activa             boolean not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid references usuario(id),
  check (tipo <> 'banco' or banco_id is not null)
);
create unique index cuenta_bancaria_numero_unico on cuenta_bancaria (banco_id, numero) where numero is not null;

create function fn_cuenta_bancaria_antes() returns trigger
language plpgsql as $$
declare
  v_prefijo text;
  c cuenta_contable%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una cuenta bancaria no se borra: se inactiva';
  end if;
  if tg_op = 'INSERT' then
    if new.codigo is not null then
      raise exception 'El código de la cuenta lo asigna el sistema';
    end if;
    select prefijo into v_prefijo from numerador where tipo_documento = 'cuenta_bancaria' and serie = 'A';
    new.codigo := v_prefijo || lpad(fn_siguiente_numero('cuenta_bancaria', 'A')::text, 4, '0');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    select * into c from cuenta_contable where id = new.cuenta_contable_id;
    if not found or not c.imputable or not c.activa then
      raise exception 'La subcuenta contable de la cuenta bancaria debe existir, estar activa y recibir movimientos';
    end if;
    if c.moneda is distinct from new.moneda then
      raise exception 'La subcuenta contable debe tener la misma moneda que la cuenta bancaria (%)', new.moneda;
    end if;
    return new;
  end if;
  if new.codigo <> old.codigo or new.cuenta_contable_id <> old.cuenta_contable_id or new.moneda <> old.moneda or new.tipo <> old.tipo then
    raise exception 'El código, la subcuenta contable, la moneda y el tipo de una cuenta bancaria no se cambian';
  end if;
  return new;
end $$;

create trigger cuenta_bancaria_antes
  before insert or update or delete on cuenta_bancaria
  for each row execute function fn_cuenta_bancaria_antes();

-- ---------------------------------------------------------------------
-- Cobros (R-BT)
-- ---------------------------------------------------------------------
create table cobro (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint not null unique,
  cliente_id          uuid not null references cliente(tercero_id),
  fecha               date not null,
  instrumento_id      uuid not null references instrumento_pago(id),
  cuenta_bancaria_id  uuid not null references cuenta_bancaria(id),
  referencia          text,
  moneda              char(3) not null references moneda(codigo),
  tasa                numeric(18,6) not null check (tasa > 0),
  monto               numeric(16,2) not null check (monto > 0),
  monto_ves           numeric(18,2) not null check (monto_ves > 0),
  monto_usd           numeric(16,2) not null check (monto_usd >= 0),
  por_aplicar         numeric(16,2) not null check (por_aplicar >= 0),
  por_aplicar_ves     numeric(18,2) not null check (por_aplicar_ves >= 0),
  por_aplicar_usd     numeric(16,2) not null check (por_aplicar_usd >= 0),
  observaciones       text,
  estado              text not null default 'registrado' check (estado in ('registrado', 'conciliado', 'anulado')),
  created_by          uuid not null references usuario(id),
  created_at          timestamptz not null default now(),
  anulado_por         uuid references usuario(id),
  anulado_at          timestamptz,
  anulado_motivo      text,
  anulado_motivo_id   uuid references motivo(id),
  check (por_aplicar <= monto),
  check ((estado = 'anulado') = (anulado_at is not null)),
  check (estado <> 'anulado' or (length(trim(coalesce(anulado_motivo, ''))) > 2 and anulado_motivo_id is not null))
);
create index cobro_cliente_idx on cobro (cliente_id, estado);
create unique index cobro_referencia_unica on cobro (cuenta_bancaria_id, upper(trim(referencia))) where referencia is not null and estado <> 'anulado';

create table aplicacion_cobro (
  id             uuid primary key default gen_random_uuid(),
  cobro_id       uuid not null references cobro(id),
  partida_id     uuid not null references partida_cxc(id),
  origen         text not null check (origen in ('registro', 'anticipo')),
  fecha          date not null,
  liquida        boolean not null default false,       -- el cobro liquida el saldo de la factura (tolerancia de un centavo de la divisa)
  monto_cobro    numeric(16,2) not null check (monto_cobro > 0),
  -- Lo siguiente lo calcula la base de datos al insertar:
  tasa           numeric(18,6) not null check (tasa > 0),
  monto_partida  numeric(16,2) not null check (monto_partida > 0),
  usd_partida    numeric(16,2) not null check (usd_partida >= 0),
  base_ves       numeric(18,2) not null check (base_ves >= 0),
  base_usd       numeric(16,2) not null check (base_usd >= 0),
  revertida      boolean not null default false,
  created_by     uuid references usuario(id),
  created_at     timestamptz not null default now()
);
create index aplicacion_cobro_cobro_idx on aplicacion_cobro (cobro_id);
create index aplicacion_cobro_partida_idx on aplicacion_cobro (partida_id);

create function fn_cobro_antes() returns trigger
language plpgsql as $$
declare
  v_hoy     date := (now() at time zone 'America/Caracas')::date;
  v_cuenta  cuenta_bancaria%rowtype;
  v_cliente text;
  v_interno boolean := coalesce(current_setting('app.cxc_interno', true), '') = '1';
  v_previo  text;
  a         aplicacion_cobro%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un cobro no se borra: se anula';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'registrado' then
      raise exception 'Un cobro nace registrado';
    end if;
    new.numero := fn_siguiente_numero('cobro', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un cobro necesita el usuario que lo registra';
    end if;
    if new.fecha > v_hoy then
      raise exception 'La fecha del cobro no puede ser futura';
    end if;
    select * into v_cuenta from cuenta_bancaria where id = new.cuenta_bancaria_id;
    if not found or not v_cuenta.activa then
      raise exception 'La cuenta donde entró el cobro debe estar activa';
    end if;
    if new.moneda <> v_cuenta.moneda then
      raise exception 'La moneda del cobro es la de la cuenta (%)', v_cuenta.moneda;
    end if;
    if not exists (select 1 from instrumento_pago where id = new.instrumento_id and activo) then
      raise exception 'El instrumento de pago debe estar activo';
    end if;
    select estado into v_cliente from cliente where tercero_id = new.cliente_id;
    if v_cliente is null or v_cliente = 'pendiente' then
      raise exception 'El cliente todavía no está aprobado';
    end if;
    new.referencia := nullif(trim(new.referencia), '');
    -- La tasa BCV de la fecha, el valor en bolívares y el valor en USD los fija la base de datos.
    new.tasa := fn_tasa(new.moneda, new.fecha);
    new.monto_ves := round(new.monto * new.tasa, 2);
    new.monto_usd := case when new.moneda = 'USD' then new.monto else round(new.monto_ves / fn_tasa('USD', new.fecha), 2) end;
    new.por_aplicar := new.monto; new.por_aplicar_ves := new.monto_ves; new.por_aplicar_usd := new.monto_usd;
    new.anulado_por := null; new.anulado_at := null;
    return new;
  end if;

  -- UPDATE
  if (new.numero, new.cliente_id, new.fecha, new.instrumento_id, new.cuenta_bancaria_id, new.referencia, new.moneda, new.tasa, new.monto,
      new.monto_ves, new.monto_usd, new.observaciones, new.created_by, new.created_at)
     is distinct from
     (old.numero, old.cliente_id, old.fecha, old.instrumento_id, old.cuenta_bancaria_id, old.referencia, old.moneda, old.tasa, old.monto,
      old.monto_ves, old.monto_usd, old.observaciones, old.created_by, old.created_at) then
    raise exception 'Un cobro registrado no se edita: se anula con su motivo';
  end if;
  if (new.por_aplicar, new.por_aplicar_ves, new.por_aplicar_usd) is distinct from (old.por_aplicar, old.por_aplicar_ves, old.por_aplicar_usd)
     and not v_interno then
    raise exception 'Lo que falta por aplicar de un cobro solo cambia con una aplicación';
  end if;
  new.anulado_por := old.anulado_por; new.anulado_at := old.anulado_at;
  if new.estado = old.estado then
    new.anulado_motivo := old.anulado_motivo; new.anulado_motivo_id := old.anulado_motivo_id;
    return new;
  end if;

  if old.estado = 'registrado' and new.estado = 'conciliado' then
    return new;
  elsif old.estado = 'registrado' and new.estado = 'anulado' then
    if length(trim(coalesce(new.anulado_motivo, ''))) < 3 then
      raise exception 'Indique el motivo de la anulación';
    end if;
    perform fn_motivo_valido(new.anulado_motivo_id, 'anulacion');
    if exists (select 1 from aplicacion_cobro where cobro_id = old.id and origen = 'anticipo' and not revertida) then
      raise exception 'Este cobro tiene un anticipo ya aplicado a facturas: corrija esas aplicaciones con una nota de crédito antes de anularlo';
    end if;
    -- Las facturas recuperan su saldo (con el permiso interno, que se devuelve como estaba).
    v_previo := coalesce(current_setting('app.cxc_interno', true), '');
    perform set_config('app.cxc_interno', '1', true);
    for a in select * from aplicacion_cobro where cobro_id = old.id and not revertida loop
      update partida_cxc set saldo = saldo + a.monto_partida, saldo_usd = saldo_usd + a.usd_partida, estado = 'abierta' where id = a.partida_id;
      update aplicacion_cobro set revertida = true where id = a.id;
    end loop;
    perform set_config('app.cxc_interno', v_previo, true);
    new.por_aplicar := 0; new.por_aplicar_ves := 0; new.por_aplicar_usd := 0;
    new.anulado_por := coalesce(fn_usuario_actual(), new.anulado_por);
    new.anulado_at := now();
    return new;
  end if;
  raise exception 'Un cobro % no pasa a %', old.estado, new.estado;
end $$;

create trigger cobro_antes
  before insert or update or delete on cobro
  for each row execute function fn_cobro_antes();

create function fn_aplicacion_cobro_antes() returns trigger
language plpgsql as $$
declare
  v_hoy    date := (now() at time zone 'America/Caracas')::date;
  c        cobro%rowtype;
  p        partida_cxc%rowtype;
  v_crudo  numeric;
  v_previo text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una aplicación de cobro no se borra: se revierte al anular el cobro';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'revertida') is distinct from (to_jsonb(old) - 'revertida') or old.revertida or not new.revertida
       or coalesce(current_setting('app.cxc_interno', true), '') <> '1' then
      raise exception 'Una aplicación de cobro no se modifica';
    end if;
    return new;
  end if;

  select * into c from cobro where id = new.cobro_id for update;
  select * into p from partida_cxc where id = new.partida_id for update;
  if c.estado is distinct from 'registrado' then
    raise exception 'Solo se aplican cobros registrados y no conciliados';
  end if;
  if p.cliente_id <> c.cliente_id then
    raise exception 'El cobro y la factura son de clientes distintos';
  end if;
  if p.estado <> 'abierta' then
    raise exception 'La factura no tiene saldo por cobrar';
  end if;
  if p.moneda <> 'VES' then
    raise exception 'Solo se aplican cobros a facturas en bolívares';
  end if;
  if new.origen = 'registro' and new.fecha <> c.fecha then
    raise exception 'La aplicación hecha al registrar el cobro lleva la fecha del cobro';
  end if;
  if new.origen = 'anticipo' and new.fecha < c.fecha then
    raise exception 'La aplicación de un anticipo no puede ser anterior al cobro';
  end if;
  if new.fecha > v_hoy then
    raise exception 'La fecha de la aplicación no puede ser futura';
  end if;
  if new.fecha < p.fecha then
    raise exception 'La aplicación no puede ser anterior a la fecha de la factura';
  end if;
  if new.monto_cobro > c.por_aplicar then
    raise exception 'El cobro solo tiene % por aplicar', c.por_aplicar;
  end if;

  -- Bolívares que cancela en la factura: la tasa BCV de la fecha de la aplicación.
  new.tasa := fn_tasa(c.moneda, new.fecha);
  if c.moneda = 'VES' then
    new.monto_partida := new.monto_cobro;
  else
    v_crudo := new.monto_cobro * new.tasa;
    if new.liquida then
      if abs(v_crudo - p.saldo) > new.tasa * 0.01 then
        raise exception 'El cobro no liquida la factura: % % equivalen a Bs. %, y el saldo es Bs. %', new.monto_cobro, c.moneda, round(v_crudo, 2), p.saldo;
      end if;
      new.monto_partida := p.saldo;
    else
      new.monto_partida := round(v_crudo, 2);
    end if;
  end if;
  if new.monto_partida > p.saldo then
    raise exception 'La aplicación (Bs. %) excede el saldo de la factura (Bs. %)', new.monto_partida, p.saldo;
  end if;
  -- Su valor en USD a la tasa de la factura.
  new.usd_partida := case when new.monto_partida = p.saldo then p.saldo_usd else round(p.saldo_usd * new.monto_partida / p.saldo, 2) end;
  -- Valor en los libros de la parte del cobro que se aplica: la proporción de lo que queda, o todo si se aplica lo último.
  if new.monto_cobro = c.por_aplicar then
    new.base_ves := c.por_aplicar_ves; new.base_usd := c.por_aplicar_usd;
  else
    new.base_ves := round(c.por_aplicar_ves * new.monto_cobro / c.por_aplicar, 2);
    new.base_usd := round(c.por_aplicar_usd * new.monto_cobro / c.por_aplicar, 2);
  end if;
  new.revertida := false;
  new.created_by := coalesce(new.created_by, fn_usuario_actual());

  v_previo := coalesce(current_setting('app.cxc_interno', true), '');
  perform set_config('app.cxc_interno', '1', true);
  update cobro set por_aplicar = por_aplicar - new.monto_cobro, por_aplicar_ves = por_aplicar_ves - new.base_ves,
                   por_aplicar_usd = por_aplicar_usd - new.base_usd
   where id = c.id;
  update partida_cxc set saldo = saldo - new.monto_partida, saldo_usd = saldo_usd - new.usd_partida,
                         estado = case when saldo - new.monto_partida = 0 then 'cancelada' else 'abierta' end
   where id = p.id;
  perform set_config('app.cxc_interno', v_previo, true);
  return new;
end $$;

create trigger aplicacion_cobro_antes
  before insert or update or delete on aplicacion_cobro
  for each row execute function fn_aplicacion_cobro_antes();

-- ---------------------------------------------------------------------
-- Motor contable: una regla puede apuntar a una cuenta variable (la del banco donde entró el cobro) (§12.3)
-- ---------------------------------------------------------------------
alter table regla_contable
  alter column cuenta_id drop not null,
  add column cuenta_variable text check (cuenta_variable ~ '^[a-z_]+$'),
  add constraint regla_contable_cuenta check ((cuenta_id is null) <> (cuenta_variable is null));

insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('cobro',               1, 'D', null,     'banco',  'banco',            'Cobro recibido'),
    ('cobro',               2, 'D', '6.3.02', null,     'dif_perdida_ves',  'Pérdida por diferencial cambiario (Bs)'),
    ('cobro',               3, 'D', '6.3.02', null,     'dif_perdida_usd',  'Pérdida por diferencial cambiario (USD)'),
    ('cobro',               4, 'H', '1.2.01', null,     'cxc',              'Cuentas por cobrar comerciales'),
    ('cobro',               5, 'H', '2.1.08', null,     'anticipo',         'Anticipo de cliente'),
    ('cobro',               6, 'H', '4.2.01', null,     'dif_ganancia_ves', 'Ganancia por diferencial cambiario (Bs)'),
    ('cobro',               7, 'H', '4.2.01', null,     'dif_ganancia_usd', 'Ganancia por diferencial cambiario (USD)'),
    ('aplicacion_anticipo', 1, 'D', '2.1.08', null,     'anticipo',         'Anticipo de cliente aplicado'),
    ('aplicacion_anticipo', 2, 'D', '6.3.02', null,     'dif_perdida_ves',  'Pérdida por diferencial cambiario (Bs)'),
    ('aplicacion_anticipo', 3, 'D', '6.3.02', null,     'dif_perdida_usd',  'Pérdida por diferencial cambiario (USD)'),
    ('aplicacion_anticipo', 4, 'H', '1.2.01', null,     'cxc',              'Cuentas por cobrar comerciales'),
    ('aplicacion_anticipo', 5, 'H', '4.2.01', null,     'dif_ganancia_ves', 'Ganancia por diferencial cambiario (Bs)'),
    ('aplicacion_anticipo', 6, 'H', '4.2.01', null,     'dif_ganancia_usd', 'Ganancia por diferencial cambiario (USD)')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;

-- ---------------------------------------------------------------------
-- Adjuntos: el comprobante de pago del cobro (§4.2)
-- ---------------------------------------------------------------------
alter table adjunto drop constraint adjunto_entidad_tipo_check;
alter table adjunto add constraint adjunto_entidad_tipo_check
  check (entidad_tipo in ('cliente', 'proveedor', 'producto', 'transporte_parada', 'cobro'));

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

create trigger cuenta_bancaria_audit  after insert or update or delete on cuenta_bancaria  for each row execute function fn_audit();
create trigger cobro_audit            after insert or update or delete on cobro            for each row execute function fn_audit();
create trigger aplicacion_cobro_audit after insert or update or delete on aplicacion_cobro for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Antigüedad de saldos (calculada una sola vez, aquí): cada partida abierta con sus días y su tramo de vencimiento
-- ---------------------------------------------------------------------
create view vw_cxc_antiguedad as
select p.id as partida_id, p.cliente_id, p.documento_id, d.serie || '-' || d.numero as factura, p.fecha, p.vencimiento,
       p.saldo, p.saldo_usd,
       (((now() at time zone 'America/Caracas')::date) - p.fecha) as dias_emitida,
       greatest(((now() at time zone 'America/Caracas')::date) - p.vencimiento, 0) as dias_vencida,
       case
         when ((now() at time zone 'America/Caracas')::date) <= p.vencimiento then 'por_vencer'
         when ((now() at time zone 'America/Caracas')::date) - p.vencimiento <= 30 then 'v_1_30'
         when ((now() at time zone 'America/Caracas')::date) - p.vencimiento <= 60 then 'v_31_60'
         when ((now() at time zone 'America/Caracas')::date) - p.vencimiento <= 90 then 'v_61_90'
         else 'v_mas_90'
       end as tramo
  from partida_cxc p
  join documento_venta d on d.id = p.documento_id
 where p.estado = 'abierta';
