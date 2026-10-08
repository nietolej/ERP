-- =====================================================================
-- 0025 · Gastos de importación y costo en destino (§7.1, §7.2 regla 3, §8.2, §12.3)
--
--   R-BG  Flete, seguro, aranceles, agente de aduana y otros gastos de una compra llegan como factura de un proveedor
--         de servicios. Se aplican a una o más recepciones y se reparten entre sus líneas por valor, peso, volumen o
--         cantidad, a elección de quien compra (la orden propone el suyo). El reparto es exacto a centavos y queda
--         guardado línea por línea.
--   R-BH  Lo que corresponde a unidades que siguen en existencia se capitaliza en el inventario (ajuste de costo y costo
--         promedio); lo que corresponde a unidades ya vendidas va al costo de ventas. Las unidades en existencia se toman de
--         la existencia total de cada producto.
--   R-BI  Un gasto registrado no se edita ni se borra. Abre su cuenta por pagar (comparte la partida con las facturas de
--         mercancía) y su asiento sale del motor: inventario y costo de ventas contra cuentas por pagar, más el IVA.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('gasto_importacion', 'A', '', 1);

create table gasto_importacion (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint unique,
  estado            text not null default 'borrador' check (estado in ('borrador', 'contabilizado')),
  proveedor_id      uuid not null references proveedor(tercero_id),
  concepto          text not null check (concepto in ('flete', 'seguro', 'arancel', 'agente_aduana', 'almacenaje', 'otros')),
  descripcion       text,
  numero_factura    varchar(40) not null check (length(trim(numero_factura)) > 0),
  numero_control    varchar(40) not null check (length(trim(numero_control)) > 0),
  fecha_factura     date not null,
  fecha_vencimiento date not null,
  moneda            char(3) not null references moneda(codigo),
  tasa              numeric(18,6) check (tasa > 0),
  criterio_reparto  text not null check (criterio_reparto in ('valor', 'peso', 'volumen', 'cantidad')),
  base              numeric(16,2) not null check (base > 0),          -- monto del gasto sin IVA, a repartir
  alicuota_iva_id   uuid not null references alicuota_iva(id),
  alicuota_pct      numeric(6,2) not null default 0,
  iva               numeric(16,2) not null default 0,
  total             numeric(16,2) not null default 0,
  total_usd         numeric(16,2) not null default 0,
  registrado_at     timestamptz,
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  check ((estado = 'borrador') = (numero is null)),
  check (estado = 'borrador' or (tasa is not null and registrado_at is not null)),
  check (fecha_vencimiento >= fecha_factura)
);
create unique index gasto_importacion_numero_unico on gasto_importacion (proveedor_id, upper(trim(numero_factura)));
create index gasto_importacion_proveedor_idx on gasto_importacion (proveedor_id, estado);

-- Recepciones a las que se aplica el gasto.
create table gasto_importacion_recepcion (
  gasto_id     uuid not null references gasto_importacion(id) on delete cascade,
  recepcion_id uuid not null references documento_compra(id),
  primary key (gasto_id, recepcion_id)
);
create index gasto_importacion_recepcion_idx on gasto_importacion_recepcion (recepcion_id);

-- Reparto línea por línea (se llena al registrar). Montos en la moneda del gasto.
create table gasto_importacion_reparto (
  id                    uuid primary key default gen_random_uuid(),
  gasto_id              uuid not null references gasto_importacion(id) on delete cascade,
  recepcion_linea_id    uuid not null references documento_compra_linea(id),
  producto_id           uuid not null references producto(id),
  monto                 numeric(16,2) not null check (monto >= 0),
  monto_inventario      numeric(16,2) not null,                       -- capitalizado en lo que sigue en existencia
  monto_costo_ventas    numeric(16,2) not null,                       -- lo que corresponde a unidades ya vendidas
  unique (gasto_id, recepcion_linea_id),
  check (monto_inventario + monto_costo_ventas = monto)
);

create function fn_gasto_importacion_antes() returns trigger
language plpgsql as $$
declare
  v_reparto numeric;
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un gasto de importación nace en borrador';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un gasto de importación necesita el usuario que lo registra';
    end if;
    if not exists (select 1 from proveedor where tercero_id = new.proveedor_id and estado = 'activo') then
      raise exception 'El proveedor debe estar activo';
    end if;
    if new.fecha_factura > (now() at time zone 'America/Caracas')::date then
      raise exception 'La fecha de la factura no puede ser futura';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un gasto de importación registrado no se borra';
    end if;
    return old;
  end if;

  if old.estado = 'contabilizado' then
    raise exception 'Un gasto de importación registrado no se modifica: se corrige con una nota de crédito o de débito del proveedor';
  end if;
  if new.estado = 'borrador' then
    return new;
  end if;
  -- borrador → contabilizado
  if not exists (select 1 from gasto_importacion_recepcion where gasto_id = old.id) then
    raise exception 'Indique las recepciones a las que se aplica el gasto';
  end if;
  select coalesce(sum(monto), 0) into v_reparto from gasto_importacion_reparto where gasto_id = old.id;
  if v_reparto <> new.base then
    raise exception 'El reparto (%) no suma el gasto (%)', v_reparto, new.base;
  end if;
  new.numero := fn_siguiente_numero('gasto_importacion', 'A');
  new.registrado_at := now();
  return new;
end $$;

create trigger gasto_importacion_antes
  before insert or update or delete on gasto_importacion
  for each row execute function fn_gasto_importacion_antes();

create function fn_gasto_importacion_hijos_antes() returns trigger
language plpgsql as $$
declare
  v_estado text;
begin
  select estado into v_estado from gasto_importacion where id = coalesce(new.gasto_id, old.gasto_id);
  -- Si la cabecera ya no existe, es el borrado en cascada de un borrador.
  if v_estado is not null and v_estado <> 'borrador' then
    raise exception 'Un gasto de importación registrado no se modifica';
  end if;
  if tg_table_name = 'gasto_importacion_recepcion' and tg_op <> 'DELETE' then
    if not exists (select 1 from documento_compra where id = new.recepcion_id and tipo = 'recepcion' and estado = 'emitido') then
      raise exception 'El gasto solo se aplica a recepciones emitidas';
    end if;
  end if;
  return coalesce(new, old);
end $$;

create trigger gasto_importacion_recepcion_antes
  before insert or update or delete on gasto_importacion_recepcion
  for each row execute function fn_gasto_importacion_hijos_antes();
create trigger gasto_importacion_reparto_antes
  before insert or update or delete on gasto_importacion_reparto
  for each row execute function fn_gasto_importacion_hijos_antes();

-- IVA y totales de un gasto en borrador, con la alícuota vigente a la fecha de la factura (mismo redondeo del motor).
create function fn_gasto_importacion_calcular(p_gasto uuid) returns void
language plpgsql as $$
declare
  v_g    gasto_importacion%rowtype;
  v_tasa numeric;
  v_usd  numeric;
  v_pct  numeric;
  v_iva  numeric;
begin
  select * into v_g from gasto_importacion where id = p_gasto for update;
  if not found then
    raise exception 'El gasto no existe';
  end if;
  if v_g.estado <> 'borrador' then
    raise exception 'Solo se calculan los gastos en borrador';
  end if;
  v_tasa := fn_tasa(v_g.moneda, v_g.fecha_factura);
  v_usd := fn_tasa('USD', v_g.fecha_factura);
  v_pct := fn_alicuota_iva_pct(v_g.alicuota_iva_id, v_g.fecha_factura);
  v_iva := round(v_g.base * v_pct / 100, 2);
  update gasto_importacion set
    alicuota_pct = v_pct,
    iva = v_iva,
    total = v_g.base + v_iva,
    total_usd = case when v_g.moneda = 'USD' then v_g.base + v_iva else round(round((v_g.base + v_iva) * v_tasa, 2) / v_usd, 2) end,
    tasa = v_tasa
   where id = p_gasto;
end $$;

-- La cuenta por pagar la comparten las facturas de mercancía y los gastos de importación.
alter table partida_cxp
  alter column factura_id drop not null,
  add column gasto_id uuid unique references gasto_importacion(id),
  add constraint partida_cxp_origen check ((factura_id is null) <> (gasto_id is null));

create or replace function fn_partida_cxp_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una partida de cuentas por pagar no se borra';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.proveedor_id <> old.proveedor_id or new.factura_id is distinct from old.factura_id or new.gasto_id is distinct from old.gasto_id
     or new.fecha <> old.fecha or new.vencimiento <> old.vencimiento
     or new.moneda <> old.moneda or new.tasa <> old.tasa or new.monto_original <> old.monto_original or new.monto_usd <> old.monto_usd then
    raise exception 'Una partida de cuentas por pagar solo cambia su saldo';
  end if;
  if (new.saldo <> old.saldo or new.estado <> old.estado) and coalesce(current_setting('app.cxp_interno', true), '') <> '1' then
    raise exception 'El saldo de una cuenta por pagar solo cambia con un pago, una nota del proveedor o una retención';
  end if;
  return new;
end $$;

-- Regla contable (§12.3), en la moneda del gasto: inventario y costo de ventas contra cuentas por pagar, más el IVA.
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('gasto_importacion', 1, 'D', '1.3.01', 'inventario',   'Gasto de importación capitalizado en el inventario'),
    ('gasto_importacion', 2, 'D', '5.1.01', 'costo_ventas', 'Gasto de importación de mercancía ya vendida'),
    ('gasto_importacion', 3, 'D', '1.2.03', 'iva',          'IVA crédito fiscal'),
    ('gasto_importacion', 4, 'H', '2.1.01', 'total',        'Cuentas por pagar a proveedores')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger gasto_importacion_audit            after insert or update or delete on gasto_importacion            for each row execute function fn_audit();
create trigger gasto_importacion_recepcion_audit  after insert or update or delete on gasto_importacion_recepcion  for each row execute function fn_audit();
create trigger gasto_importacion_reparto_audit    after insert or update or delete on gasto_importacion_reparto    for each row execute function fn_audit();
