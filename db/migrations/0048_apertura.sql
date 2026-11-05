-- =====================================================================
-- 0048 · Arranque en producción: saldos iniciales como operaciones (spec §14.2, §14.3, §14.6)
--
--   R-DG  Ningún dato se importa: cada saldo inicial es un documento de apertura registrado por una persona, contra la cuenta puente
--         «Saldos de apertura» (3.9.01). Esta migración trae bancos y cajas, cuentas por cobrar y cuentas por pagar factura por factura.
--   R-DH  Un documento de apertura nace PENDIENTE y no mueve nada. Lo registra su responsable y lo aprueba Gerencia, distinta de quien lo
--         registró. Al aprobarse, en una sola transacción, nace su saldo y su asiento, con la fecha de arranque.
--   R-DI  Gerencia fija la fecha de arranque una sola vez. La apertura se cierra cuando «Saldos de apertura» está en cero (en bolívares) y el mayor cuadra,
--         sin documentos pendientes. Cerrada, la base rechaza nuevos documentos y asientos de apertura.
--   R-DJ  Una factura de venta pendiente de apertura es una factura (tipo 'factura', serie AP, con su número y control originales) marcada
--         apertura = true: así cobros, antigüedad de saldos y estados de cuenta funcionan igual, pero queda fuera de los indicadores de
--         venta y de los libros de IVA (no se vende ni se declara dos veces).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fecha de arranque y cierre de la apertura
-- ---------------------------------------------------------------------
create table arranque (
  id              smallint primary key default 1 check (id = 1),
  fecha_arranque  date,
  fijada_por      uuid references usuario(id),
  fijada_at       timestamptz,
  cerrada_por     uuid references usuario(id),
  cerrada_at      timestamptz,
  check ((fecha_arranque is null) = (fijada_at is null) and (fijada_at is null) = (fijada_por is null)),
  check ((cerrada_at is null) = (cerrada_por is null)),
  check (cerrada_at is null or fecha_arranque is not null)
);
insert into arranque (id) values (1);

create function fn_arranque_antes() returns trigger
language plpgsql as $$
declare
  v_ves numeric;
  v_usd numeric;
  v_pend int;
  v_dif numeric;
begin
  if tg_op <> 'UPDATE' then
    raise exception 'El arranque no se crea ni se borra: se configura';
  end if;
  if old.fecha_arranque is not null and new.fecha_arranque is distinct from old.fecha_arranque then
    raise exception 'La fecha de arranque se fija una sola vez';
  end if;
  if old.fecha_arranque is null and new.fecha_arranque is not null then
    new.fijada_por := coalesce(new.fijada_por, fn_usuario_actual());
    if new.fijada_por is null or not fn_tiene_rol(new.fijada_por, 'gerencia') then
      raise exception 'Solo Gerencia fija la fecha de arranque';
    end if;
    new.fijada_at := now();
  end if;
  if old.cerrada_at is not null and (new.cerrada_at is distinct from old.cerrada_at or new.cerrada_por is distinct from old.cerrada_por) then
    raise exception 'La apertura ya está cerrada';
  end if;
  if old.cerrada_at is null and new.cerrada_por is not null then
    new.cerrada_por := coalesce(new.cerrada_por, fn_usuario_actual());
    if not fn_tiene_rol(new.cerrada_por, 'gerencia') then
      raise exception 'Solo Gerencia cierra la apertura';
    end if;
    if new.fecha_arranque is null then
      raise exception 'Fije primero la fecha de arranque';
    end if;
    select (select count(*) from apertura_banco where estado = 'pendiente') + (select count(*) from apertura_cxc where estado = 'pendiente')
         + (select count(*) from apertura_cxp where estado = 'pendiente') into v_pend;
    if v_pend > 0 then
      raise exception 'Quedan % documentos de apertura pendientes de Gerencia', v_pend;
    end if;
    select coalesce(sum(l.debe_ves - l.haber_ves), 0), coalesce(sum(l.debe_usd - l.haber_usd), 0) into v_ves, v_usd
      from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01';
    -- En bolívares: el residuo en dólares sale de mezclar tasas históricas con la del arranque y solo se informa (el mayor cuadra en cada moneda).
    if v_ves <> 0 then
      raise exception 'Saldos de apertura debe quedar en cero (hoy: Bs %): falta el asiento de apertura del contador', v_ves;
    end if;
    select abs(diferencia_ves) + abs(diferencia_usd) into v_dif from vw_control_cuadre;
    if coalesce(v_dif, 0) <> 0 then
      raise exception 'El mayor no cuadra: no se cierra la apertura';
    end if;
    new.cerrada_at := now();
  end if;
  return new;
end $$;
create trigger arranque_antes before insert or update or delete on arranque for each row execute function fn_arranque_antes();
create trigger arranque_audit after update on arranque for each row execute function fn_audit();

-- Cerrada la apertura, tampoco se aceptan asientos de apertura del contador.
create function fn_asiento_apertura_cerrada() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'apertura' and exists (select 1 from arranque where cerrada_at is not null) then
    raise exception 'La apertura está cerrada: no se registran más asientos de apertura';
  end if;
  return new;
end $$;
create trigger asiento_apertura_cerrada before insert on asiento for each row execute function fn_asiento_apertura_cerrada();

-- Cerrada la apertura, ninguna línea de asiento mueve «Saldos de apertura».
create function fn_linea_apertura_cerrada() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from arranque where cerrada_at is not null)
     and exists (select 1 from cuenta_contable where id = new.cuenta_id and codigo = '3.9.01') then
    raise exception 'La apertura está cerrada: «Saldos de apertura» ya no se mueve';
  end if;
  return new;
end $$;
create trigger asiento_linea_apertura_cerrada before insert on asiento_linea for each row execute function fn_linea_apertura_cerrada();

-- ---------------------------------------------------------------------
-- Facturas de venta de apertura (R-DJ)
-- ---------------------------------------------------------------------
alter table documento_venta add column apertura boolean not null default false;
alter table documento_venta add constraint documento_venta_apertura_factura check (not apertura or tipo = 'factura');
alter table documento_venta drop constraint documento_venta_factura_control;
alter table documento_venta add constraint documento_venta_factura_control
  check (tipo <> 'factura' or estado <> 'emitido' or numero_control is not null or contingencia or apertura);

-- La factura de apertura se emite sin líneas, con su número original y su fecha, y no se anula.
create or replace function fn_documento_venta_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'situacion', 'aprobado_por', 'aprobado_at', 'anulado_por', 'anulado_at', 'anulado_motivo',
                           'anulado_motivo_id', 'salida_at', 'salida_por', 'factura_id'];
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un documento de venta nace en borrador';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un documento de venta necesita el usuario que lo crea';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un documento emitido no se borra: se anula con su motivo';
    end if;
    return old;
  end if;

  if old.estado = 'borrador' then
    if new.estado = 'anulado' then
      raise exception 'Un borrador no se anula: se elimina';
    end if;
    if new.estado = 'emitido' then
      if old.apertura then
        if new.numero is null or new.fecha_emision is null then
          raise exception 'La factura de apertura necesita su número original y su fecha';
        end if;
        return new;
      end if;
      if not exists (select 1 from documento_venta_linea where documento_id = old.id) then
        raise exception 'No se puede emitir un documento sin líneas';
      end if;
      new.numero := fn_siguiente_numero(new.tipo, new.serie);
      new.fecha_emision := now();
    end if;
    return new;
  end if;

  if old.estado = 'anulado' then
    raise exception 'Un documento anulado no se modifica';
  end if;
  if old.apertura and new.estado = 'anulado' then
    raise exception 'Una factura de apertura no se anula: su saldo se corrige con el asiento del contador';
  end if;

  -- Una factura o una nota en contingencia solo completa su número de control (R-AZ).
  if old.tipo in ('factura', 'nota_credito', 'nota_debito') and old.numero_control is null then
    v_libres := v_libres || array['numero_control', 'contingencia', 'contingencia_motivo', 'imprenta'];
  end if;

  -- Emitido: solo cambian el estado, la situación y los datos de aprobación, salida, factura o anulación.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Un documento emitido no se edita: se anula con su motivo o se corrige con otro documento';
  end if;
  if new.estado = 'borrador' then
    raise exception 'Un documento emitido no vuelve a borrador';
  end if;
  if new.estado = 'anulado' and old.tipo in ('nota_credito', 'nota_debito') then
    raise exception 'Una nota de crédito o de débito emitida no se anula: se corrige con otra nota';
  end if;
  if new.estado = 'anulado' and old.tipo = 'factura'
     and exists (select 1 from documento_venta n where n.documento_origen_id = old.id and n.tipo in ('nota_credito', 'nota_debito') and n.estado <> 'anulado') then
    raise exception 'La factura tiene notas de crédito o de débito: no se anula, se corrige con otra nota';
  end if;
  if new.estado = 'anulado' and old.salida_at is not null then
    raise exception 'La mercancía de una nota de entrega despachada ya salió: no se anula, se corrige con una devolución';
  end if;
  if new.estado = 'anulado' and old.tipo = 'nota_entrega' and old.factura_id is not null then
    raise exception 'La nota de entrega está facturada: anule primero la factura';
  end if;
  if old.salida_at is not null and (new.salida_at is distinct from old.salida_at or new.salida_por is distinct from old.salida_por) then
    raise exception 'La salida de una nota de entrega no se modifica';
  end if;
  if new.estado = 'anulado' then
    perform fn_motivo_valido(new.anulado_motivo_id, 'anulacion');
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := coalesce(new.anulado_at, now());
  end if;
  return new;
end $$;

-- Una factura de apertura no es una venta del periodo: queda fuera de los indicadores (vw_venta_documento es su única fuente).
create or replace view vw_venta_documento as
select d.id,
       (d.fecha_emision at time zone 'America/Caracas')::date as fecha,
       d.cliente_id, d.vendedor_id, d.sucursal_id, d.moneda, d.tasa,
       case when d.moneda = 'VES' then round((d.base_imponible + d.exento) / d.tasa, 2) else d.base_imponible + d.exento end as base_usd,
       d.total_usd,
       coalesce(p.saldo_usd, 0) as saldo_usd,
       (p.id is not null and p.estado = 'cancelada') as cancelada,
       (select max(a.fecha) from aplicacion_cobro a where a.partida_id = p.id and a.liquida and not a.revertida) as fecha_cancelacion
  from documento_venta d
  left join partida_cxc p on p.documento_id = d.id
 where d.tipo = 'factura' and d.estado = 'emitido' and not d.apertura;

-- ---------------------------------------------------------------------
-- Documentos de apertura (pendientes hasta que Gerencia aprueba)
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('apertura_banco', 'A', '', 1), ('apertura_cxc', 'A', '', 1), ('apertura_cxp', 'A', '', 1);

create table apertura_banco (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint not null unique,
  cuenta_bancaria_id  uuid not null references cuenta_bancaria(id),
  fecha               date not null,
  moneda              char(3) not null references moneda(codigo),
  saldo               numeric(16,2) not null check (saldo > 0),            -- saldo del estado de cuenta del día anterior al arranque
  tasa                numeric(18,6) not null check (tasa > 0),
  saldo_ves           numeric(18,2) not null,
  saldo_usd           numeric(16,2) not null,
  referencia          text,
  estado              text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  created_by          uuid not null references usuario(id),
  created_at          timestamptz not null default now(),
  aprobado_por        uuid references usuario(id),
  aprobado_at         timestamptz,
  rechazo_motivo      text,
  check (estado <> 'aprobado' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index apertura_banco_cuenta_unica on apertura_banco (cuenta_bancaria_id) where estado <> 'rechazado';

create table apertura_cxc (
  id               uuid primary key default gen_random_uuid(),
  numero           bigint not null unique,
  cliente_id       uuid not null references cliente(tercero_id),
  sucursal_id      uuid not null references sucursal(id),
  numero_original  bigint not null check (numero_original > 0),             -- el de la factura en el sistema anterior
  numero_control   varchar(20),
  fecha_original   date not null,
  vencimiento      date not null,
  fecha            date not null,                                           -- fecha de arranque
  saldo            numeric(16,2) not null check (saldo > 0),                -- en bolívares (las facturas van en Bs, decisión 14)
  tasa             numeric(18,6) not null check (tasa > 0),                 -- bolívares por dólar de la fecha original
  saldo_usd        numeric(16,2) not null,
  documento_id     uuid unique references documento_venta(id),
  estado           text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  created_by       uuid not null references usuario(id),
  created_at       timestamptz not null default now(),
  aprobado_por     uuid references usuario(id),
  aprobado_at      timestamptz,
  rechazo_motivo   text,
  check (vencimiento >= fecha_original),
  check (fecha_original < fecha),
  check (estado <> 'aprobado' or (aprobado_por is not null and aprobado_at is not null and documento_id is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index apertura_cxc_factura_unica on apertura_cxc (numero_original) where estado <> 'rechazado';

create table apertura_cxp (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint not null unique,
  proveedor_id      uuid not null references proveedor(tercero_id),
  numero_documento  varchar(40) not null check (length(trim(numero_documento)) > 0),
  numero_control    varchar(40),
  fecha_original    date not null,
  vencimiento       date not null,
  fecha             date not null,
  moneda            char(3) not null check (moneda in ('VES', 'USD')),
  saldo             numeric(16,2) not null check (saldo > 0),               -- en la moneda de la factura
  tasa_usd          numeric(18,6) not null check (tasa_usd > 0),            -- bolívares por dólar de la fecha original
  tasa              numeric(18,6) not null check (tasa > 0),                -- bolívares por unidad de la moneda
  saldo_ves         numeric(18,2) not null,
  saldo_usd         numeric(16,2) not null,
  estado            text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  aprobado_por      uuid references usuario(id),
  aprobado_at       timestamptz,
  rechazo_motivo    text,
  check (vencimiento >= fecha_original),
  check (fecha_original < fecha),
  check (estado <> 'aprobado' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index apertura_cxp_factura_unica on apertura_cxp (proveedor_id, upper(trim(numero_documento))) where estado <> 'rechazado';

create function fn_apertura_antes() returns trigger
language plpgsql as $$
declare
  a      arranque%rowtype;
  cb     cuenta_bancaria%rowtype;
  v_usd  numeric;
  v_aprob uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un documento de apertura no se borra: se rechaza';
  end if;

  if tg_op = 'INSERT' then
    select * into a from arranque where id = 1;
    if a.fecha_arranque is null then
      raise exception 'Gerencia debe fijar primero la fecha de arranque';
    end if;
    if a.cerrada_at is not null then
      raise exception 'La apertura está cerrada: no se registran más documentos de apertura';
    end if;
    if new.estado <> 'pendiente' then
      raise exception 'Un documento de apertura nace pendiente';
    end if;
    new.fecha := a.fecha_arranque;
    new.numero := fn_siguiente_numero(tg_table_name, 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un documento de apertura necesita el usuario que lo registra';
    end if;
    new.aprobado_por := null; new.aprobado_at := null; new.rechazo_motivo := null;

    if tg_table_name = 'apertura_banco' then
      select * into cb from cuenta_bancaria where id = new.cuenta_bancaria_id;
      if not found or not cb.activa then
        raise exception 'La cuenta bancaria debe existir y estar activa';
      end if;
      new.moneda := cb.moneda;
      new.tasa := fn_tasa(cb.moneda, new.fecha);
      v_usd := fn_tasa('USD', new.fecha);
      new.saldo_ves := round(new.saldo * new.tasa, 2);
      new.saldo_usd := case when cb.moneda = 'USD' then new.saldo else round(new.saldo_ves / v_usd, 2) end;
    elsif tg_table_name = 'apertura_cxc' then
      if not exists (select 1 from cliente where tercero_id = new.cliente_id and estado = 'activo') then
        raise exception 'El cliente debe estar activo';
      end if;
      new.saldo_usd := round(new.saldo / new.tasa, 2);
    elsif tg_table_name = 'apertura_cxp' then
      if not exists (select 1 from proveedor where tercero_id = new.proveedor_id and estado = 'activo') then
        raise exception 'El proveedor debe estar activo';
      end if;
      new.tasa := case when new.moneda = 'USD' then new.tasa_usd else 1 end;
      new.saldo_ves := round(new.saldo * new.tasa, 2);
      new.saldo_usd := case when new.moneda = 'USD' then new.saldo else round(new.saldo / new.tasa_usd, 2) end;
    end if;
    return new;
  end if;

  if (to_jsonb(new) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo' - 'documento_id')
     is distinct from (to_jsonb(old) - 'estado' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo' - 'documento_id') then
    raise exception 'Un documento de apertura no se edita: se rechaza y se registra otro';
  end if;
  if new.estado = old.estado then
    new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at; new.rechazo_motivo := old.rechazo_motivo;
    return new;
  end if;
  if old.estado <> 'pendiente' then
    raise exception 'Un documento de apertura % no cambia de estado', old.estado;
  end if;
  v_aprob := new.aprobado_por;
  if new.estado = 'aprobado' then
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar un documento de apertura';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien registró el documento de apertura no lo aprueba';
    end if;
    new.aprobado_at := now();
    new.rechazo_motivo := null;
    return new;
  elsif new.estado = 'rechazado' then
    new.aprobado_por := null; new.aprobado_at := null;
    return new;
  end if;
  raise exception 'Un documento de apertura pendiente solo se aprueba o se rechaza';
end $$;
create trigger apertura_banco_antes before insert or update or delete on apertura_banco for each row execute function fn_apertura_antes();
create trigger apertura_cxc_antes   before insert or update or delete on apertura_cxc   for each row execute function fn_apertura_antes();
create trigger apertura_cxp_antes   before insert or update or delete on apertura_cxp   for each row execute function fn_apertura_antes();

-- La cuenta por pagar de apertura comparte la partida con las facturas de proveedor.
alter table partida_cxp
  add column apertura_cxp_id uuid unique references apertura_cxp(id),
  drop constraint partida_cxp_origen,
  add constraint partida_cxp_origen check (
    ((factura_id is not null)::int + (gasto_id is not null)::int + (nota_id is not null)::int + (gasto_proveedor_id is not null)::int + (apertura_cxp_id is not null)::int) = 1);

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
     or new.nota_id is distinct from old.nota_id or new.gasto_proveedor_id is distinct from old.gasto_proveedor_id or new.apertura_cxp_id is distinct from old.apertura_cxp_id
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

-- Flujo de aprobación: Gerencia, distinta de quien registró (R-DH)
insert into flujo_definicion (objeto_tipo, nombre) values
  ('apertura_banco', 'Saldo inicial de banco o caja'), ('apertura_cxc', 'Factura de venta pendiente (apertura)'), ('apertura_cxp', 'Factura de compra pendiente (apertura)');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo in ('apertura_banco', 'apertura_cxc', 'apertura_cxp');

-- Reglas contables (§12.3). Importes dobles: el valor en bolívares y en USD de cada saldo es el de su fecha original, no el de hoy.
insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('apertura_banco', 1, 'D', null,     'banco', 'monto', 'Saldo inicial de banco o caja'),
    ('apertura_banco', 2, 'H', '3.9.01', null,    'monto', 'Saldos de apertura'),
    ('apertura_cxc',   1, 'D', '1.2.01', null,    'monto', 'Factura pendiente de cobro (apertura)'),
    ('apertura_cxc',   2, 'H', '3.9.01', null,    'monto', 'Saldos de apertura'),
    ('apertura_cxp',   1, 'D', '3.9.01', null,    'monto', 'Saldos de apertura'),
    ('apertura_cxp',   2, 'H', '2.1.01', null,    'monto', 'Factura pendiente de pago (apertura)')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;

create trigger apertura_banco_audit after insert or update on apertura_banco for each row execute function fn_audit();
create trigger apertura_cxc_audit   after insert or update on apertura_cxc   for each row execute function fn_audit();
create trigger apertura_cxp_audit   after insert or update on apertura_cxp   for each row execute function fn_audit();
