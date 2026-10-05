-- =====================================================================
-- 0021 · Factura de venta con número de control, partida de cuentas por cobrar y su asiento (§6.1, §6.3, §11.1, §12.3)
--
--   R-AY  La factura fiscal va en bolívares (decisión 14): sale de una o más notas de entrega despachadas del mismo
--         cliente, con el precio en USD de la nota convertido a la tasa BCV del día. Una nota se factura completa
--         y una sola vez; al anular la factura, la nota queda libre.
--   R-AZ  Una factura emitida no se edita ni se borra. No se emite sin número de control, salvo en contingencia
--         registrada (con su motivo); el control pendiente se asigna después y es lo único que cambia.
--   R-BA  Cada factura abre su partida de cuentas por cobrar con su vencimiento; el saldo solo cambia por un cobro,
--         una nota de crédito o la anulación de la factura.
--   R-BB  El asiento de la factura (CxC contra ventas e IVA débito fiscal) sale del motor contable; anular la
--         factura genera el asiento inverso. El crédito del cliente cuenta las cuentas por cobrar abiertas.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('factura', 'A', '', 1),
  ('control_simulado', 'A', '', 1);

-- Se habilita el tipo factura. Las restricciones de columna se buscan por su definición.
do $$
declare r record;
begin
  for r in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'documento_venta'::regclass and contype = 'c' loop
    if r.def like '%ARRAY[''pedido''::text, ''nota_entrega''::text]%' or r.def like '%documento_origen_id IS NOT NULL%' then
      execute format('alter table documento_venta drop constraint %I', r.conname);
    end if;
  end loop;
end $$;

alter table documento_venta
  add constraint documento_venta_tipo_check check (tipo in ('pedido', 'nota_entrega', 'factura')),
  add constraint documento_venta_origen_check check (tipo <> 'nota_entrega' or (situacion is null and documento_origen_id is not null)),
  add column fecha_vencimiento  date,
  add column contingencia       boolean not null default false,
  add column contingencia_motivo text,
  add column imprenta           text,                                -- quién asignó el número de control (proveedor o simulador)
  add column factura_id         uuid references documento_venta(id), -- en una nota: la factura que la cubre
  add constraint documento_venta_factura_control check (tipo <> 'factura' or estado <> 'emitido' or numero_control is not null or contingencia),
  add constraint documento_venta_factura_nota check (factura_id is null or tipo = 'nota_entrega'),
  add constraint documento_venta_contingencia_motivo check (not contingencia or length(trim(coalesce(contingencia_motivo, ''))) > 2);
create index documento_venta_factura_idx on documento_venta (factura_id);

-- Motivo de anulación propio de la facturación.
insert into motivo (tipo, codigo, nombre) values ('anulacion', 'ERROR_FACTURACION', 'Error de facturación');

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

  -- Una factura en contingencia solo completa su número de control (R-AZ).
  if old.tipo = 'factura' and old.numero_control is null then
    v_libres := v_libres || array['numero_control', 'contingencia', 'contingencia_motivo', 'imprenta'];
  end if;

  -- Emitido: solo cambian el estado, la situación y los datos de aprobación, salida, factura o anulación.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Un documento emitido no se edita: se anula con su motivo o se corrige con otro documento';
  end if;
  if new.estado = 'borrador' then
    raise exception 'Un documento emitido no vuelve a borrador';
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

-- El cálculo sirve también para documentos en bolívares: sus precios ya están en VES y el equivalente en USD sale de la tasa.
create or replace function fn_venta_calcular(p_documento uuid) returns void
language plpgsql as $$
declare
  v_doc   documento_venta%rowtype;
  v_hoy   date := (now() at time zone 'America/Caracas')::date;
  v_tasa  numeric;
begin
  select * into v_doc from documento_venta where id = p_documento for update;
  if not found then
    raise exception 'El documento no existe';
  end if;
  if v_doc.estado <> 'borrador' then
    raise exception 'Solo se calculan los documentos en borrador';
  end if;

  update documento_venta_linea l set
    alicuota_pct = fn_alicuota_iva_pct(l.alicuota_iva_id, v_hoy)
   where l.documento_id = p_documento;

  update documento_venta_linea l set
    base  = round(l.cantidad * l.precio_unitario, 2) - round(l.cantidad * l.precio_unitario * l.descuento_pct / 100, 2),
    iva   = round((round(l.cantidad * l.precio_unitario, 2) - round(l.cantidad * l.precio_unitario * l.descuento_pct / 100, 2))
                  * l.alicuota_pct / 100, 2)
   where l.documento_id = p_documento;

  update documento_venta_linea set total = base + iva where documento_id = p_documento;

  v_tasa := fn_tasa('USD', v_hoy);

  update documento_venta d set
    subtotal       = coalesce(s.subtotal, 0),
    descuento      = coalesce(s.descuento, 0),
    base_imponible = coalesce(s.gravado, 0),
    exento         = coalesce(s.exento, 0),
    iva            = coalesce(s.iva, 0),
    total          = coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0),
    total_usd      = case when v_doc.moneda = 'VES'
                          then round((coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)) / v_tasa, 2)
                          else coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0) end,
    total_ves      = case when v_doc.moneda = 'VES'
                          then coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)
                          else round((coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)) * v_tasa, 2) end,
    tasa           = v_tasa
    from (select sum(round(l.cantidad * l.precio_unitario, 2)) as subtotal,
                 sum(round(l.cantidad * l.precio_unitario * l.descuento_pct / 100, 2)) as descuento,
                 sum(case when l.alicuota_pct > 0 then l.base else 0 end) as gravado,
                 sum(case when l.alicuota_pct = 0 then l.base else 0 end) as exento,
                 sum(l.iva) as iva
            from documento_venta_linea l where l.documento_id = p_documento) s
   where d.id = p_documento;
end $$;

-- ---------------------------------------------------------------------
-- Cuentas por cobrar: una partida por factura (§6.3). Los cobros y las notas de crédito se suman en su fase.
-- ---------------------------------------------------------------------
create table partida_cxc (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references cliente(tercero_id),
  documento_id    uuid not null unique references documento_venta(id),
  fecha           date not null,
  vencimiento     date not null,
  moneda          char(3) not null references moneda(codigo),
  tasa            numeric(18,6) not null check (tasa > 0),
  monto_original  numeric(16,2) not null check (monto_original > 0),
  monto_usd       numeric(16,2) not null check (monto_usd >= 0),
  saldo           numeric(16,2) not null check (saldo >= 0),
  estado          text not null default 'abierta' check (estado in ('abierta', 'cancelada', 'anulada')),
  created_at      timestamptz not null default now(),
  check (vencimiento >= fecha),
  check (saldo <= monto_original),
  check ((estado = 'abierta') = (saldo > 0))
);
create index partida_cxc_cliente_idx on partida_cxc (cliente_id, estado);

create function fn_partida_cxc_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una partida de cuentas por cobrar no se borra: se anula con su factura';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.cliente_id <> old.cliente_id or new.documento_id <> old.documento_id or new.fecha <> old.fecha or new.vencimiento <> old.vencimiento
     or new.moneda <> old.moneda or new.tasa <> old.tasa or new.monto_original <> old.monto_original or new.monto_usd <> old.monto_usd then
    raise exception 'Una partida de cuentas por cobrar solo cambia su saldo';
  end if;
  if (new.saldo <> old.saldo or new.estado <> old.estado) and coalesce(current_setting('app.cxc_interno', true), '') <> '1' then
    raise exception 'El saldo de una cuenta por cobrar solo cambia con un cobro, una nota de crédito o la anulación de su factura';
  end if;
  return new;
end $$;

create trigger partida_cxc_reglas
  before insert or update or delete on partida_cxc
  for each row execute function fn_partida_cxc_reglas();

-- ---------------------------------------------------------------------
-- Crédito: ahora cuenta las cuentas por cobrar abiertas, y una nota facturada ya no cuenta dos veces (R-BB).
-- ---------------------------------------------------------------------
create or replace function fn_exposicion_credito_usd(p_cliente uuid) returns numeric
language sql stable as $$
  select coalesce((select sum(round(p.monto_usd * p.saldo / p.monto_original, 2)) from partida_cxc p
                    where p.cliente_id = p_cliente and p.estado = 'abierta'), 0)
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

-- Reglas contables (§12.3), en la moneda de la factura. 'venta' es la base imponible más lo exento.
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('factura_venta',      1, 'D', '1.2.01', 'total', 'Cuentas por cobrar comerciales'),
    ('factura_venta',      2, 'H', '4.1.01', 'venta', 'Ventas de mercancía'),
    ('factura_venta',      3, 'H', '2.1.03', 'iva',   'IVA débito fiscal'),
    ('anulacion_factura',  1, 'D', '4.1.01', 'venta', 'Anulación de ventas'),
    ('anulacion_factura',  2, 'D', '2.1.03', 'iva',   'Anulación de IVA débito fiscal'),
    ('anulacion_factura',  3, 'H', '1.2.01', 'total', 'Anulación de cuentas por cobrar')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger partida_cxc_audit after insert or update on partida_cxc for each row execute function fn_audit();
