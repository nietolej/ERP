-- =====================================================================
-- 0045 · Comprobantes de retención de IVA e ISLR (spec §11.2)
--
--   R-CX  Cada retención practicada a una factura de compra, gasto de importación o factura de gasto tiene UN comprobante, con su propia
--         numeración. El comprobante nace de una retención ya guardada (inmutable) y no se edita ni se borra.
--   R-CY  Número de 14 caracteres: AAAAMM del periodo de la retención + correlativo de 8 dígitos. Correlativo por impuesto y periodo, sin
--         huecos: se asigna en la misma transacción que el comprobante, con bloqueo de fila en el numerador.
--   R-CZ  Lo emite Contabilidad, Jefe de contabilidad o Gerencia, por lotes del mes. Las retenciones que revierte una nota de crédito del
--         proveedor (signo −1) no se numeran: quedan como ajustes por emitir hasta que el contador confirme cómo se documentan.
-- =====================================================================

create table comprobante_retencion (
  id            uuid primary key default gen_random_uuid(),
  retencion_id  uuid not null unique references retencion_compra(id),
  impuesto      text not null check (impuesto in ('iva', 'islr')),
  periodo       char(6) not null check (periodo ~ '^[0-9]{6}$'),          -- AAAAMM de la fecha de la retención
  numero        char(14) not null check (numero ~ '^[0-9]{14}$'),
  proveedor_id  uuid not null references proveedor(tercero_id),
  fecha_emision date not null,
  emitido_por   uuid not null references usuario(id),
  emitido_at    timestamptz not null default now(),
  unique (impuesto, numero),
  check (substr(numero, 1, 6) = periodo)
);
create index comprobante_retencion_periodo_idx on comprobante_retencion (impuesto, periodo);

create function fn_comprobante_retencion_antes() returns trigger
language plpgsql as $$
declare
  r record;
  v_n bigint;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Un comprobante de retención no se modifica ni se borra';
  end if;
  select * into r from retencion_compra where id = new.retencion_id;
  if not found then
    raise exception 'La retención no existe';
  end if;
  if r.nota_id is not null or r.signo <> 1 then
    raise exception 'Las retenciones que revierte una nota de crédito no se numeran todavía: quedan como ajustes por emitir';
  end if;
  new.emitido_por := coalesce(new.emitido_por, fn_usuario_actual());
  if new.emitido_por is null
     or not (fn_tiene_rol(new.emitido_por, 'contabilidad') or fn_tiene_rol(new.emitido_por, 'jefe_contabilidad') or fn_tiene_rol(new.emitido_por, 'gerencia')) then
    raise exception 'Solo Contabilidad o Gerencia emiten comprobantes de retención';
  end if;
  new.impuesto := r.impuesto;
  new.proveedor_id := r.proveedor_id;
  new.periodo := to_char(r.fecha, 'YYYYMM');
  new.fecha_emision := coalesce(new.fecha_emision, (now() at time zone 'America/Caracas')::date);
  -- Correlativo por impuesto y periodo (AAAAMM): el numerador de esa serie se crea al primer uso y se bloquea al asignar.
  insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('comprobante_retencion_' || r.impuesto, new.periodo, '', 1)
    on conflict (tipo_documento, serie) do nothing;
  v_n := fn_siguiente_numero('comprobante_retencion_' || r.impuesto, new.periodo);
  if v_n > 99999999 then
    raise exception 'Se agotó el correlativo de comprobantes del periodo %', new.periodo;
  end if;
  new.numero := new.periodo || lpad(v_n::text, 8, '0');
  return new;
end $$;
create trigger comprobante_retencion_antes before insert or update or delete on comprobante_retencion
  for each row execute function fn_comprobante_retencion_antes();

create trigger comprobante_retencion_audit after insert on comprobante_retencion for each row execute function fn_audit();
