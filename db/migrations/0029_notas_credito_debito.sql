-- =====================================================================
-- 0029 · Notas de crédito (devolución, pronto pago, descuento comercial, ajuste de precio) y de débito (§6.1, §6.2 regla 7, §12.3)
--
--   R-BV  Una nota de crédito o de débito siempre referencia la factura de origen. Va en bolívares, con los precios y las alícuotas de
--         la factura (no los del día de la nota). Nace en borrador, se envía a aprobación y la aprueba el Supervisor de ventas, nunca
--         quien la creó (motor de flujo); solo una nota aprobada se emite. Una vez enviada, sus líneas no se editan.
--   R-BW  Una devolución no puede devolver más de lo facturado menos lo que ya devolvieron otras notas vigentes (la base lo exige).
--   R-BX  Al emitirse, la nota de crédito reduce el saldo de la partida de su factura: lo hace el trigger de aplicacion_nota_credito, que
--         calcula también el valor en USD que deja de deberse. Una nota de crédito no supera el saldo de la factura. La nota de débito abre
--         su propia partida. Una nota emitida no se edita ni se anula: se corrige con otra nota.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tipos y datos propios de la nota en documento_venta
-- ---------------------------------------------------------------------
alter table documento_venta drop constraint documento_venta_tipo_check;
alter table documento_venta add constraint documento_venta_tipo_check check (tipo in ('pedido', 'nota_entrega', 'factura', 'nota_credito', 'nota_debito'));

-- La situación admite los pasos de aprobación de las notas.
do $$
declare r record;
begin
  for r in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'documento_venta'::regclass and contype = 'c' loop
    if r.def like '%retenido_credito%' and r.def like '%situacion%' then
      execute format('alter table documento_venta drop constraint %I', r.conname);
    end if;
  end loop;
end $$;
alter table documento_venta
  add constraint documento_venta_situacion_check check (
    situacion in ('retenido_credito', 'aprobado', 'pendiente_aprobacion', 'aprobada', 'rechazada')),
  add column motivo_nc    text check (motivo_nc in ('devolucion', 'pronto_pago', 'descuento_comercial', 'ajuste_precio', 'intereses', 'otro')),
  add column motivo_nc_id uuid references motivo(id),
  add column rechazo_motivo text,
  add constraint documento_venta_nota_origen check (tipo not in ('nota_credito', 'nota_debito') or documento_origen_id is not null),
  add constraint documento_venta_nota_motivo check (
    (tipo = 'nota_credito' and motivo_nc in ('devolucion', 'pronto_pago', 'descuento_comercial', 'ajuste_precio'))
    or (tipo = 'nota_debito' and motivo_nc in ('ajuste_precio', 'intereses', 'otro'))
    or (tipo not in ('nota_credito', 'nota_debito') and motivo_nc is null)),
  add constraint documento_venta_nota_situacion check (
    tipo in ('nota_credito', 'nota_debito') or situacion is null or situacion in ('retenido_credito', 'aprobado'));

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('nota_credito', 'A', '', 1), ('nota_debito', 'A', '', 1);
insert into motivo (tipo, codigo, nombre, sistema) values ('descuento', 'PRONTO_PAGO', 'Descuento por pronto pago', true);

-- Aprobación por el motor de flujo (§4.5): el Supervisor de ventas, distinto de quien la creó. Gerencia ajusta el flujo en Configuración.
insert into flujo_definicion (objeto_tipo, nombre) values ('nota_credito', 'Nota de crédito'), ('nota_debito', 'Nota de débito');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'supervisor_ventas' from flujo_definicion where objeto_tipo in ('nota_credito', 'nota_debito');

-- ---------------------------------------------------------------------
-- Cálculo: la nota de crédito conserva las alícuotas de su factura (no se vuelven a buscar a la fecha de hoy)
-- ---------------------------------------------------------------------
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

  if v_doc.tipo <> 'nota_credito' then
    update documento_venta_linea l set
      alicuota_pct = fn_alicuota_iva_pct(l.alicuota_iva_id, v_hoy)
     where l.documento_id = p_documento;
  end if;

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
-- Reglas del encabezado: se completan las de factura (0021) con las de las notas
-- ---------------------------------------------------------------------
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

-- Reglas propias de las notas: factura de origen, pasos de la aprobación y emisión solo de una nota aprobada.
create function fn_nota_antes() returns trigger
language plpgsql as $$
declare
  f documento_venta%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into f from documento_venta where id = new.documento_origen_id;
    if not found or f.tipo <> 'factura' or f.estado <> 'emitido' then
      raise exception 'La nota debe referenciar una factura emitida';
    end if;
    if f.cliente_id <> new.cliente_id then
      raise exception 'La nota debe ser del mismo cliente de la factura';
    end if;
    if new.moneda <> 'VES' then
      raise exception 'Las notas de crédito y de débito van en bolívares, como la factura';
    end if;
    if new.situacion is not null then
      raise exception 'Una nota nace sin situación: se envía a aprobación después';
    end if;
    return new;
  end if;

  if old.estado = 'borrador' then
    if old.situacion is not null and (new.motivo_nc, new.motivo_nc_id, new.documento_origen_id, new.cliente_id)
         is distinct from (old.motivo_nc, old.motivo_nc_id, old.documento_origen_id, old.cliente_id) then
      raise exception 'Una nota enviada a aprobación no cambia de factura ni de motivo';
    end if;
    if new.situacion is distinct from old.situacion then
      if (old.situacion, new.situacion) is not distinct from (null, 'pendiente_aprobacion') then
        if not exists (select 1 from documento_venta_linea where documento_id = old.id) or new.total <= 0 then
          raise exception 'Calcule la nota con al menos una línea antes de enviarla a aprobación';
        end if;
        if old.tipo = 'nota_credito' and new.motivo_nc_id is null then
          raise exception 'La nota de crédito necesita su motivo del catálogo';
        end if;
      elsif (old.situacion, new.situacion) = ('pendiente_aprobacion', 'aprobada') then
        if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'supervisor_ventas') then
          raise exception 'Solo un usuario activo con el rol Supervisor de ventas puede aprobar una nota de crédito o de débito';
        end if;
        if new.aprobado_por = old.created_by then
          raise exception 'Quien creó la nota no puede aprobarla';
        end if;
        new.aprobado_at := now();
      elsif (old.situacion, new.situacion) = ('pendiente_aprobacion', 'rechazada') then
        if length(trim(coalesce(new.rechazo_motivo, ''))) < 3 then
          raise exception 'Indique el motivo del rechazo';
        end if;
      else
        raise exception 'La nota no pasa de % a %', coalesce(old.situacion, 'borrador'), coalesce(new.situacion, 'borrador');
      end if;
    end if;
    if new.estado = 'emitido' and new.situacion is distinct from 'aprobada' then
      raise exception 'Solo se emite una nota aprobada por el Supervisor de ventas';
    end if;
  end if;
  return new;
end $$;

create trigger documento_venta_nota
  before insert or update on documento_venta
  for each row when (new.tipo in ('nota_credito', 'nota_debito'))
  execute function fn_nota_antes();

-- Las líneas de una nota: no se editan después de enviarla; una devolución no supera lo facturado menos lo ya devuelto (R-BW).
create function fn_nota_linea_antes() returns trigger
language plpgsql as $$
declare
  n documento_venta%rowtype;
  l documento_venta_linea%rowtype;
  v_devuelto numeric;
begin
  select * into n from documento_venta where id = coalesce(new.documento_id, old.documento_id);
  if not found or n.tipo not in ('nota_credito', 'nota_debito') then
    return coalesce(new, old);
  end if;
  if n.estado = 'borrador' and n.situacion is not null then
    raise exception 'La nota ya se envió a aprobación: sus líneas no se editan';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if n.tipo = 'nota_credito' then
    if new.linea_origen_id is null then
      raise exception 'Cada línea de una nota de crédito referencia la línea de la factura';
    end if;
    select * into l from documento_venta_linea where id = new.linea_origen_id;
    if not found or l.documento_id <> n.documento_origen_id then
      raise exception 'La línea no pertenece a la factura de la nota';
    end if;
    if new.producto_id <> l.producto_id then
      raise exception 'La línea de la nota debe ser del mismo producto que la de la factura';
    end if;
    if n.motivo_nc = 'devolucion' then
      select coalesce(sum(x.cantidad), 0) into v_devuelto
        from documento_venta_linea x join documento_venta d on d.id = x.documento_id
       where x.linea_origen_id = l.id and d.tipo = 'nota_credito' and d.motivo_nc = 'devolucion' and d.estado <> 'anulado'
         and d.situacion is distinct from 'rechazada' and x.id is distinct from new.id;
      if v_devuelto + new.cantidad > l.cantidad then
        raise exception 'Se devuelve más de lo facturado: de % se devolvió % y esta nota pide %', l.cantidad, v_devuelto, new.cantidad;
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger documento_venta_linea_nota
  before insert or update or delete on documento_venta_linea
  for each row execute function fn_nota_linea_antes();

-- ---------------------------------------------------------------------
-- Aplicación de la nota de crédito a la partida de su factura (R-BX)
-- ---------------------------------------------------------------------
create table aplicacion_nota_credito (
  id          uuid primary key default gen_random_uuid(),
  nota_id     uuid not null unique references documento_venta(id),
  partida_id  uuid not null references partida_cxc(id),
  monto       numeric(16,2) not null check (monto > 0),          -- bolívares que reduce de la factura
  usd         numeric(16,2) not null check (usd >= 0),           -- su valor en USD a la tasa de la factura (lo calcula la base)
  created_by  uuid references usuario(id),
  created_at  timestamptz not null default now()
);

create function fn_aplicacion_nota_credito_antes() returns trigger
language plpgsql as $$
declare
  n        documento_venta%rowtype;
  p        partida_cxc%rowtype;
  v_previo text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'La aplicación de una nota de crédito no se modifica ni se borra';
  end if;
  select * into n from documento_venta where id = new.nota_id for update;
  select * into p from partida_cxc where id = new.partida_id for update;
  if n.tipo is distinct from 'nota_credito' or n.estado <> 'emitido' then
    raise exception 'Solo se aplica una nota de crédito emitida';
  end if;
  if p.documento_id <> n.documento_origen_id then
    raise exception 'La nota de crédito se aplica a la partida de su factura';
  end if;
  if p.estado <> 'abierta' then
    raise exception 'La factura no tiene saldo por cobrar: la nota de crédito no puede reducirlo';
  end if;
  if new.monto <> n.total then
    raise exception 'La aplicación debe ser por el total de la nota (Bs. %)', n.total;
  end if;
  if new.monto > p.saldo then
    raise exception 'La nota de crédito (Bs. %) supera el saldo de la factura (Bs. %)', new.monto, p.saldo;
  end if;
  new.usd := case when new.monto = p.saldo then p.saldo_usd else round(p.saldo_usd * new.monto / p.saldo, 2) end;
  new.created_by := coalesce(new.created_by, fn_usuario_actual());

  v_previo := coalesce(current_setting('app.cxc_interno', true), '');
  perform set_config('app.cxc_interno', '1', true);
  update partida_cxc set saldo = saldo - new.monto, saldo_usd = saldo_usd - new.usd,
                         estado = case when saldo - new.monto = 0 then 'cancelada' else 'abierta' end
   where id = p.id;
  perform set_config('app.cxc_interno', v_previo, true);
  return new;
end $$;

create trigger aplicacion_nota_credito_antes
  before insert or update or delete on aplicacion_nota_credito
  for each row execute function fn_aplicacion_nota_credito_antes();

-- ---------------------------------------------------------------------
-- Reglas contables (§12.3). Las notas de crédito usan importes dobles: lo que sale de cuentas por cobrar vale lo que valía la factura.
-- ---------------------------------------------------------------------
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('nota_credito_devolucion', 1, 'D', '4.1.02', 'venta',   'Devoluciones en ventas'),
    ('nota_credito_devolucion', 2, 'D', '2.1.03', 'iva',     'IVA débito fiscal de la devolución'),
    ('nota_credito_devolucion', 3, 'H', '1.2.01', 'total',   'Cuentas por cobrar comerciales'),
    ('nota_credito_descuento',  1, 'D', '4.1.03', 'venta',   'Descuentos en ventas'),
    ('nota_credito_descuento',  2, 'D', '2.1.03', 'iva',     'IVA débito fiscal del descuento'),
    ('nota_credito_descuento',  3, 'H', '1.2.01', 'total',   'Cuentas por cobrar comerciales'),
    ('nota_debito_ajuste',      1, 'D', '1.2.01', 'total',   'Cuentas por cobrar comerciales'),
    ('nota_debito_ajuste',      2, 'H', '4.1.01', 'venta',   'Ajuste de ventas'),
    ('nota_debito_ajuste',      3, 'H', '2.1.03', 'iva',     'IVA débito fiscal'),
    ('nota_debito_otros',       1, 'D', '1.2.01', 'total',   'Cuentas por cobrar comerciales'),
    ('nota_debito_otros',       2, 'H', '4.2.02', 'venta',   'Otros ingresos'),
    ('nota_debito_otros',       3, 'H', '2.1.03', 'iva',     'IVA débito fiscal'),
    ('reingreso_devolucion',    1, 'D', '1.3.01', 'costo',   'Reingreso de la devolución al inventario'),
    ('reingreso_devolucion',    2, 'H', '5.1.01', 'costo',   'Costo de ventas de la mercancía devuelta')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger aplicacion_nota_credito_audit after insert or update or delete on aplicacion_nota_credito for each row execute function fn_audit();
