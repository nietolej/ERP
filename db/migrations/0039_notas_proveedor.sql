-- =====================================================================
-- 0039 · Notas de crédito y de débito del proveedor y devolución de mercancía (spec §7.1, §7.2, §12.3)
--
--   R-CD  Una nota corrige una factura de compra contabilizada, no la edita: la factura queda igual. Nace PENDIENTE y no mueve nada;
--         la aprueba Gerencia (distinta de quien la registró). Al aprobarse, en la misma transacción: la mercancía devuelta sale del
--         inventario, el costo se ajusta, la cuenta por pagar se reduce (o nace la de la nota de débito), las retenciones se ajustan y
--         se contabiliza.
--   R-CE  La nota conserva la moneda y la tasa de la factura que corrige: así revierte exactamente lo que ella registró en bolívares y
--         en USD y no genera diferencial cambiario. Una nota de crédito no puede exceder el saldo por pagar de su factura.
--   R-CF  Si la factura tuvo retención, la nota ajusta cada retención en proporción a lo que corrige (IVA con el IVA de la nota; ISLR con
--         su base). La retención de una nota de crédito resta de lo retenido por enterar (signo −1); la de una de débito suma.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('nota_credito_proveedor', 'A', '', 1),
  ('nota_debito_proveedor',  'A', '', 1);

create table nota_proveedor (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint not null,
  tipo              text not null check (tipo in ('nota_credito', 'nota_debito')),
  clase             text not null check (clase in ('devolucion', 'ajuste_precio')),
  factura_id        uuid not null references factura_compra(id),
  proveedor_id      uuid not null references proveedor(tercero_id),
  numero_documento  varchar(40) not null check (length(trim(numero_documento)) > 0),   -- el de la nota del proveedor
  numero_control    varchar(40) not null check (length(trim(numero_control)) > 0),
  fecha             date not null,
  motivo            text not null check (length(trim(motivo)) > 2),
  moneda            char(3) not null references moneda(codigo),
  tasa              numeric(18,6) not null check (tasa > 0),
  base_imponible    numeric(16,2) not null default 0 check (base_imponible >= 0),
  exento            numeric(16,2) not null default 0 check (exento >= 0),
  iva               numeric(16,2) not null default 0 check (iva >= 0),
  total             numeric(16,2) not null check (total > 0),
  total_usd         numeric(16,2) not null check (total_usd >= 0),
  estado            text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  aprobado_por      uuid references usuario(id),
  aprobado_at       timestamptz,
  rechazo_motivo    text,
  unique (tipo, numero),
  check (tipo = 'nota_credito' or clase = 'ajuste_precio'),                          -- una nota de débito solo ajusta precio
  check (total = base_imponible + exento + iva),
  check (estado <> 'aprobada' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index nota_proveedor_documento_unico on nota_proveedor (proveedor_id, upper(trim(numero_documento))) where estado <> 'rechazada';
create index nota_proveedor_factura_idx on nota_proveedor (factura_id, estado);

create table nota_proveedor_linea (
  id                uuid primary key default gen_random_uuid(),
  nota_id           uuid not null references nota_proveedor(id),
  linea             int not null check (linea > 0),
  factura_linea_id  uuid not null references factura_compra_linea(id),
  producto_id       uuid not null references producto(id),
  descripcion       text not null,
  cantidad          numeric(14,4) check (cantidad > 0),                              -- solo en una devolución
  base              numeric(16,2) not null check (base > 0),                         -- lo que corrige, sin IVA, en la moneda de la factura
  alicuota_pct      numeric(6,2) not null check (alicuota_pct >= 0),
  iva               numeric(16,2) not null check (iva >= 0),
  unique (nota_id, factura_linea_id)
);

create function fn_nota_proveedor_linea_antes() returns trigger
language plpgsql as $$
declare v_n nota_proveedor%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Las líneas de una nota del proveedor no se modifican ni se borran';
  end if;
  select * into v_n from nota_proveedor where id = new.nota_id;
  if not found or v_n.estado <> 'pendiente' then
    raise exception 'Solo se agregan líneas a una nota pendiente';
  end if;
  if not exists (select 1 from factura_compra_linea where id = new.factura_linea_id and factura_id = v_n.factura_id and producto_id = new.producto_id) then
    raise exception 'La línea debe ser de la factura que corrige la nota';
  end if;
  return new;
end $$;
create trigger nota_proveedor_linea_antes before insert or update or delete on nota_proveedor_linea
  for each row execute function fn_nota_proveedor_linea_antes();

create function fn_nota_proveedor_antes() returns trigger
language plpgsql as $$
declare
  v_hoy date := (now() at time zone 'America/Caracas')::date;
  v_f   factura_compra%rowtype;
  v_aprob uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una nota del proveedor no se borra: se rechaza';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Una nota del proveedor nace pendiente';
    end if;
    select * into v_f from factura_compra where id = new.factura_id;
    if not found or v_f.estado <> 'contabilizada' then
      raise exception 'Solo se corrige una factura de compra contabilizada';
    end if;
    if v_f.proveedor_id <> new.proveedor_id then
      raise exception 'La nota debe ser del mismo proveedor de la factura';
    end if;
    if new.fecha > v_hoy then
      raise exception 'La fecha de la nota no puede ser futura';
    end if;
    if new.fecha < v_f.fecha_factura then
      raise exception 'La nota no puede ser anterior a la factura que corrige';
    end if;
    -- R-CE: la moneda y la tasa son las de la factura.
    new.moneda := v_f.moneda;
    new.tasa := v_f.tasa;
    new.numero := fn_siguiente_numero(case new.tipo when 'nota_credito' then 'nota_credito_proveedor' else 'nota_debito_proveedor' end, 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una nota del proveedor necesita el usuario que la registra';
    end if;
    new.aprobado_por := null; new.aprobado_at := null; new.rechazo_motivo := null;
    return new;
  end if;

  -- UPDATE
  if (to_jsonb(new) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo') is distinct from
     (to_jsonb(old) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo') then
    raise exception 'Una nota del proveedor no se edita: se rechaza o se registra otra';
  end if;
  if new.estado = old.estado then
    new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at; new.rechazo_motivo := old.rechazo_motivo;
    return new;
  end if;
  if old.estado <> 'pendiente' then
    raise exception 'Una nota % no cambia de estado', old.estado;
  end if;
  v_aprob := new.aprobado_por;
  if new.estado = 'aprobada' then
    -- R-CD: aprueba un usuario activo con el rol Gerencia que no registró la nota.
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar una nota del proveedor';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien registró la nota no la aprueba';
    end if;
    new.aprobado_at := now();
    new.rechazo_motivo := null;
    return new;
  elsif new.estado = 'rechazada' then
    new.aprobado_por := null; new.aprobado_at := null;
    return new;
  end if;
  raise exception 'Una nota pendiente solo se aprueba o se rechaza';
end $$;
create trigger nota_proveedor_antes before insert or update or delete on nota_proveedor
  for each row execute function fn_nota_proveedor_antes();

-- ---------------------------------------------------------------------
-- La cuenta por pagar y las retenciones también nacen de una nota
-- ---------------------------------------------------------------------
alter table partida_cxp
  add column nota_id uuid unique references nota_proveedor(id),
  drop constraint partida_cxp_origen,
  add constraint partida_cxp_origen check (((factura_id is not null)::int + (gasto_id is not null)::int + (nota_id is not null)::int) = 1);

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
     or new.nota_id is distinct from old.nota_id or new.fecha <> old.fecha or new.vencimiento <> old.vencimiento
     or new.moneda <> old.moneda or new.tasa <> old.tasa or new.monto_original <> old.monto_original or new.monto_usd <> old.monto_usd then
    raise exception 'Una partida de cuentas por pagar solo cambia su saldo';
  end if;
  if (new.saldo <> old.saldo or new.saldo_ves <> old.saldo_ves or new.saldo_usd <> old.saldo_usd or new.estado <> old.estado)
     and coalesce(current_setting('app.cxp_interno', true), '') <> '1' then
    raise exception 'El saldo de una cuenta por pagar solo cambia con un pago, una nota del proveedor o una retención';
  end if;
  return new;
end $$;

alter table retencion_compra add column nota_id uuid references nota_proveedor(id), add column signo smallint not null default 1 check (signo in (1, -1));
do $$
declare r record;
begin
  for r in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'retencion_compra'::regclass and contype = 'c' loop
    if r.def like '%factura_id IS NULL%' then
      execute format('alter table retencion_compra drop constraint %I', r.conname);
    end if;
  end loop;
end $$;
alter table retencion_compra add constraint retencion_compra_origen
  check (((factura_id is not null)::int + (gasto_id is not null)::int + (nota_id is not null)::int) = 1),
  add constraint retencion_compra_signo_nota check ((nota_id is not null) or signo = 1);
create unique index retencion_compra_nota_unica on retencion_compra (nota_id, impuesto) where nota_id is not null;

-- ---------------------------------------------------------------------
-- Flujo de aprobación: Gerencia, distinta de quien registró la nota (R-CD)
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values ('nota_proveedor', 'Nota de crédito o de débito del proveedor');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'nota_proveedor';

-- ---------------------------------------------------------------------
-- Reglas contables (§12.3), con importes dobles calculados con la tasa de la factura (R-CE).
--   Nota de crédito:  cxp (valor histórico), ret_iva y ret_islr (reducen lo retenido) · inventario (devolución: costo de lo que sale;
--                     ajuste: lo que corresponde a lo que sigue en existencia) · cv_haber / cv_debe (diferencia contra el costo de ventas)
--                     · iva (reduce el crédito fiscal)
--   Nota de débito:   inventario / costo_ventas / iva contra cuentas por pagar neto y las retenciones
-- ---------------------------------------------------------------------
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('nota_credito_proveedor', 1, 'D', '2.1.01', 'cxp',       'Cuentas por pagar a proveedores'),
    ('nota_credito_proveedor', 2, 'D', '2.1.04', 'ret_iva',   'Menor retención de IVA por enterar'),
    ('nota_credito_proveedor', 3, 'D', '2.1.05', 'ret_islr',  'Menor retención de ISLR por enterar'),
    ('nota_credito_proveedor', 4, 'D', '5.1.01', 'cv_debe',   'Costo de ventas: la mercancía devuelta costaba más que el crédito'),
    ('nota_credito_proveedor', 5, 'H', '1.3.01', 'inventario','Menor valor del inventario'),
    ('nota_credito_proveedor', 6, 'H', '5.1.01', 'cv_haber',  'Menor costo de ventas'),
    ('nota_credito_proveedor', 7, 'H', '1.2.03', 'iva',       'Menor IVA crédito fiscal'),
    ('nota_debito_proveedor',  1, 'D', '1.3.01', 'inventario',   'Mayor valor del inventario'),
    ('nota_debito_proveedor',  2, 'D', '5.1.01', 'costo_ventas', 'Mayor costo de ventas'),
    ('nota_debito_proveedor',  3, 'D', '1.2.03', 'iva',          'IVA crédito fiscal'),
    ('nota_debito_proveedor',  4, 'H', '2.1.01', 'neto',         'Cuentas por pagar a proveedores (neto de retenciones)'),
    ('nota_debito_proveedor',  5, 'H', '2.1.04', 'ret_iva',      'Retenciones de IVA por enterar'),
    ('nota_debito_proveedor',  6, 'H', '2.1.05', 'ret_islr',     'Retenciones de ISLR por enterar')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger nota_proveedor_audit        after insert or update or delete on nota_proveedor        for each row execute function fn_audit();
create trigger nota_proveedor_linea_audit  after insert on nota_proveedor_linea                      for each row execute function fn_audit();
