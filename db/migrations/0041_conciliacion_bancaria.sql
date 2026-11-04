-- =====================================================================
-- 0041 · Conciliación bancaria (spec §10.2)
--
--   R-CK  El estado de cuenta de un mes (extracto) se carga por cuenta bancaria, en CSV o a mano. Cada línea trae su monto con signo
--         (ingreso +, egreso −) en la moneda de la cuenta (VES o USD).
--   R-CL  Una línea del banco se empareja con UNA línea del mayor de esa cuenta (asiento_linea) del mismo monto; la línea del mayor
--         no puede emparejarse dos veces. Los pares los confirma una persona. Las líneas del mayor sin pareja quedan «en tránsito».
--   R-CM  Se cierra por mes y cuenta: sin líneas del banco pendientes y con el saldo del mayor igual al saldo del banco más lo que está
--         en tránsito. Quien empareja no cierra. Un extracto cerrado no se modifica; el cierre guarda sus cifras.
-- =====================================================================

create table parametro_conciliacion (
  codigo      text primary key,
  descripcion text not null,
  valor       numeric(12,4) not null check (valor >= 0),
  unidad      text not null
);
insert into parametro_conciliacion (codigo, descripcion, valor, unidad) values
  ('VENTANA_DIAS', 'Emparejamiento automático: diferencia de días aceptada entre la fecha del banco y la del asiento', 3, 'dias');
create trigger parametro_conciliacion_audit after insert or update or delete on parametro_conciliacion for each row execute function fn_audit();

create table extracto_bancario (
  id                  uuid primary key default gen_random_uuid(),
  cuenta_bancaria_id  uuid not null references cuenta_bancaria(id),
  anio                smallint not null check (anio between 2000 and 2100),
  mes                 smallint not null check (mes between 1 and 12),
  saldo_inicial       numeric(16,2) not null,
  saldo_final         numeric(16,2) not null,
  estado              text not null default 'abierto' check (estado in ('abierto', 'cerrado')),
  created_by          uuid not null references usuario(id),
  created_at          timestamptz not null default now(),
  cerrado_por         uuid references usuario(id),
  cerrado_at          timestamptz,
  -- Cifras del cierre (en la moneda de la cuenta)
  cierre_mayor        numeric(16,2),
  cierre_transito     numeric(16,2),
  unique (cuenta_bancaria_id, anio, mes),
  check ((estado = 'cerrado') = (cerrado_at is not null and cerrado_por is not null and cierre_mayor is not null and cierre_transito is not null))
);

create table extracto_linea (
  id              uuid primary key default gen_random_uuid(),
  extracto_id     uuid not null references extracto_bancario(id),
  fecha           date not null,
  descripcion     text not null check (length(trim(descripcion)) > 0),
  referencia      text,
  monto           numeric(16,2) not null check (monto <> 0),
  asiento_linea_id bigint unique references asiento_linea(id),
  conciliado_por  uuid references usuario(id),
  conciliado_at   timestamptz,
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  check ((asiento_linea_id is null) = (conciliado_por is null) and (asiento_linea_id is null) = (conciliado_at is null))
);
create index extracto_linea_extracto_idx on extracto_linea (extracto_id, fecha);

create function fn_extracto_antes() returns trigger
language plpgsql as $$
declare
  cb cuenta_bancaria%rowtype;
  v_pend int;
  v_fin date;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un extracto bancario no se borra';
  end if;
  if tg_op = 'INSERT' then
    select * into cb from cuenta_bancaria where id = new.cuenta_bancaria_id;
    if not found or not cb.activa or cb.tipo = 'caja' or cb.moneda not in ('VES', 'USD') then
      raise exception 'Solo se concilian cuentas bancarias activas en bolívares o dólares (no cajas)';
    end if;
    if new.estado <> 'abierto' then
      raise exception 'Un extracto nace abierto';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un extracto necesita el usuario que lo carga';
    end if;
    new.cerrado_por := null; new.cerrado_at := null; new.cierre_mayor := null; new.cierre_transito := null;
    return new;
  end if;

  if old.estado = 'cerrado' then
    raise exception 'Un extracto cerrado no se modifica';
  end if;
  if (to_jsonb(new) - 'saldo_inicial' - 'saldo_final' - 'estado' - 'cerrado_por' - 'cerrado_at' - 'cierre_mayor' - 'cierre_transito')
     is distinct from (to_jsonb(old) - 'saldo_inicial' - 'saldo_final' - 'estado' - 'cerrado_por' - 'cerrado_at' - 'cierre_mayor' - 'cierre_transito') then
    raise exception 'La cuenta y el mes de un extracto no se cambian';
  end if;
  if new.estado = 'cerrado' then
    select count(*) into v_pend from extracto_linea where extracto_id = old.id and asiento_linea_id is null;
    if v_pend > 0 then
      raise exception 'Quedan % líneas del banco sin conciliar', v_pend;
    end if;
    if exists (select 1 from extracto_linea where extracto_id = old.id and conciliado_por = new.cerrado_por) then
      raise exception 'Quien concilió líneas de este extracto no lo cierra';
    end if;
    if not (fn_tiene_rol(new.cerrado_por, 'contabilidad') or fn_tiene_rol(new.cerrado_por, 'jefe_contabilidad') or fn_tiene_rol(new.cerrado_por, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia cierran la conciliación';
    end if;
    if old.saldo_inicial + coalesce((select sum(monto) from extracto_linea where extracto_id = old.id), 0) <> old.saldo_final then
      raise exception 'El saldo inicial más los movimientos no da el saldo final del banco';
    end if;
    new.cerrado_at := now();
    return new;
  end if;
  return new;
end $$;
create trigger extracto_antes before insert or update or delete on extracto_bancario
  for each row execute function fn_extracto_antes();

create function fn_extracto_linea_antes() returns trigger
language plpgsql as $$
declare
  e   extracto_bancario%rowtype;
  cb  cuenta_bancaria%rowtype;
  l   record;
  v_fin date;
  v_monto numeric;
begin
  select * into e from extracto_bancario where id = coalesce(new.extracto_id, old.extracto_id);
  if e.estado <> 'abierto' then
    raise exception 'El extracto está cerrado: sus líneas no se modifican';
  end if;
  if tg_op = 'DELETE' then
    if old.asiento_linea_id is not null then
      raise exception 'Primero desconcilie la línea';
    end if;
    return old;
  end if;
  v_fin := (make_date(e.anio, e.mes, 1) + interval '1 month' - interval '1 day')::date;
  if tg_op = 'INSERT' then
    if new.fecha < make_date(e.anio, e.mes, 1) or new.fecha > v_fin then
      raise exception 'La fecha % no pertenece al mes del extracto', new.fecha;
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una línea necesita el usuario que la carga';
    end if;
    if new.asiento_linea_id is not null then
      raise exception 'Una línea nace sin conciliar';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'asiento_linea_id' - 'conciliado_por' - 'conciliado_at') is distinct from (to_jsonb(old) - 'asiento_linea_id' - 'conciliado_por' - 'conciliado_at') then
    raise exception 'Una línea del banco no se edita: elimínela y cárguela de nuevo';
  end if;
  if new.asiento_linea_id is null then
    new.conciliado_por := null; new.conciliado_at := null;
    return new;
  end if;
  if old.asiento_linea_id is not null and new.asiento_linea_id is distinct from old.asiento_linea_id then
    raise exception 'Primero desconcilie la línea';
  end if;
  if old.asiento_linea_id is null or new.asiento_linea_id <> old.asiento_linea_id then
    select * into cb from cuenta_bancaria where id = e.cuenta_bancaria_id;
    select l2.cuenta_id, a.fecha, a.estado,
           case when cb.moneda = 'USD' then l2.debe_usd - l2.haber_usd else l2.debe_ves - l2.haber_ves end as neto
      into l from asiento_linea l2 join asiento a on a.id = l2.asiento_id where l2.id = new.asiento_linea_id;
    if not found or l.cuenta_id <> cb.cuenta_contable_id then
      raise exception 'La línea del mayor no es de la cuenta contable de este banco';
    end if;
    if l.estado <> 'contabilizado' then
      raise exception 'Solo se concilia contra asientos contabilizados';
    end if;
    if l.fecha > v_fin then
      raise exception 'El asiento es posterior al mes del extracto: regístrelo en su mes';
    end if;
    if l.neto <> new.monto then
      raise exception 'El monto del banco (%) no es el del asiento (%)', new.monto, l.neto;
    end if;
    new.conciliado_por := coalesce(new.conciliado_por, fn_usuario_actual());
    if new.conciliado_por is null then
      raise exception 'La conciliación necesita el usuario que la hace';
    end if;
    new.conciliado_at := now();
  end if;
  return new;
end $$;
create trigger extracto_linea_antes before insert or update or delete on extracto_linea
  for each row execute function fn_extracto_linea_antes();

create trigger extracto_bancario_audit after insert or update or delete on extracto_bancario for each row execute function fn_audit();
create trigger extracto_linea_audit    after insert or update or delete on extracto_linea    for each row execute function fn_audit();
