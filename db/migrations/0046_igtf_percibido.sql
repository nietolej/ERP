-- =====================================================================
-- 0046 · IGTF percibido en los cobros (spec §11.3, §12.3)
--
--   R-DA  Un cobro en divisas (cuenta en divisas), con un instrumento que genera IGTF, de una empresa agente de percepción (empresa.
--         agente_percepcion_igtf) causa IGTF a cargo del cliente, que la empresa percibe y debe enterar.
--   R-DB  El IGTF se percibe APARTE, además del cobro: el cobro y sus aplicaciones no cambian. Se calcula al registrar el cobro, sobre el
--         monto cobrado en divisas, con el porcentaje de parametro_fiscal (IGTF) vigente a su fecha. Es un pasivo (2.1.06), no un ingreso.
--   R-DC  Cada IGTF percibido queda inmutable con su base, porcentaje y montos; su asiento sale del motor. Anular el cobro lo revierte.
--         El IGTF no entra en la base del IVA ni en sus libros: tiene su propio reporte.
-- =====================================================================

create table igtf_cobro (
  id           uuid primary key default gen_random_uuid(),
  cobro_id     uuid not null unique references cobro(id),
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

create function fn_igtf_cobro_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El IGTF percibido no se borra: se revierte al anular el cobro';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'revertido') is distinct from (to_jsonb(old) - 'revertido') or old.revertido or not new.revertido then
      raise exception 'El IGTF percibido no se modifica: solo se revierte, una vez, al anular el cobro';
    end if;
  end if;
  return new;
end $$;
create trigger igtf_cobro_reglas before insert or update or delete on igtf_cobro for each row execute function fn_igtf_cobro_reglas();
create trigger igtf_cobro_audit after insert or update or delete on igtf_cobro for each row execute function fn_audit();

-- Entra al banco donde se cobró (cuenta variable, en la moneda del cobro) contra el pasivo «IGTF percibido por enterar».
insert into regla_contable (evento, orden, lado, cuenta_id, cuenta_variable, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.variable, v.importe, v.glosa
  from (values
    ('igtf_percibido', 1, 'D', null,     'banco', 'monto', 'IGTF percibido que entró al banco'),
    ('igtf_percibido', 2, 'H', '2.1.06', null,    'monto', 'IGTF percibido por enterar')) as v(evento, orden, lado, codigo, variable, importe, glosa)
  left join cuenta_contable c on c.codigo = v.codigo;
