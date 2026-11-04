-- =====================================================================
-- 0038 · Pagos a proveedores, su aprobación, su aplicación a las cuentas por pagar y su asiento (spec §7.3, §12.3)
--
--   R-BZ  Cada partida de cuentas por pagar guarda lo que queda de su valor en bolívares y en USD a la tasa de su factura
--         (saldo_ves, saldo_usd), como las de cobrar. El auxiliar cuadra con el mayor al centavo en las dos monedas aunque se pague
--         por partes o en otra moneda.
--   R-CA  Todo pago nace SOLICITADO y no mueve nada. Lo aprueba Gerencia (distinta de quien lo solicitó); al aprobarse se aplica a las
--         facturas, sale del banco y se contabiliza, todo en la misma transacción. Un pago rechazado no mueve nada.
--   R-CB  El saldo de una partida solo lo mueve una aplicación de pago (lo hace el trigger de aplicacion_pago, que además CALCULA los
--         importes: lo que cancela en la moneda de la factura, su valor histórico en VES y USD y el valor en los libros de lo pagado).
--         La diferencia entre lo que sale de cuentas por pagar y lo que sale del banco es diferencial cambiario (4.2.01 / 6.3.02).
--         Lo que no se aplica queda como anticipo a proveedor (1.2.02), que se aplica después a facturas del mismo proveedor.
--   R-CC  Un pago pagado no se edita ni se borra: se anula con motivo (reverso del asiento y las facturas recuperan su saldo), salvo que
--         ya tenga un anticipo aplicado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Partidas: valor histórico pendiente (R-BZ)
-- ---------------------------------------------------------------------
alter table partida_cxp add column saldo_ves numeric(18,2), add column saldo_usd numeric(16,2);
update partida_cxp set
  saldo_ves = case when estado = 'abierta' then round(saldo * tasa, 2) else 0 end,
  saldo_usd = case when estado = 'abierta' then round(monto_usd * saldo / monto_original, 2) else 0 end;
alter table partida_cxp
  alter column saldo_ves set not null,
  alter column saldo_usd set not null,
  add constraint partida_cxp_saldos check (saldo_ves >= 0 and saldo_usd >= 0 and saldo_usd <= monto_usd),
  add constraint partida_cxp_saldos_cero check (saldo > 0 or (saldo_ves = 0 and saldo_usd = 0));

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

-- ---------------------------------------------------------------------
-- Pagos (R-CA)
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('pago_proveedor', 'A', '', 1);

create table pago (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint not null unique,
  proveedor_id        uuid not null references proveedor(tercero_id),
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
  estado              text not null default 'solicitado' check (estado in ('solicitado', 'pagado', 'rechazado', 'anulado')),
  created_by          uuid not null references usuario(id),
  created_at          timestamptz not null default now(),
  aprobado_por        uuid references usuario(id),
  aprobado_at         timestamptz,
  rechazo_motivo      text,
  anulado_por         uuid references usuario(id),
  anulado_at          timestamptz,
  anulado_motivo      text,
  anulado_motivo_id   uuid references motivo(id),
  check (por_aplicar <= monto),
  check (estado not in ('pagado', 'anulado') or (aprobado_por is not null and aprobado_at is not null)),
  check ((estado = 'anulado') = (anulado_at is not null)),
  check (estado <> 'anulado' or (length(trim(coalesce(anulado_motivo, ''))) > 2 and anulado_motivo_id is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create index pago_proveedor_idx on pago (proveedor_id, estado);
create unique index pago_referencia_unica on pago (cuenta_bancaria_id, upper(trim(referencia)))
  where referencia is not null and estado in ('solicitado', 'pagado');

-- Lo que se pidió pagar de cada factura (inmutable): al aprobar, se convierte en aplicaciones.
create table pago_linea (
  id          uuid primary key default gen_random_uuid(),
  pago_id     uuid not null references pago(id),
  partida_id  uuid not null references partida_cxp(id),
  monto       numeric(16,2) not null check (monto > 0),         -- en la moneda del pago
  liquida     boolean not null default false,
  unique (pago_id, partida_id)
);

create table aplicacion_pago (
  id             uuid primary key default gen_random_uuid(),
  pago_id        uuid not null references pago(id),
  partida_id     uuid not null references partida_cxp(id),
  origen         text not null check (origen in ('registro', 'anticipo')),
  fecha          date not null,
  liquida        boolean not null default false,
  monto_pago     numeric(16,2) not null check (monto_pago > 0),
  -- Lo siguiente lo calcula la base de datos al insertar:
  tasa           numeric(18,6) not null check (tasa > 0),
  monto_partida  numeric(16,2) not null check (monto_partida > 0),   -- lo que cancela de la factura, en su moneda
  ves_partida    numeric(18,2) not null check (ves_partida >= 0),    -- su valor histórico en VES
  usd_partida    numeric(16,2) not null check (usd_partida >= 0),    -- su valor histórico en USD
  base_ves       numeric(18,2) not null check (base_ves >= 0),       -- valor en los libros de lo pagado
  base_usd       numeric(16,2) not null check (base_usd >= 0),
  revertida      boolean not null default false,
  created_by     uuid references usuario(id),
  created_at     timestamptz not null default now()
);
create index aplicacion_pago_pago_idx on aplicacion_pago (pago_id);
create index aplicacion_pago_partida_idx on aplicacion_pago (partida_id);

create function fn_pago_linea_antes() returns trigger
language plpgsql as $$
declare p pago%rowtype; c partida_cxp%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Lo solicitado en un pago no se modifica ni se borra: se rechaza o se anula el pago';
  end if;
  select * into p from pago where id = new.pago_id;
  if not found or p.estado <> 'solicitado' then
    raise exception 'Solo se agregan facturas a un pago solicitado';
  end if;
  select * into c from partida_cxp where id = new.partida_id;
  if not found or c.proveedor_id <> p.proveedor_id then
    raise exception 'La factura debe ser del mismo proveedor del pago';
  end if;
  if c.estado <> 'abierta' then
    raise exception 'La factura no tiene saldo por pagar';
  end if;
  return new;
end $$;
create trigger pago_linea_antes before insert or update or delete on pago_linea
  for each row execute function fn_pago_linea_antes();

create function fn_pago_antes() returns trigger
language plpgsql as $$
declare
  v_hoy     date := (now() at time zone 'America/Caracas')::date;
  v_cuenta  cuenta_bancaria%rowtype;
  v_estado  text;
  v_previo  text;
  v_aprob   uuid;
  a         aplicacion_pago%rowtype;
  v_interno boolean := coalesce(current_setting('app.cxp_interno', true), '') = '1';
begin
  if tg_op = 'DELETE' then
    raise exception 'Un pago no se borra: se rechaza o se anula';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'solicitado' then
      raise exception 'Un pago nace solicitado';
    end if;
    new.numero := fn_siguiente_numero('pago_proveedor', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un pago necesita el usuario que lo solicita';
    end if;
    if new.fecha > v_hoy then
      raise exception 'La fecha del pago no puede ser futura';
    end if;
    select * into v_cuenta from cuenta_bancaria where id = new.cuenta_bancaria_id;
    if not found or not v_cuenta.activa then
      raise exception 'La cuenta de donde sale el pago debe estar activa';
    end if;
    if new.moneda <> v_cuenta.moneda then
      raise exception 'La moneda del pago es la de la cuenta (%)', v_cuenta.moneda;
    end if;
    if not exists (select 1 from instrumento_pago where id = new.instrumento_id and activo) then
      raise exception 'El instrumento de pago debe estar activo';
    end if;
    select estado into v_estado from proveedor where tercero_id = new.proveedor_id;
    if v_estado is distinct from 'activo' then
      raise exception 'El proveedor debe estar activo para pagarle';
    end if;
    new.referencia := nullif(trim(new.referencia), '');
    -- La tasa BCV de la fecha, el valor en bolívares y el valor en USD los fija la base de datos.
    new.tasa := fn_tasa(new.moneda, new.fecha);
    new.monto_ves := round(new.monto * new.tasa, 2);
    new.monto_usd := case when new.moneda = 'USD' then new.monto else round(new.monto_ves / fn_tasa('USD', new.fecha), 2) end;
    new.por_aplicar := new.monto; new.por_aplicar_ves := new.monto_ves; new.por_aplicar_usd := new.monto_usd;
    new.aprobado_por := null; new.aprobado_at := null; new.anulado_por := null; new.anulado_at := null;
    return new;
  end if;

  -- UPDATE
  if (new.numero, new.proveedor_id, new.fecha, new.instrumento_id, new.cuenta_bancaria_id, new.referencia, new.moneda, new.tasa, new.monto,
      new.monto_ves, new.monto_usd, new.observaciones, new.created_by, new.created_at)
     is distinct from
     (old.numero, old.proveedor_id, old.fecha, old.instrumento_id, old.cuenta_bancaria_id, old.referencia, old.moneda, old.tasa, old.monto,
      old.monto_ves, old.monto_usd, old.observaciones, old.created_by, old.created_at) then
    raise exception 'Un pago solicitado no se edita: se rechaza o se anula con su motivo';
  end if;
  if (new.por_aplicar, new.por_aplicar_ves, new.por_aplicar_usd) is distinct from (old.por_aplicar, old.por_aplicar_ves, old.por_aplicar_usd)
     and not v_interno then
    raise exception 'Lo que falta por aplicar de un pago solo cambia con una aplicación';
  end if;
  v_aprob := new.aprobado_por;
  new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at;
  new.anulado_por := old.anulado_por; new.anulado_at := old.anulado_at;
  if new.estado = old.estado then
    new.rechazo_motivo := old.rechazo_motivo;
    new.anulado_motivo := old.anulado_motivo; new.anulado_motivo_id := old.anulado_motivo_id;
    return new;
  end if;

  if old.estado = 'solicitado' and new.estado = 'pagado' then
    -- R-CA: aprueba un usuario activo con el rol Gerencia que no solicitó el pago.
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar un pago';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien solicitó el pago no lo aprueba';
    end if;
    new.aprobado_at := now();
    return new;
  elsif old.estado = 'solicitado' and new.estado = 'rechazado' then
    if length(trim(coalesce(new.rechazo_motivo, ''))) < 3 then
      raise exception 'Indique el motivo del rechazo';
    end if;
    new.por_aplicar := 0; new.por_aplicar_ves := 0; new.por_aplicar_usd := 0;
    return new;
  elsif old.estado = 'pagado' and new.estado = 'anulado' then
    if length(trim(coalesce(new.anulado_motivo, ''))) < 3 then
      raise exception 'Indique el motivo de la anulación';
    end if;
    perform fn_motivo_valido(new.anulado_motivo_id, 'anulacion');
    if exists (select 1 from aplicacion_pago where pago_id = old.id and origen = 'anticipo' and not revertida) then
      raise exception 'Este pago tiene un anticipo ya aplicado a facturas: corrija esas aplicaciones antes de anularlo';
    end if;
    -- Las facturas recuperan su saldo (con el permiso interno, que se devuelve como estaba).
    v_previo := coalesce(current_setting('app.cxp_interno', true), '');
    perform set_config('app.cxp_interno', '1', true);
    for a in select * from aplicacion_pago where pago_id = old.id and not revertida loop
      update partida_cxp set saldo = saldo + a.monto_partida, saldo_ves = saldo_ves + a.ves_partida, saldo_usd = saldo_usd + a.usd_partida,
                             estado = 'abierta' where id = a.partida_id;
      update aplicacion_pago set revertida = true where id = a.id;
    end loop;
    perform set_config('app.cxp_interno', v_previo, true);
    new.por_aplicar := 0; new.por_aplicar_ves := 0; new.por_aplicar_usd := 0;
    new.anulado_por := coalesce(fn_usuario_actual(), new.anulado_por);
    new.anulado_at := now();
    return new;
  end if;
  raise exception 'Un pago % no pasa a %', old.estado, new.estado;
end $$;

create trigger pago_antes before insert or update or delete on pago
  for each row execute function fn_pago_antes();

create function fn_aplicacion_pago_antes() returns trigger
language plpgsql as $$
declare
  v_hoy    date := (now() at time zone 'America/Caracas')::date;
  c        pago%rowtype;
  p        partida_cxp%rowtype;
  v_ves    numeric;
  v_crudo  numeric;
  v_previo text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una aplicación de pago no se borra: se revierte al anular el pago';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'revertida') is distinct from (to_jsonb(old) - 'revertida') or old.revertida or not new.revertida
       or coalesce(current_setting('app.cxp_interno', true), '') <> '1' then
      raise exception 'Una aplicación de pago no se modifica';
    end if;
    return new;
  end if;

  select * into c from pago where id = new.pago_id for update;
  select * into p from partida_cxp where id = new.partida_id for update;
  if c.estado is distinct from 'pagado' then
    raise exception 'Solo se aplican pagos aprobados';
  end if;
  if p.proveedor_id <> c.proveedor_id then
    raise exception 'El pago y la factura son de proveedores distintos';
  end if;
  if p.estado <> 'abierta' then
    raise exception 'La factura no tiene saldo por pagar';
  end if;
  if new.origen = 'registro' and new.fecha <> c.fecha then
    raise exception 'La aplicación hecha al pagar lleva la fecha del pago';
  end if;
  if new.origen = 'anticipo' and new.fecha < c.fecha then
    raise exception 'La aplicación de un anticipo no puede ser anterior al pago';
  end if;
  if new.fecha > v_hoy then
    raise exception 'La fecha de la aplicación no puede ser futura';
  end if;
  if new.fecha < p.fecha then
    raise exception 'La aplicación no puede ser anterior a la fecha de la factura';
  end if;
  if new.monto_pago > c.por_aplicar then
    raise exception 'El pago solo tiene % por aplicar', c.por_aplicar;
  end if;

  -- Lo que cancela en la factura, en la moneda de la factura: misma moneda, sin conversión; otra, por la tasa BCV de la fecha.
  new.tasa := fn_tasa(c.moneda, new.fecha);
  if c.moneda = p.moneda then
    new.monto_partida := new.monto_pago;
  else
    v_ves := new.monto_pago * new.tasa;
    v_crudo := v_ves / fn_tasa(p.moneda, new.fecha);
    if new.liquida then
      if abs(v_crudo - p.saldo) > 0.01 then
        raise exception 'El pago no liquida la factura: % % equivalen a % %, y el saldo es %', new.monto_pago, c.moneda, round(v_crudo, 2), p.moneda, p.saldo;
      end if;
      new.monto_partida := p.saldo;
    else
      new.monto_partida := round(v_crudo, 2);
    end if;
  end if;
  if new.monto_partida <= 0 then
    raise exception 'El monto aplicado es demasiado pequeño para la factura';
  end if;
  if new.monto_partida > p.saldo then
    raise exception 'La aplicación (% %) excede el saldo de la factura (% %)', p.moneda, new.monto_partida, p.moneda, p.saldo;
  end if;
  -- Su valor histórico en VES y USD (el de la factura).
  if new.monto_partida = p.saldo then
    new.ves_partida := p.saldo_ves; new.usd_partida := p.saldo_usd;
  else
    new.ves_partida := round(p.saldo_ves * new.monto_partida / p.saldo, 2);
    new.usd_partida := round(p.saldo_usd * new.monto_partida / p.saldo, 2);
  end if;
  -- Valor en los libros de la parte del pago que se aplica: la proporción de lo que queda, o todo si se aplica lo último.
  if new.monto_pago = c.por_aplicar then
    new.base_ves := c.por_aplicar_ves; new.base_usd := c.por_aplicar_usd;
  else
    new.base_ves := round(c.por_aplicar_ves * new.monto_pago / c.por_aplicar, 2);
    new.base_usd := round(c.por_aplicar_usd * new.monto_pago / c.por_aplicar, 2);
  end if;
  new.revertida := false;
  new.created_by := coalesce(new.created_by, fn_usuario_actual());

  v_previo := coalesce(current_setting('app.cxp_interno', true), '');
  perform set_config('app.cxp_interno', '1', true);
  update pago set por_aplicar = por_aplicar - new.monto_pago, por_aplicar_ves = por_aplicar_ves - new.base_ves,
                  por_aplicar_usd = por_aplicar_usd - new.base_usd
   where id = c.id;
  update partida_cxp set saldo = saldo - new.monto_partida, saldo_ves = saldo_ves - new.ves_partida, saldo_usd = saldo_usd - new.usd_partida,
                         estado = case when saldo - new.monto_partida = 0 then 'cancelada' else 'abierta' end
   where id = p.id;
  perform set_config('app.cxp_interno', v_previo, true);
  return new;
end $$;

create trigger aplicacion_pago_antes before insert or update or delete on aplicacion_pago
  for each row execute function fn_aplicacion_pago_antes();

-- ---------------------------------------------------------------------
-- Flujo de aprobación: Gerencia, distinta de quien solicitó el pago (R-CA)
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values ('pago_proveedor', 'Pago a proveedor');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'pago_proveedor';

-- ---------------------------------------------------------------------
-- Reglas contables (§12.3), con importes dobles: la parte de cuentas por pagar vale lo que valía su factura y la diferencia con lo que
-- sale del banco va al diferencial cambiario (ganancia si se pagó menos de lo que se debía; pérdida si más).
-- ---------------------------------------------------------------------
insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('pago_proveedor',            1, 'D', '2.1.01', null,    'cxp',              'Cuentas por pagar a proveedores'),
    ('pago_proveedor',            2, 'D', '1.2.02', null,    'anticipo',         'Anticipo a proveedor'),
    ('pago_proveedor',            3, 'D', '6.3.02', null,    'dif_perdida_ves',  'Pérdida por diferencial cambiario (Bs)'),
    ('pago_proveedor',            4, 'D', '6.3.02', null,    'dif_perdida_usd',  'Pérdida por diferencial cambiario (USD)'),
    ('pago_proveedor',            5, 'H', null,     'banco', 'banco',            'Pago realizado'),
    ('pago_proveedor',            6, 'H', '4.2.01', null,    'dif_ganancia_ves', 'Ganancia por diferencial cambiario (Bs)'),
    ('pago_proveedor',            7, 'H', '4.2.01', null,    'dif_ganancia_usd', 'Ganancia por diferencial cambiario (USD)'),
    ('aplicacion_anticipo_pago',  1, 'D', '2.1.01', null,    'cxp',              'Cuentas por pagar a proveedores'),
    ('aplicacion_anticipo_pago',  2, 'D', '6.3.02', null,    'dif_perdida_ves',  'Pérdida por diferencial cambiario (Bs)'),
    ('aplicacion_anticipo_pago',  3, 'D', '6.3.02', null,    'dif_perdida_usd',  'Pérdida por diferencial cambiario (USD)'),
    ('aplicacion_anticipo_pago',  4, 'H', '1.2.02', null,    'anticipo',         'Anticipo a proveedor aplicado'),
    ('aplicacion_anticipo_pago',  5, 'H', '4.2.01', null,    'dif_ganancia_ves', 'Ganancia por diferencial cambiario (Bs)'),
    ('aplicacion_anticipo_pago',  6, 'H', '4.2.01', null,    'dif_ganancia_usd', 'Ganancia por diferencial cambiario (USD)')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;

create trigger pago_audit            after insert or update or delete on pago            for each row execute function fn_audit();
create trigger pago_linea_audit      after insert on pago_linea                          for each row execute function fn_audit();
create trigger aplicacion_pago_audit after insert or update or delete on aplicacion_pago for each row execute function fn_audit();
