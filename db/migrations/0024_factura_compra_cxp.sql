-- =====================================================================
-- 0024 · Factura de compra con conciliación a tres vías, cuentas por pagar y ajuste de costo (§7.2, §7.3, §8.2, §12.3)
--
--   R-BC  La factura del proveedor se concilia con la orden (precio) y con la recepción (cantidad): solo se factura
--         lo recibido y aún no facturado de cada línea. Si la diferencia de precio de alguna línea supera la
--         tolerancia (parámetro, por porcentaje o por monto en USD) la factura queda RETENIDA y no abre cuenta por
--         pagar, así que no se puede pagar, hasta que Gerencia —no quien la registró— la apruebe o la rechace.
--   R-BD  Una factura registrada no se edita ni se borra. Una contabilizada tampoco se anula: se corrige con una nota
--         de crédito o de débito del proveedor (pendiente en esta fase). Un proveedor no repite su número de factura.
--   R-BE  Al contabilizar: se liquida la mercancía recibida no facturada (2.1.02) por lo que se recibió, la diferencia
--         contra lo facturado ajusta el costo de lo que sigue en existencia y va a costo de ventas por lo que ya se
--         vendió, el IVA va a crédito fiscal y el total a cuentas por pagar. Todo con el motor contable.
--   R-BF  El costo del inventario solo cambia sin mover cantidad mediante un ajuste de costo registrado (inmutable),
--         con su origen. Lo usan la factura de compra y, más adelante, los gastos de importación.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('factura_compra', 'A', '', 1);

-- Parámetros de compras (no son fiscales). Valores iniciales de referencia, a confirmar por Gerencia.
create table parametro_compra (
  codigo      varchar(40) primary key check (codigo ~ '^[A-Z_]+$'),
  descripcion text not null,
  valor       numeric(14,4) not null check (valor >= 0),
  unidad      text not null check (unidad in ('porcentaje', 'usd'))
);
insert into parametro_compra (codigo, descripcion, valor, unidad) values
  ('TOLERANCIA_PRECIO_PCT', 'Conciliación de facturas: diferencia de precio aceptada por línea, en % del valor de la orden', 2, 'porcentaje'),
  ('TOLERANCIA_PRECIO_USD', 'Conciliación de facturas: diferencia de precio aceptada por línea, en USD', 1, 'usd');
create trigger parametro_compra_audit after insert or update or delete on parametro_compra for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Ajuste de costo del inventario (R-BF)
-- ---------------------------------------------------------------------
create table ajuste_costo (
  id          uuid primary key default gen_random_uuid(),
  producto_id uuid not null references producto(id),
  valor_usd   numeric(16,2) not null check (valor_usd <> 0),          -- + encarece, − abarata el inventario existente
  origen_tipo text not null check (length(trim(origen_tipo)) > 0),
  origen_id   uuid not null,
  created_by  uuid not null references usuario(id),
  created_at  timestamptz not null default now()
);
create index ajuste_costo_producto_idx on ajuste_costo (producto_id, created_at);
create index ajuste_costo_origen_idx on ajuste_costo (origen_tipo, origen_id);

create function fn_ajuste_costo_antes() returns trigger
language plpgsql as $$
declare
  v_costo producto_costo%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Un ajuste de costo no se modifica ni se borra: se corrige con otro ajuste';
  end if;
  new.created_by := coalesce(new.created_by, fn_usuario_actual());
  if new.created_by is null then
    raise exception 'Un ajuste de costo necesita el usuario que lo registra';
  end if;
  select * into v_costo from producto_costo where producto_id = new.producto_id for update;
  if not found or v_costo.cantidad <= 0 then
    raise exception 'No se ajusta el costo de un producto sin existencia';
  end if;
  if v_costo.valor_usd + new.valor_usd < 0 then
    raise exception 'El ajuste dejaría el valor del inventario del producto en negativo';
  end if;
  return new;
end $$;

create trigger ajuste_costo_antes
  before insert or update or delete on ajuste_costo
  for each row execute function fn_ajuste_costo_antes();

-- El valor del inventario cambia, la cantidad no; el costo promedio se recalcula.
create function fn_ajuste_costo_despues() returns trigger
language plpgsql as $$
begin
  update producto_costo set
    valor_usd = valor_usd + new.valor_usd,
    costo_promedio_usd = round((valor_usd + new.valor_usd) / cantidad, 4)
   where producto_id = new.producto_id;
  return null;
end $$;

create trigger ajuste_costo_despues
  after insert on ajuste_costo
  for each row execute function fn_ajuste_costo_despues();

create trigger ajuste_costo_audit after insert on ajuste_costo for each row execute function fn_audit();

-- ---------------------------------------------------------------------
-- Factura de compra de mercancía
-- ---------------------------------------------------------------------
create table factura_compra (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint unique,                                     -- número de registro interno, al registrarla
  estado            text not null default 'borrador'
                    check (estado in ('borrador', 'retenida', 'contabilizada', 'rechazada')),
  orden_id          uuid not null references documento_compra(id),
  proveedor_id      uuid not null references proveedor(tercero_id),
  numero_factura    varchar(40) not null check (length(trim(numero_factura)) > 0),
  numero_control    varchar(40) not null check (length(trim(numero_control)) > 0),
  fecha_factura     date not null,
  fecha_vencimiento date not null,
  moneda            char(3) not null references moneda(codigo),
  tasa              numeric(18,6) check (tasa > 0),                    -- VES por unidad de la moneda, a la fecha de la factura
  base_imponible    numeric(16,2) not null default 0,
  exento            numeric(16,2) not null default 0,
  iva               numeric(16,2) not null default 0,
  total             numeric(16,2) not null default 0,
  total_usd         numeric(16,2) not null default 0,
  conciliada        boolean,                                           -- resultado de la conciliación al registrarla
  motivo_retencion  text,
  aprobado_por      uuid references usuario(id),
  aprobado_at       timestamptz,
  rechazo_motivo    text,
  registrada_at     timestamptz,
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  check ((estado = 'borrador') = (numero is null)),
  check (estado = 'borrador' or (tasa is not null and conciliada is not null and registrada_at is not null)),
  check (estado <> 'retenida' or length(trim(coalesce(motivo_retencion, ''))) > 0),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2),
  check (fecha_vencimiento >= fecha_factura)
);
-- Un proveedor no repite su número de factura mientras esté vigente (R-BD).
create unique index factura_compra_numero_unico on factura_compra (proveedor_id, upper(trim(numero_factura)))
  where estado in ('borrador', 'retenida', 'contabilizada');
create index factura_compra_orden_idx on factura_compra (orden_id);
create index factura_compra_proveedor_idx on factura_compra (proveedor_id, estado);

create table factura_compra_linea (
  id                  uuid primary key default gen_random_uuid(),
  factura_id          uuid not null references factura_compra(id) on delete cascade,
  linea               int not null check (linea > 0),
  orden_linea_id      uuid not null references documento_compra_linea(id),
  producto_id         uuid not null references producto(id),
  descripcion         text not null,
  cantidad            numeric(14,4) not null check (cantidad > 0),
  precio_unitario     numeric(16,4) not null check (precio_unitario >= 0),     -- en la moneda de la factura
  alicuota_iva_id     uuid not null references alicuota_iva(id),
  alicuota_pct        numeric(6,2) not null default 0,
  base                numeric(16,2) not null default 0,
  iva                 numeric(16,2) not null default 0,
  total               numeric(16,2) not null default 0,
  -- Conciliación (se llena al registrar la factura)
  precio_orden        numeric(16,4),
  dif_precio          numeric(16,2),                                           -- facturado − (cantidad × precio de la orden)
  valor_recibido_usd  numeric(16,2),                                           -- lo que la recepción valorizó de estas unidades
  dentro_tolerancia   boolean,
  unique (factura_id, linea),
  unique (factura_id, orden_linea_id)
);
create index factura_compra_linea_orden_idx on factura_compra_linea (orden_linea_id);

-- Cantidad ya facturada de una línea de orden (facturas retenidas o contabilizadas), sin contar la indicada.
create function fn_orden_linea_facturada(p_linea uuid, p_excluir uuid default null) returns numeric
language sql stable as $$
  select coalesce(sum(l.cantidad), 0)
    from factura_compra_linea l join factura_compra f on f.id = l.factura_id and f.estado in ('retenida', 'contabilizada')
   where l.orden_linea_id = p_linea and (p_excluir is null or f.id <> p_excluir)
$$;

create function fn_factura_compra_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'aprobado_por', 'aprobado_at', 'rechazo_motivo'];
  v_orden  documento_compra%rowtype;
  v_l      record;
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Una factura de compra nace en borrador';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una factura de compra necesita el usuario que la registra';
    end if;
    select * into v_orden from documento_compra where id = new.orden_id and tipo = 'orden_compra';
    if not found or v_orden.estado <> 'aprobada' then
      raise exception 'Solo se factura contra una orden de compra aprobada';
    end if;
    if v_orden.proveedor_id <> new.proveedor_id then
      raise exception 'La factura debe ser del mismo proveedor de la orden';
    end if;
    if not exists (select 1 from proveedor where tercero_id = new.proveedor_id and estado = 'activo') then
      raise exception 'El proveedor debe estar activo';
    end if;
    if new.fecha_factura > (now() at time zone 'America/Caracas')::date then
      raise exception 'La fecha de la factura no puede ser futura';
    end if;
    new.moneda := v_orden.moneda;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Una factura de compra registrada no se borra';
    end if;
    return old;
  end if;

  if old.estado = 'borrador' then
    if new.estado = 'borrador' then
      if new.orden_id <> old.orden_id or new.proveedor_id <> old.proveedor_id then
        raise exception 'No se cambia la orden ni el proveedor de una factura en borrador';
      end if;
      return new;
    end if;
    if new.estado not in ('retenida', 'contabilizada') then
      raise exception 'Una factura en borrador solo pasa a retenida o contabilizada';
    end if;
    if not exists (select 1 from factura_compra_linea where factura_id = old.id) then
      raise exception 'No se puede registrar una factura sin líneas';
    end if;
    -- R-BC: con la orden bloqueada, nada se factura por encima de lo recibido y no facturado.
    select * into v_orden from documento_compra where id = old.orden_id for update;
    for v_l in
      select o.id, p.codigo, l.cantidad,
             coalesce((select sum(r.cantidad) from documento_compra_linea r join documento_compra d on d.id = r.documento_id and d.estado = 'emitido'
                        where r.linea_origen_id = o.id), 0) as recibido,
             fn_orden_linea_facturada(o.id, old.id) as facturado
        from factura_compra_linea l join documento_compra_linea o on o.id = l.orden_linea_id join producto p on p.id = l.producto_id
       where l.factura_id = old.id
    loop
      if v_l.facturado + v_l.cantidad > v_l.recibido then
        raise exception 'Solo se factura lo recibido: de % se recibieron %, ya se facturaron % y esta factura trae %',
          v_l.codigo, v_l.recibido, v_l.facturado, v_l.cantidad;
      end if;
    end loop;
    new.numero := fn_siguiente_numero('factura_compra', 'A');
    new.registrada_at := now();
    if new.estado = 'contabilizada' and new.conciliada is not true then
      raise exception 'Una factura fuera de tolerancia no se contabiliza sin la aprobación de Gerencia';
    end if;
    return new;
  end if;

  if old.estado <> 'retenida' then
    raise exception 'Una factura de compra % no se modifica: se corrige con una nota de crédito o de débito del proveedor', old.estado;
  end if;
  -- Retenida: solo cambian el estado y los datos de la decisión.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Una factura de compra retenida no se edita';
  end if;
  if new.estado = 'contabilizada' then
    -- R-BC: aprueba un usuario activo con el rol Gerencia que no registró la factura.
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar una factura retenida';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien registró la factura no la aprueba';
    end if;
    new.aprobado_at := now();
  elsif new.estado <> 'rechazada' then
    raise exception 'Una factura retenida solo se aprueba o se rechaza';
  end if;
  return new;
end $$;

create trigger factura_compra_antes
  before insert or update or delete on factura_compra
  for each row execute function fn_factura_compra_antes();

create function fn_factura_compra_linea_antes() returns trigger
language plpgsql as $$
declare
  v_f factura_compra%rowtype;
  v_o documento_compra_linea%rowtype;
begin
  select * into v_f from factura_compra where id = coalesce(new.factura_id, old.factura_id);
  -- Si la cabecera ya no existe, es el borrado en cascada de un borrador.
  if found and v_f.estado <> 'borrador' then
    raise exception 'Las líneas de una factura de compra registrada no se modifican';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select * into v_o from documento_compra_linea where id = new.orden_linea_id;
  if not found or v_o.documento_id <> v_f.orden_id or v_o.producto_id <> new.producto_id then
    raise exception 'La línea de la factura debe corresponder a una línea de su orden de compra';
  end if;
  return new;
end $$;

create trigger factura_compra_linea_antes
  before insert or update or delete on factura_compra_linea
  for each row execute function fn_factura_compra_linea_antes();

-- Base, IVA y totales de una factura en borrador; el IVA sale de la alícuota del producto vigente a la fecha de la factura.
create function fn_factura_compra_calcular(p_factura uuid) returns void
language plpgsql as $$
declare
  v_f    factura_compra%rowtype;
  v_tasa numeric;
  v_usd  numeric;
begin
  select * into v_f from factura_compra where id = p_factura for update;
  if not found then
    raise exception 'La factura no existe';
  end if;
  if v_f.estado <> 'borrador' then
    raise exception 'Solo se calculan las facturas en borrador';
  end if;
  v_tasa := fn_tasa(v_f.moneda, v_f.fecha_factura);
  v_usd := fn_tasa('USD', v_f.fecha_factura);

  update factura_compra_linea l set alicuota_pct = fn_alicuota_iva_pct(l.alicuota_iva_id, v_f.fecha_factura)
   where l.factura_id = p_factura;
  update factura_compra_linea set base = round(cantidad * precio_unitario, 2) where factura_id = p_factura;
  update factura_compra_linea set iva = round(base * alicuota_pct / 100, 2) where factura_id = p_factura;
  update factura_compra_linea set total = base + iva where factura_id = p_factura;

  update factura_compra f set
    base_imponible = coalesce(s.gravado, 0),
    exento         = coalesce(s.exento, 0),
    iva            = coalesce(s.iva, 0),
    total          = coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0),
    -- Mismo redondeo que el motor contable: primero a bolívares, luego a USD.
    total_usd      = case when v_f.moneda = 'USD' then coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)
                          else round(round((coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)) * v_tasa, 2) / v_usd, 2) end,
    tasa           = v_tasa
    from (select sum(case when alicuota_pct > 0 then base else 0 end) as gravado,
                 sum(case when alicuota_pct = 0 then base else 0 end) as exento,
                 sum(iva) as iva
            from factura_compra_linea where factura_id = p_factura) s
   where f.id = p_factura;
end $$;

-- Conciliación a tres vías de una factura en borrador ya calculada (R-BC). Devuelve si está dentro de tolerancia.
create function fn_factura_compra_conciliar(p_factura uuid) returns boolean
language plpgsql as $$
declare
  v_f       factura_compra%rowtype;
  v_usd     numeric;
  v_pct     numeric;
  v_tol_usd numeric;
  v_l       record;
  v_val     numeric;
  v_dif     numeric;
  v_ok      boolean;
  v_fuera   text[] := '{}';
begin
  select * into v_f from factura_compra where id = p_factura for update;
  if v_f.estado <> 'borrador' or v_f.tasa is null then
    raise exception 'Calcule la factura en borrador antes de conciliarla';
  end if;
  select valor into v_pct from parametro_compra where codigo = 'TOLERANCIA_PRECIO_PCT';
  select valor into v_tol_usd from parametro_compra where codigo = 'TOLERANCIA_PRECIO_USD';
  if v_pct is null or v_tol_usd is null then
    raise exception 'Falta configurar la tolerancia de conciliación de facturas';
  end if;
  v_usd := fn_tasa('USD', v_f.fecha_factura);

  for v_l in
    select l.id, l.cantidad, l.base, p.codigo, o.precio_unitario as precio_orden, o.id as orden_linea,
           (select coalesce(sum(r.cantidad), 0) from documento_compra_linea r join documento_compra d on d.id = r.documento_id and d.estado = 'emitido'
             where r.linea_origen_id = o.id) as rec_cant,
           (select coalesce(sum(r.costo_total_usd), 0) from documento_compra_linea r join documento_compra d on d.id = r.documento_id and d.estado = 'emitido'
             where r.linea_origen_id = o.id) as rec_val
      from factura_compra_linea l join documento_compra_linea o on o.id = l.orden_linea_id join producto p on p.id = l.producto_id
     where l.factura_id = p_factura order by l.linea
  loop
    if v_l.cantidad + fn_orden_linea_facturada(v_l.orden_linea, p_factura) > v_l.rec_cant then
      raise exception 'Solo se factura lo recibido: de % hay % por facturar y la factura trae %',
        v_l.codigo, v_l.rec_cant - fn_orden_linea_facturada(v_l.orden_linea, p_factura), v_l.cantidad;
    end if;
    -- Valor que la recepción dio a estas unidades: la última factura de una línea se lleva el resto exacto.
    if v_l.cantidad + fn_orden_linea_facturada(v_l.orden_linea, p_factura) = v_l.rec_cant then
      select v_l.rec_val - coalesce(sum(x.valor_recibido_usd), 0) into v_val
        from factura_compra_linea x join factura_compra f on f.id = x.factura_id and f.estado in ('retenida', 'contabilizada')
       where x.orden_linea_id = v_l.orden_linea and f.id <> p_factura;
    else
      v_val := round(v_l.rec_val * v_l.cantidad / v_l.rec_cant, 2);
    end if;
    v_dif := v_l.base - round(v_l.cantidad * v_l.precio_orden, 2);
    v_ok := abs(v_dif) <= round(v_l.cantidad * v_l.precio_orden, 2) * v_pct / 100
         or abs(case when v_f.moneda = 'USD' then v_dif else round(round(v_dif * v_f.tasa, 2) / v_usd, 2) end) <= v_tol_usd;
    update factura_compra_linea set precio_orden = v_l.precio_orden, dif_precio = v_dif, valor_recibido_usd = v_val, dentro_tolerancia = v_ok
     where id = v_l.id;
    if not v_ok then
      v_fuera := v_fuera || v_l.codigo;
    end if;
  end loop;

  update factura_compra set conciliada = (cardinality(v_fuera) = 0),
         motivo_retencion = case when cardinality(v_fuera) = 0 then null
                                 else 'Diferencia de precio fuera de tolerancia en: ' || array_to_string(v_fuera, ', ') end
   where id = p_factura;
  return cardinality(v_fuera) = 0;
end $$;

-- ---------------------------------------------------------------------
-- Cuentas por pagar: una partida por factura contabilizada (§7.3). Los pagos y las notas se suman en su fase.
-- ---------------------------------------------------------------------
create table partida_cxp (
  id              uuid primary key default gen_random_uuid(),
  proveedor_id    uuid not null references proveedor(tercero_id),
  factura_id      uuid not null unique references factura_compra(id),
  fecha           date not null,
  vencimiento     date not null,
  moneda          char(3) not null references moneda(codigo),
  tasa            numeric(18,6) not null check (tasa > 0),
  monto_original  numeric(16,2) not null check (monto_original > 0),
  monto_usd       numeric(16,2) not null check (monto_usd >= 0),
  saldo           numeric(16,2) not null check (saldo >= 0),
  estado          text not null default 'abierta' check (estado in ('abierta', 'cancelada')),
  created_at      timestamptz not null default now(),
  check (vencimiento >= fecha),
  check (saldo <= monto_original),
  check ((estado = 'abierta') = (saldo > 0))
);
create index partida_cxp_proveedor_idx on partida_cxp (proveedor_id, estado);

create function fn_partida_cxp_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una partida de cuentas por pagar no se borra';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.proveedor_id <> old.proveedor_id or new.factura_id <> old.factura_id or new.fecha <> old.fecha or new.vencimiento <> old.vencimiento
     or new.moneda <> old.moneda or new.tasa <> old.tasa or new.monto_original <> old.monto_original or new.monto_usd <> old.monto_usd then
    raise exception 'Una partida de cuentas por pagar solo cambia su saldo';
  end if;
  if (new.saldo <> old.saldo or new.estado <> old.estado) and coalesce(current_setting('app.cxp_interno', true), '') <> '1' then
    raise exception 'El saldo de una cuenta por pagar solo cambia con un pago, una nota del proveedor o una retención';
  end if;
  return new;
end $$;

create trigger partida_cxp_reglas
  before insert or update or delete on partida_cxp
  for each row execute function fn_partida_cxp_reglas();

-- Flujo de aprobación de una factura retenida: Gerencia, distinta de quien la registró.
insert into flujo_definicion (objeto_tipo, nombre) values ('factura_compra', 'Factura de compra retenida');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'factura_compra';

-- Reglas contables (§12.3), en la moneda de la factura:
--   recibido  lo que la recepción dio a la mercancía facturada (liquida 2.1.02)
--   aum_inv / red_inv  diferencia de precio que encarece / abarata lo que sigue en existencia
--   aum_cv / red_cv    la misma diferencia sobre lo que ya se vendió (costo de ventas)
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('factura_compra', 1, 'D', '2.1.02', 'recibido', 'Liquidación de mercancía recibida no facturada'),
    ('factura_compra', 2, 'D', '1.3.01', 'aum_inv',  'Mayor costo de la mercancía en existencia'),
    ('factura_compra', 3, 'D', '5.1.01', 'aum_cv',   'Mayor costo de la mercancía vendida'),
    ('factura_compra', 4, 'D', '1.2.03', 'iva',      'IVA crédito fiscal'),
    ('factura_compra', 5, 'H', '1.3.01', 'red_inv',  'Menor costo de la mercancía en existencia'),
    ('factura_compra', 6, 'H', '5.1.01', 'red_cv',   'Menor costo de la mercancía vendida'),
    ('factura_compra', 7, 'H', '2.1.01', 'total',    'Cuentas por pagar a proveedores')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger factura_compra_audit       after insert or update or delete on factura_compra       for each row execute function fn_audit();
create trigger factura_compra_linea_audit after insert or update or delete on factura_compra_linea for each row execute function fn_audit();
create trigger partida_cxp_audit          after insert or update on partida_cxp                    for each row execute function fn_audit();
