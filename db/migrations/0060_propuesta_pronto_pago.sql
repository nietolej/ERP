alter table documento_venta
  add column aplicacion_pronto_pago_id uuid references aplicacion_cobro(id),
  add column descuento_pronto_pago_pct numeric(5,2),
  add column dias_pronto_pago smallint,
  add constraint documento_venta_aplicacion_pronto_pago_chk check (
    aplicacion_pronto_pago_id is null or (tipo = 'nota_credito' and motivo_nc = 'pronto_pago')
  );

alter table aplicacion_cobro add column saldo_tras_aplicar numeric(16,2);

-- Los triggers del mismo tipo se ejecutan por nombre: el de la aplicación ya actualizó la partida.
create function fn_capturar_saldo_pronto_pago() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    select saldo into new.saldo_tras_aplicar from partida_cxc where id = new.partida_id;
  elsif new.saldo_tras_aplicar is distinct from old.saldo_tras_aplicar then
    raise exception 'El saldo histórico de la aplicación no se puede cambiar.';
  end if;
  return new;
end $$;

create trigger capturar_saldo_pronto_pago before insert or update on aplicacion_cobro
  for each row execute function fn_capturar_saldo_pronto_pago();

create function fn_congelar_datos_pronto_pago() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.tipo = 'factura' then
    select descuento_pronto_pago_pct, dias_pronto_pago
      into new.descuento_pronto_pago_pct, new.dias_pronto_pago
      from condicion_pago where id = new.condicion_pago_id;
  elsif tg_op = 'UPDATE' and old.estado <> 'borrador' and
    (new.descuento_pronto_pago_pct, new.dias_pronto_pago, new.aplicacion_pronto_pago_id)
    is distinct from (old.descuento_pronto_pago_pct, old.dias_pronto_pago, old.aplicacion_pronto_pago_id) then
    raise exception 'Los datos de pronto pago de un documento emitido no se pueden cambiar.';
  end if;
  return new;
end $$;

create trigger congelar_datos_pronto_pago before insert or update on documento_venta
  for each row execute function fn_congelar_datos_pronto_pago();

create unique index documento_venta_pronto_pago_vigente_uq
  on documento_venta (documento_origen_id)
  where aplicacion_pronto_pago_id is not null and situacion is distinct from 'rechazada';
