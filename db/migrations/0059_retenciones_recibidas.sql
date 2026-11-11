-- =====================================================================
-- 0059 · Retenciones de IVA e ISLR que nos practican los clientes (§6.3, §11.2, §11.4; decisiones del 10-11-2026)
--
--   R-RR1  La retención recibida es un documento propio: el comprobante del cliente aplicado a una factura o nota de débito
--          emitida en bolívares. Se registra antes, junto o después del cobro y reduce el saldo de la cuenta por cobrar, a su
--          valor histórico en USD (como una nota de crédito). Un comprobante puede cubrir varios documentos: una fila por documento.
--   R-RR2  IVA: el monto lo calcula la base = IVA sujeto × porcentaje vigente (RET_IVA_GENERAL o RET_IVA_TOTAL de
--          parametro_fiscal a la fecha del comprobante); el IVA sujeto no pasa del IVA del documento. ISLR: monto indicado, no mayor
--          que la base, que no pasa de la base imponible del documento. Una retención vigente por documento e impuesto.
--   R-RR3  Periodo en que se descuenta el IVA retenido: el mes del comprobante; si ese mes ya está declarado al registrarlo, el mes
--          en que se registra. Lo fija la base.
--   R-RR4  No se edita: se anula con motivo, salvo que su periodo de IVA ya esté declarado. Al anularla la cuenta por cobrar
--          recupera su saldo. Un documento con retenciones vigentes no se anula.
--   R-RR5  Declaración de IVA: las retenciones recibidas del periodo más las que trae el mes anterior se restan de la cuota; lo que
--          sobra se traslada al mes siguiente (declaracion_fiscal.retenciones_siguiente).
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('retencion_venta', 'A', '', 1);

create table retencion_venta (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint not null unique,                              -- correlativo interno del registro
  impuesto           text not null check (impuesto in ('iva', 'islr')),
  cliente_id         uuid not null references cliente(tercero_id),
  documento_id       uuid not null references documento_venta(id),        -- factura o nota de débito
  partida_id         uuid not null references partida_cxc(id),
  numero_comprobante varchar(20) not null check (length(trim(numero_comprobante)) > 0),
  fecha_comprobante  date not null,
  periodo            date not null,                                       -- primer día del mes en que se declara (lo fija la base)
  base               numeric(16,2) not null check (base > 0),             -- Bs: IVA sujeto (IVA) o base imponible (ISLR)
  porcentaje         numeric(6,2) not null check (porcentaje > 0 and porcentaje <= 100),
  monto              numeric(16,2) not null check (monto > 0),            -- Bs retenidos
  usd                numeric(16,2) not null default 0 check (usd >= 0),   -- su valor en USD a la tasa del documento (lo calcula la base)
  estado             text not null default 'registrada' check (estado in ('registrada', 'anulada')),
  observaciones      text,
  anulado_por        uuid references usuario(id),
  anulado_at         timestamptz,
  anulado_motivo     text,
  created_by         uuid not null references usuario(id),
  created_at         timestamptz not null default now(),
  check (monto <= base),
  check (periodo = date_trunc('month', periodo)::date),
  check (estado <> 'anulada' or length(trim(coalesce(anulado_motivo, ''))) > 2),
  unique (cliente_id, impuesto, numero_comprobante, documento_id)
);
create unique index retencion_venta_vigente on retencion_venta (documento_id, impuesto) where estado = 'registrada';
create index retencion_venta_periodo_idx on retencion_venta (impuesto, periodo) where estado = 'registrada';
create index retencion_venta_cliente_idx on retencion_venta (cliente_id);

create function fn_retencion_venta_antes() returns trigger
language plpgsql as $$
declare
  d        documento_venta%rowtype;
  p        partida_cxc%rowtype;
  v_hoy    date := (now() at time zone 'America/Caracas')::date;
  v_pct    numeric;
  v_previo text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una retención recibida no se borra: se anula con su motivo';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'registrada' then
      raise exception 'Una retención recibida nace registrada';
    end if;
    select * into d from documento_venta where id = new.documento_id;
    if not found or d.tipo not in ('factura', 'nota_debito') or d.estado <> 'emitido' then
      raise exception 'La retención se aplica a una factura o nota de débito emitida';
    end if;
    if d.cliente_id <> new.cliente_id then
      raise exception 'El documento retenido es de otro cliente';
    end if;
    select * into p from partida_cxc where documento_id = d.id for update;
    if not found then
      raise exception 'El documento no tiene cuenta por cobrar';
    end if;
    if p.moneda <> 'VES' then
      raise exception 'Solo se retiene sobre documentos fiscales en bolívares';
    end if;
    new.partida_id := p.id;
    if exists (select 1 from retencion_venta where documento_id = d.id and impuesto = new.impuesto and estado = 'registrada') then
      raise exception 'El documento ya tiene su retención de % registrada: anúlela si hay que corregirla', upper(new.impuesto);
    end if;
    if new.fecha_comprobante > v_hoy then
      raise exception 'La fecha del comprobante no puede ser futura';
    end if;
    if new.fecha_comprobante < (d.fecha_emision at time zone 'America/Caracas')::date then
      raise exception 'El comprobante no puede ser anterior al documento retenido';
    end if;

    if new.impuesto = 'iva' then
      if not exists (select 1 from tercero where id = new.cliente_id and agente_retencion_iva) then
        raise exception 'El cliente no está marcado como agente de retención de IVA: corrija su ficha antes de registrar el comprobante';
      end if;
      if new.base > d.iva then
        raise exception 'El IVA sujeto a retención (Bs. %) supera el IVA del documento (Bs. %)', new.base, d.iva;
      end if;
      if new.porcentaje not in (fn_parametro_fiscal('RET_IVA_GENERAL', new.fecha_comprobante),
                                fn_parametro_fiscal('RET_IVA_TOTAL', new.fecha_comprobante)) then
        raise exception 'El porcentaje de retención de IVA debe ser uno de los vigentes (% %% o % %%)',
          fn_parametro_fiscal('RET_IVA_GENERAL', new.fecha_comprobante), fn_parametro_fiscal('RET_IVA_TOTAL', new.fecha_comprobante);
      end if;
      new.monto := round(new.base * new.porcentaje / 100, 2);
      -- R-RR3: el mes del comprobante, o el de hoy si ese mes ya se declaró.
      new.periodo := case when fn_fiscal_cerrado(new.fecha_comprobante, 'iva') then date_trunc('month', v_hoy)::date
                          else date_trunc('month', new.fecha_comprobante)::date end;
    else
      if new.base > d.base_imponible + d.exento then
        raise exception 'La base retenida (Bs. %) supera la base imponible del documento (Bs. %)', new.base, d.base_imponible + d.exento;
      end if;
      if new.monto > round(new.base * new.porcentaje / 100, 2) then
        raise exception 'El ISLR retenido (Bs. %) supera el % %% de la base', new.monto, new.porcentaje;
      end if;
      new.periodo := date_trunc('month', new.fecha_comprobante)::date;
    end if;

    if p.estado <> 'abierta' or new.monto > p.saldo then
      raise exception 'La retención (Bs. %) supera el saldo por cobrar del documento (Bs. %): si el cliente ya lo pagó completo, lo retenido se le devuelve o se le acredita aparte',
        new.monto, p.saldo;
    end if;
    new.usd := case when new.monto = p.saldo then p.saldo_usd else round(p.saldo_usd * new.monto / p.saldo, 2) end;
    new.numero := fn_siguiente_numero('retencion_venta', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    new.anulado_por := null; new.anulado_at := null; new.anulado_motivo := null;

    v_previo := coalesce(current_setting('app.cxc_interno', true), '');
    perform set_config('app.cxc_interno', '1', true);
    update partida_cxc set saldo = saldo - new.monto, saldo_usd = saldo_usd - new.usd,
                           estado = case when saldo - new.monto = 0 then 'cancelada' else 'abierta' end
     where id = p.id;
    perform set_config('app.cxc_interno', v_previo, true);
    return new;
  end if;

  -- UPDATE: solo la anulación (R-RR4).
  if (to_jsonb(new) - 'estado' - 'anulado_por' - 'anulado_at' - 'anulado_motivo') is distinct from
     (to_jsonb(old) - 'estado' - 'anulado_por' - 'anulado_at' - 'anulado_motivo') then
    raise exception 'Una retención recibida no se edita: se anula y se registra de nuevo';
  end if;
  if old.estado = 'anulada' then
    raise exception 'La retención ya está anulada';
  end if;
  if new.estado <> 'anulada' then
    return new;
  end if;
  if old.impuesto = 'iva' and fn_fiscal_cerrado(old.periodo, 'iva') then
    raise exception 'El IVA de % ya está declarado con esta retención: Gerencia debe reabrir el periodo antes de anularla', to_char(old.periodo, 'MM-YYYY');
  end if;
  new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
  new.anulado_at := now();
  select * into p from partida_cxc where id = old.partida_id for update;
  if p.estado = 'anulada' then
    raise exception 'El documento retenido está anulado';
  end if;
  v_previo := coalesce(current_setting('app.cxc_interno', true), '');
  perform set_config('app.cxc_interno', '1', true);
  update partida_cxc set saldo = saldo + old.monto, saldo_usd = saldo_usd + old.usd, estado = 'abierta' where id = p.id;
  perform set_config('app.cxc_interno', v_previo, true);
  return new;
end $$;

create trigger retencion_venta_antes
  before insert or update or delete on retencion_venta
  for each row execute function fn_retencion_venta_antes();
create trigger retencion_venta_audit after insert or update on retencion_venta for each row execute function fn_audit();

-- R-RR4: un documento con retenciones vigentes no se anula (primero se anulan las retenciones).
create function fn_venta_anular_con_retencion() returns trigger
language plpgsql as $$
begin
  if new.estado = 'anulado' and old.estado <> 'anulado'
     and exists (select 1 from retencion_venta where documento_id = old.id and estado = 'registrada') then
    raise exception 'El documento tiene retenciones del cliente registradas: anúlelas primero';
  end if;
  return new;
end $$;
create trigger documento_venta_anular_con_retencion before update on documento_venta
  for each row execute function fn_venta_anular_con_retencion();

-- ---------------------------------------------------------------------
-- Reglas contables (§12.3: «Retención de IVA recibida: IVA retenido por clientes contra CxC comerciales»). Importes dobles: lo que
-- sale de cuentas por cobrar vale lo que valía el documento, y el activo fiscal se registra por ese mismo valor.
-- ---------------------------------------------------------------------
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('retencion_venta_iva',  1, 'D', '1.2.04', 'monto', 'IVA retenido por clientes'),
    ('retencion_venta_iva',  2, 'H', '1.2.01', 'monto', 'Cuentas por cobrar comerciales'),
    ('retencion_venta_islr', 1, 'D', '1.2.05', 'monto', 'ISLR retenido por clientes (anticipo de ISLR)'),
    ('retencion_venta_islr', 2, 'H', '1.2.01', 'monto', 'Cuentas por cobrar comerciales')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

-- ---------------------------------------------------------------------
-- Declaración de IVA (R-RR5)
-- ---------------------------------------------------------------------
alter table declaracion_fiscal add column retenciones_siguiente numeric(16,2) check (retenciones_siguiente >= 0);

-- Retenciones de IVA recibidas que se descuentan en un mes (vigentes, por su periodo).
create view vw_retencion_venta as
select r.id, r.numero, r.impuesto, r.cliente_id, cl.codigo as cliente_codigo, t.rif, t.razon_social as cliente,
       r.documento_id, d.tipo as documento_tipo, d.numero as documento_numero, d.numero_control,
       (d.fecha_emision at time zone 'America/Caracas')::date as documento_fecha,
       r.numero_comprobante, r.fecha_comprobante, r.periodo, r.base, r.porcentaje, r.monto, r.usd, r.estado,
       r.anulado_motivo, r.created_at
  from retencion_venta r
  join cliente cl on cl.tercero_id = r.cliente_id
  join tercero t on t.id = r.cliente_id
  join documento_venta d on d.id = r.documento_id;

create function fn_retenciones_iva_recibidas(p_anio int, p_mes int) returns numeric
language sql stable as $$
  select coalesce(sum(monto), 0) from retencion_venta
   where impuesto = 'iva' and estado = 'registrada' and periodo = make_date(p_anio, p_mes, 1)
$$;
