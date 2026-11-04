-- =====================================================================
-- 0037 · Retenciones de IVA e ISLR en las compras (spec §7.2 regla 4, §11.0, §11.2)
--
--   R-BX  Si la empresa es agente de retención, al contabilizar una factura de compra o un gasto de importación se retiene
--         al proveedor: la cuenta por pagar nace por el neto (total − retenciones) y el asiento acredita las cuentas
--         2.1.04 (IVA por enterar) y 2.1.05 (ISLR por enterar). Cada retención se guarda en retencion_compra con la base, el
--         porcentaje y el sustraendo aplicados, para reconstruir el asiento y los libros (§11.0). Los comprobantes con su
--         numeración propia y las declaraciones son de la Fase 4.
--   R-BY  Los porcentajes de IVA salen de parametro_fiscal (RET_IVA_GENERAL, RET_IVA_TOTAL) y la UT de UNIDAD_TRIBUTARIA, con
--         vigencia por fecha. Los porcentajes, mínimos y sustraendos de ISLR salen de concepto_islr_tarifa, que carga
--         Contabilidad: no se precarga normativa. Un agente de ISLR no contabiliza la factura de un proveedor con concepto
--         asignado si el concepto no tiene tarifa vigente para su tipo de persona (se pide cargarla, nunca se omite la retención).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Retención de IVA al 100 %: factura sin IVA discriminado, que no cumple requisitos o de un proveedor sin RIF. El sistema no
-- puede saberlo, lo indica quien registra (se guarda en el borrador).
-- ---------------------------------------------------------------------
alter table factura_compra     add column retencion_iva_total boolean not null default false;
alter table gasto_importacion  add column retencion_iva_total boolean not null default false;

-- ---------------------------------------------------------------------
-- Tarifas de ISLR por concepto (Decreto 1.808, art. 9), con vigencia. Mínimo y sustraendo en Unidades Tributarias.
--   retención = base × porcentaje − sustraendo (si la base llega al mínimo); nunca negativa.
-- ---------------------------------------------------------------------
create table concepto_islr_tarifa (
  id                    uuid primary key default gen_random_uuid(),
  concepto_id           uuid not null references concepto_islr(id),
  tipo_persona          char(1) not null check (tipo_persona in ('N', 'J')),
  domiciliado           boolean not null,
  porcentaje            numeric(7,4) not null check (porcentaje > 0 and porcentaje <= 100),
  base_minima_ut        numeric(12,4) not null default 0 check (base_minima_ut >= 0),
  sustraendo_ut         numeric(12,4) not null default 0 check (sustraendo_ut >= 0),
  vigente_desde         date not null,
  vigente_hasta         date,
  fuente_normativa      text,
  validado_por_contador boolean not null default false,
  created_by            uuid references usuario(id),
  created_at            timestamptz not null default now(),
  unique (concepto_id, tipo_persona, domiciliado, vigente_desde),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);

create function fn_concepto_islr_tarifa_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una tarifa de ISLR no se borra: se cierra su vigencia y se registra otra';
  end if;
  if tg_op = 'UPDATE' then
    -- Solo se cierra la vigencia o se marca como validada por el contador.
    if (to_jsonb(new) - 'vigente_hasta' - 'validado_por_contador') is distinct from (to_jsonb(old) - 'vigente_hasta' - 'validado_por_contador') then
      raise exception 'Una tarifa de ISLR no se edita: se cierra su vigencia y se registra otra';
    end if;
  else
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
  end if;
  if exists (
    select 1 from concepto_islr_tarifa t
     where t.concepto_id = new.concepto_id and t.tipo_persona = new.tipo_persona and t.domiciliado = new.domiciliado and t.id <> new.id
       and daterange(t.vigente_desde, coalesce(t.vigente_hasta, 'infinity'::date), '[]')
        && daterange(new.vigente_desde, coalesce(new.vigente_hasta, 'infinity'::date), '[]')
  ) then
    raise exception 'Ya hay una tarifa de ese concepto y tipo de persona cuya vigencia se solapa con la indicada';
  end if;
  return new;
end $$;

create trigger concepto_islr_tarifa_antes
  before insert or update or delete on concepto_islr_tarifa
  for each row execute function fn_concepto_islr_tarifa_antes();
create trigger concepto_islr_tarifa_audit after insert or update on concepto_islr_tarifa for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Retención practicada a un proveedor en una factura de compra o un gasto de importación. Inmutable.
-- ---------------------------------------------------------------------
create table retencion_compra (
  id            uuid primary key default gen_random_uuid(),
  factura_id    uuid references factura_compra(id),
  gasto_id      uuid references gasto_importacion(id),
  proveedor_id  uuid not null references proveedor(tercero_id),
  impuesto      text not null check (impuesto in ('iva', 'islr')),
  fecha         date not null,
  moneda        char(3) not null references moneda(codigo),
  tasa          numeric(18,6) not null check (tasa > 0),
  base          numeric(16,2) not null check (base > 0),   -- IVA: el IVA de la factura. ISLR: base sin IVA
  porcentaje    numeric(7,4) not null check (porcentaje > 0 and porcentaje <= 100),
  sustraendo    numeric(16,2) not null default 0 check (sustraendo >= 0),
  monto         numeric(16,2) not null check (monto > 0),
  monto_usd     numeric(16,2) not null check (monto_usd >= 0),
  iva_total     boolean not null default false,            -- IVA retenido al 100 %
  tarifa_id     uuid references concepto_islr_tarifa(id),
  created_at    timestamptz not null default now(),
  check ((factura_id is null) <> (gasto_id is null)),
  check ((impuesto = 'islr') = (tarifa_id is not null))
);
create unique index retencion_compra_factura_unica on retencion_compra (factura_id, impuesto) where factura_id is not null;
create unique index retencion_compra_gasto_unica   on retencion_compra (gasto_id, impuesto) where gasto_id is not null;
create index retencion_compra_proveedor_idx on retencion_compra (proveedor_id, fecha);

create function fn_retencion_compra_inmutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Una retención practicada no se modifica ni se borra: se corrige con una nota del proveedor';
end $$;
create trigger retencion_compra_inmutable before update or delete on retencion_compra
  for each row execute function fn_retencion_compra_inmutable();
create trigger retencion_compra_audit after insert on retencion_compra for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Reglas contables: la cuenta por pagar sale por el neto y las retenciones van a sus cuentas por enterar.
-- ---------------------------------------------------------------------
update regla_contable set importe = 'neto', glosa = 'Cuentas por pagar a proveedores (neto de retenciones)'
 where evento in ('factura_compra', 'gasto_importacion') and importe = 'total'
   and cuenta_id = (select id from cuenta_contable where codigo = '2.1.01');

insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('factura_compra',    8, 'H', '2.1.04', 'ret_iva',  'Retenciones de IVA por enterar'),
    ('factura_compra',    9, 'H', '2.1.05', 'ret_islr', 'Retenciones de ISLR por enterar'),
    ('gasto_importacion', 5, 'H', '2.1.04', 'ret_iva',  'Retenciones de IVA por enterar'),
    ('gasto_importacion', 6, 'H', '2.1.05', 'ret_islr', 'Retenciones de ISLR por enterar')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;
