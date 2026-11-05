-- =====================================================================
-- 0042 · IGTF pagado en los pagos a proveedores (spec §11.3, §12.3)
--
--   R-CN  Un pago en divisas, con un instrumento que genera IGTF, a un proveedor contribuyente especial (agente de percepción) causa IGTF
--         a cargo de la empresa. Es un gasto financiero que no se recupera.
--   R-CO  El IGTF se paga APARTE: el banco sale por el pago más el IGTF; la deuda con el proveedor baja solo por el pago. Se calcula al
--         aprobar el pago, sobre el monto pagado en divisas, con el porcentaje vigente en parametro_fiscal (IGTF) a la fecha del pago.
--   R-CP  Cada IGTF queda inmutable con su base, porcentaje y montos; su asiento sale del motor. Anular el pago revierte también el IGTF.
-- =====================================================================

create table igtf_pago (
  id           uuid primary key default gen_random_uuid(),
  pago_id      uuid not null unique references pago(id),
  fecha        date not null,
  moneda       char(3) not null references moneda(codigo),
  tasa         numeric(18,6) not null check (tasa > 0),
  base         numeric(16,2) not null check (base > 0),
  porcentaje   numeric(7,4) not null check (porcentaje > 0 and porcentaje <= 100),
  monto        numeric(16,2) not null check (monto > 0),
  monto_ves    numeric(18,2) not null check (monto_ves > 0),
  monto_usd    numeric(16,2) not null check (monto_usd >= 0),
  revertido    boolean not null default false,
  created_at   timestamptz not null default now(),
  check (moneda <> 'VES')
);

create function fn_igtf_pago_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El IGTF pagado no se borra: se revierte al anular el pago';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'revertido') is distinct from (to_jsonb(old) - 'revertido') or old.revertido or not new.revertido then
      raise exception 'El IGTF pagado no se modifica: solo se revierte, una vez, al anular el pago';
    end if;
  end if;
  return new;
end $$;
create trigger igtf_pago_reglas before insert or update or delete on igtf_pago for each row execute function fn_igtf_pago_reglas();
create trigger igtf_pago_audit after insert or update or delete on igtf_pago for each row execute function fn_audit();

-- Gasto financiero contra el banco de donde salió el pago (cuenta variable, en la moneda del pago).
insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('igtf_pagado', 1, 'D', '6.3.01', null,    'monto', 'IGTF pagado (gasto financiero)'),
    ('igtf_pagado', 2, 'H', null,     'banco', 'monto', 'Salida del banco por el IGTF')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;
