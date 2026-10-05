-- =====================================================================
-- 0017 · Inventario (movimientos, existencias, costo promedio, reservas) y documentos de venta:
--        pedido y nota de entrega (§6.1, §6.2, §8.1, §8.2)
--
--   R-AG  Una existencia solo cambia por un movimiento de inventario, y un movimiento nunca se edita
--         ni se borra: se corrige con otro movimiento. Las salidas se valorizan al costo promedio vigente.
--   R-AH  El costo promedio ponderado móvil es uno por producto para toda la empresa (decisión 5):
--         vive en producto_costo y se recalcula con cada entrada.
--   R-AI  No hay existencia negativa en almacenes comerciales ni se reserva más de lo disponible.
--   R-AJ  Un documento de venta emitido no se edita ni se borra: se anula con motivo (§3.3). Su
--         número lo asigna el numerador al emitir, y la base, el IVA y los totales se guardan al
--         emitir y no se recalculan.
--   R-AK  Cada reserva está ligada a una línea de pedido; existencia.reservado es la suma de las
--         reservas vigentes y no se toca a mano.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Movimientos de inventario (§8.1)
-- ---------------------------------------------------------------------
create table movimiento_inventario (
  id            bigint generated always as identity primary key,
  fecha         timestamptz not null default now(),
  tipo          text not null check (tipo in ('entrada_compra', 'salida_venta', 'devolucion_cliente', 'devolucion_proveedor',
                                              'transferencia_salida', 'transferencia_entrada', 'ajuste_positivo', 'ajuste_negativo',
                                              'consumo_produccion', 'entrada_produccion', 'apertura')),
  producto_id   uuid not null references producto(id),
  almacen_id    uuid not null references almacen(id),
  cantidad      numeric(14,4) not null check (cantidad <> 0),          -- con signo: + entra, − sale
  costo_unitario_usd numeric(16,4) not null check (costo_unitario_usd >= 0),
  costo_total_usd    numeric(16,2) not null,                          -- con el mismo signo que la cantidad
  origen_tipo   text not null check (length(trim(origen_tipo)) > 0),
  origen_id     uuid not null,                                         -- documento que lo generó
  created_by    uuid not null references usuario(id),
  check (sign(costo_total_usd) in (0, sign(cantidad))),
  check ((tipo in ('entrada_compra', 'devolucion_cliente', 'transferencia_entrada', 'ajuste_positivo', 'entrada_produccion', 'apertura')
          and cantidad > 0)
      or (tipo in ('salida_venta', 'devolucion_proveedor', 'transferencia_salida', 'ajuste_negativo', 'consumo_produccion')
          and cantidad < 0))
);
create index movimiento_inventario_producto_idx on movimiento_inventario (producto_id, fecha);
create index movimiento_inventario_origen_idx on movimiento_inventario (origen_tipo, origen_id);

-- Costo promedio ponderado móvil: uno por producto para toda la empresa (R-AH).
create table producto_costo (
  producto_id        uuid primary key references producto(id),
  cantidad           numeric(14,4) not null default 0,
  valor_usd          numeric(18,2) not null default 0,
  costo_promedio_usd numeric(16,4) not null default 0 check (costo_promedio_usd >= 0)
);

create table existencia (
  producto_id uuid not null references producto(id),
  almacen_id  uuid not null references almacen(id),
  cantidad    numeric(14,4) not null default 0,
  reservado   numeric(14,4) not null default 0,
  primary key (producto_id, almacen_id),
  check (reservado >= 0 and reservado <= greatest(cantidad, 0))
);

-- Cantidad y reservado los mueven solo los triggers de movimiento y de reserva (R-AG, R-AK).
create function fn_existencia_protegida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una existencia no se borra: se corrige con un movimiento de inventario';
  end if;
  if tg_op = 'UPDATE' and new.cantidad = old.cantidad and new.reservado = old.reservado then
    return new;
  end if;
  if coalesce(current_setting('app.inventario_interno', true), '') <> '1' then
    raise exception 'La existencia solo cambia con un movimiento de inventario o una reserva';
  end if;
  return new;
end $$;

create trigger existencia_protegida
  before insert or update or delete on existencia
  for each row execute function fn_existencia_protegida();

create function fn_movimiento_antes() returns trigger
language plpgsql as $$
declare
  v_inventariable boolean;
  v_costo         producto_costo%rowtype;
  v_total         numeric(16,2);
begin
  select inventariable into v_inventariable from producto where id = new.producto_id;
  if v_inventariable is distinct from true then
    raise exception 'Solo los productos inventariables tienen movimientos de inventario';
  end if;
  new.created_by := coalesce(new.created_by, fn_usuario_actual());
  if new.created_by is null then
    raise exception 'Un movimiento de inventario necesita el usuario que lo registra';
  end if;

  if new.cantidad > 0 then
    new.costo_total_usd := round(new.cantidad * new.costo_unitario_usd, 2);
  else
    -- Las salidas se valorizan al costo promedio vigente; si vacían el producto, se lleva todo el valor
    -- restante para que no queden centavos huérfanos.
    select * into v_costo from producto_costo where producto_id = new.producto_id for update;
    if found and v_costo.cantidad + new.cantidad = 0 then
      v_total := v_costo.valor_usd;
    else
      v_total := round(abs(new.cantidad) * coalesce(v_costo.costo_promedio_usd, 0), 2);
    end if;
    new.costo_total_usd := -v_total;
    new.costo_unitario_usd := round(v_total / abs(new.cantidad), 4);
  end if;
  return new;
end $$;

create trigger movimiento_antes
  before insert on movimiento_inventario
  for each row execute function fn_movimiento_antes();

create function fn_movimiento_despues() returns trigger
language plpgsql as $$
declare
  v_cantidad  numeric := 0;
  v_reservado numeric := 0;
  v_comercial boolean;
begin
  perform set_config('app.inventario_interno', '1', true);

  select cantidad, reservado into v_cantidad, v_reservado
    from existencia where producto_id = new.producto_id and almacen_id = new.almacen_id for update;
  v_cantidad := coalesce(v_cantidad, 0) + new.cantidad;
  v_reservado := coalesce(v_reservado, 0);

  select es_comercial into v_comercial from almacen where id = new.almacen_id;
  if v_comercial and v_cantidad < 0 then
    raise exception 'Existencia insuficiente: el movimiento dejaría el producto en negativo en un almacén comercial';
  end if;
  if v_reservado > 0 and v_cantidad < v_reservado then
    raise exception 'Existencia insuficiente: el movimiento dejaría la existencia por debajo de lo reservado para pedidos';
  end if;

  insert into existencia (producto_id, almacen_id, cantidad) values (new.producto_id, new.almacen_id, new.cantidad)
  on conflict (producto_id, almacen_id) do update set cantidad = existencia.cantidad + new.cantidad;

  insert into producto_costo (producto_id, cantidad, valor_usd, costo_promedio_usd)
  values (new.producto_id, new.cantidad, new.costo_total_usd,
          case when new.cantidad > 0 then round(new.costo_total_usd / new.cantidad, 4) else 0 end)
  on conflict (producto_id) do update set
    cantidad = producto_costo.cantidad + new.cantidad,
    valor_usd = producto_costo.valor_usd + new.costo_total_usd,
    -- Solo una entrada recalcula el promedio; una salida lo conserva.
    costo_promedio_usd = case
      when new.cantidad > 0 and producto_costo.cantidad + new.cantidad > 0
        then round((producto_costo.valor_usd + new.costo_total_usd) / (producto_costo.cantidad + new.cantidad), 4)
      else producto_costo.costo_promedio_usd end;
  return null;
end $$;

create trigger movimiento_despues
  after insert on movimiento_inventario
  for each row execute function fn_movimiento_despues();

create function fn_inmutable() returns trigger
language plpgsql as $$
begin
  raise exception '% no se modifica ni se borra: se corrige con un registro nuevo', tg_table_name;
end $$;

create trigger movimiento_inmutable
  before update or delete on movimiento_inventario
  for each row execute function fn_inmutable();

-- ---------------------------------------------------------------------
-- Documento de venta (§6.1). Esta migración habilita pedido y nota de entrega; la factura, las
-- notas de crédito y de débito y la apertura se agregan con su propia migración.
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('pedido', 'A', '', 1),
  ('nota_entrega', 'A', '', 1);

create table documento_venta (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('pedido', 'nota_entrega')),
  serie           varchar(4) not null default 'A',
  numero          bigint,                                       -- lo asigna el numerador al emitir
  numero_control  varchar(20),
  estado          text not null default 'borrador' check (estado in ('borrador', 'emitido', 'anulado')),
  -- Pedido: 'retenido_credito' espera a Gerencia; 'aprobado' ya reservó existencia.
  situacion       text check (situacion in ('retenido_credito', 'aprobado')),
  sucursal_id     uuid not null references sucursal(id),
  almacen_id      uuid not null references almacen(id),
  cliente_id      uuid not null references cliente(tercero_id),
  vendedor_id     uuid references vendedor(id),
  documento_origen_id uuid references documento_venta(id),      -- nota de entrega → pedido
  fecha_emision   timestamptz,
  moneda          char(3) not null default 'USD' references moneda(codigo),
  tasa            numeric(18,6) check (tasa > 0),               -- VES por USD, congelada al emitir
  subtotal        numeric(16,2) not null default 0,
  descuento       numeric(16,2) not null default 0,
  base_imponible  numeric(16,2) not null default 0,
  exento          numeric(16,2) not null default 0,
  iva             numeric(16,2) not null default 0,
  igtf            numeric(16,2) not null default 0,
  total           numeric(16,2) not null default 0,
  total_ves       numeric(18,2) not null default 0,
  total_usd       numeric(16,2) not null default 0,
  observaciones   text,
  aprobado_por    uuid references usuario(id),                  -- aprobación de crédito del pedido
  aprobado_at     timestamptz,
  anulado_por     uuid references usuario(id),
  anulado_at      timestamptz,
  anulado_motivo  text,
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  unique (tipo, serie, numero),
  check ((estado = 'borrador') = (numero is null)),
  check (estado = 'borrador' or (tasa is not null and fecha_emision is not null)),
  check (estado <> 'anulado' or length(trim(coalesce(anulado_motivo, ''))) > 2),
  check ((tipo = 'pedido') or (situacion is null and documento_origen_id is not null))
);
create index documento_venta_cliente_idx on documento_venta (cliente_id, tipo, estado);
create index documento_venta_origen_idx on documento_venta (documento_origen_id);
create index documento_venta_vendedor_idx on documento_venta (vendedor_id);

create table documento_venta_linea (
  id              uuid primary key default gen_random_uuid(),
  documento_id    uuid not null references documento_venta(id) on delete cascade,
  linea           int not null check (linea > 0),
  producto_id     uuid not null references producto(id),
  descripcion     text not null,
  cantidad        numeric(14,4) not null check (cantidad > 0),
  precio_unitario numeric(16,4) not null check (precio_unitario >= 0),
  descuento_pct   numeric(5,2) not null default 0 check (descuento_pct between 0 and 100),
  alicuota_iva_id uuid not null references alicuota_iva(id),
  alicuota_pct    numeric(6,2) not null default 0,              -- porcentaje vigente, guardado al calcular
  base            numeric(16,2) not null default 0,
  iva             numeric(16,2) not null default 0,
  total           numeric(16,2) not null default 0,
  costo_unitario_usd numeric(16,4),                             -- foto del costo promedio al despachar (margen)
  -- Foto para el análisis de la Fase 8 (§3.4, §6.1)
  producto_base_id uuid references producto_base(id),
  lista_precio    char(1) references lista_precio(codigo),
  precio_lista    numeric(16,4),
  linea_origen_id uuid references documento_venta_linea(id),    -- línea de nota → línea de pedido
  unique (documento_id, linea)
);
create index documento_venta_linea_producto_idx on documento_venta_linea (producto_id);
create index documento_venta_linea_origen_idx on documento_venta_linea (linea_origen_id);

-- Lo que se pidió y no había: la demanda no atendida (§6.1) permite separar "no se vendió" de "no había".
create table demanda_no_atendida (
  id           uuid primary key default gen_random_uuid(),
  fecha        date not null default ((now() at time zone 'America/Caracas')::date),
  producto_id  uuid not null references producto(id),
  almacen_id   uuid not null references almacen(id),
  cliente_id   uuid not null references cliente(tercero_id),
  documento_id uuid not null references documento_venta(id),
  linea_id     uuid not null references documento_venta_linea(id),
  cantidad     numeric(14,4) not null check (cantidad > 0),
  created_at   timestamptz not null default now()
);
create index demanda_no_atendida_producto_idx on demanda_no_atendida (producto_id, fecha);

create trigger demanda_no_atendida_inmutable
  before update or delete on demanda_no_atendida
  for each row execute function fn_inmutable();

-- ---------------------------------------------------------------------
-- Reglas del encabezado: numeración al emitir e inmutabilidad (R-AJ)
-- ---------------------------------------------------------------------
create function fn_documento_venta_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'situacion', 'aprobado_por', 'aprobado_at', 'anulado_por', 'anulado_at', 'anulado_motivo'];
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

  -- Emitido: solo cambian el estado, la situación y los datos de aprobación o anulación.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Un documento emitido no se edita: se anula con su motivo o se corrige con otro documento';
  end if;
  if new.estado = 'borrador' then
    raise exception 'Un documento emitido no vuelve a borrador';
  end if;
  if new.estado = 'anulado' then
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := coalesce(new.anulado_at, now());
  end if;
  return new;
end $$;

create trigger documento_venta_antes
  before insert or update or delete on documento_venta
  for each row execute function fn_documento_venta_antes();

create function fn_documento_venta_linea_antes() returns trigger
language plpgsql as $$
declare
  v_estado text;
begin
  select estado into v_estado from documento_venta where id = coalesce(new.documento_id, old.documento_id);
  -- Si el encabezado ya no existe, es el borrado en cascada de un borrador.
  if v_estado is not null and v_estado <> 'borrador' then
    raise exception 'Las líneas de un documento emitido no se modifican';
  end if;
  return coalesce(new, old);
end $$;

create trigger documento_venta_linea_antes
  before insert or update or delete on documento_venta_linea
  for each row execute function fn_documento_venta_linea_antes();

-- ---------------------------------------------------------------------
-- Cálculo de la base, el IVA y los totales (R-AJ): se guarda y no se recalcula después de emitir.
-- Una línea: bruto = cantidad × precio; el descuento y el IVA se redondean a centavos por línea.
-- ---------------------------------------------------------------------
create function fn_venta_calcular(p_documento uuid) returns void
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
    total_usd      = coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0),
    total_ves      = round((coalesce(s.gravado, 0) + coalesce(s.exento, 0) + coalesce(s.iva, 0)) * v_tasa, 2),
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
-- Reservas de existencia por pedido (R-AI, R-AK)
-- ---------------------------------------------------------------------
create table reserva_inventario (
  id             uuid primary key default gen_random_uuid(),
  pedido_id      uuid not null references documento_venta(id),
  pedido_linea_id uuid not null references documento_venta_linea(id),
  nota_id        uuid references documento_venta(id),
  nota_linea_id  uuid references documento_venta_linea(id),
  producto_id    uuid not null references producto(id),
  almacen_id     uuid not null references almacen(id),
  cantidad       numeric(14,4) not null check (cantidad > 0),
  -- activa: apartada para el pedido; en_nota: ya figura en una nota de entrega; consumida: salió la mercancía.
  estado         text not null default 'activa' check (estado in ('activa', 'en_nota', 'consumida', 'liberada')),
  created_at     timestamptz not null default now(),
  check ((estado in ('en_nota', 'consumida')) = (nota_id is not null and nota_linea_id is not null))
);
create index reserva_inventario_pedido_idx on reserva_inventario (pedido_id, estado);
create index reserva_inventario_nota_idx on reserva_inventario (nota_id);

create function fn_reserva_aplicar() returns trigger
language plpgsql as $$
declare
  v_antes   numeric := 0;
  v_despues numeric := 0;
  v_cantidad numeric;
  v_reservado numeric;
begin
  if tg_op = 'UPDATE' then
    if old.estado in ('consumida', 'liberada') then
      raise exception 'Una reserva % ya no se modifica', old.estado;
    end if;
    if new.cantidad <> old.cantidad or new.producto_id <> old.producto_id or new.almacen_id <> old.almacen_id
       or new.pedido_id <> old.pedido_id or new.pedido_linea_id <> old.pedido_linea_id then
      raise exception 'Una reserva no cambia de producto, almacén, pedido ni cantidad: se libera y se crea otra';
    end if;
    if old.estado in ('activa', 'en_nota') then v_antes := old.cantidad; end if;
  end if;
  if new.estado in ('activa', 'en_nota') then v_despues := new.cantidad; end if;
  if v_despues = v_antes then
    return null;
  end if;

  perform set_config('app.inventario_interno', '1', true);
  select cantidad, reservado into v_cantidad, v_reservado
    from existencia where producto_id = new.producto_id and almacen_id = new.almacen_id for update;
  if not found then
    -- Sin fila de existencia no hay nada disponible.
    raise exception 'No hay existencia disponible para reservar';
  end if;
  if v_despues > v_antes and v_cantidad - v_reservado < v_despues - v_antes then
    raise exception 'No hay existencia disponible para reservar';
  end if;
  update existencia set reservado = reservado + (v_despues - v_antes)
   where producto_id = new.producto_id and almacen_id = new.almacen_id;
  return null;
end $$;

create trigger reserva_aplicar
  after insert or update on reserva_inventario
  for each row execute function fn_reserva_aplicar();

create function fn_reserva_no_borrar() returns trigger
language plpgsql as $$
begin
  raise exception 'Una reserva no se borra: se libera';
end $$;

create trigger reserva_no_borrar
  before delete on reserva_inventario
  for each row execute function fn_reserva_no_borrar();

-- ---------------------------------------------------------------------
-- Crédito: lo que el cliente ya compromete sin haber pagado (§6.2, regla 2)
--   · notas de entrega emitidas (la factura y las cuentas por cobrar se suman cuando existan), y
--   · lo pendiente de entregar en pedidos aprobados.
-- ---------------------------------------------------------------------
create function fn_exposicion_credito_usd(p_cliente uuid) returns numeric
language sql stable as $$
  select coalesce((select sum(n.total_usd) from documento_venta n
                    where n.cliente_id = p_cliente and n.tipo = 'nota_entrega' and n.estado = 'emitido'), 0)
       + coalesce((select sum(round(l.total * greatest(l.cantidad - coalesce(en.cant, 0), 0) / l.cantidad, 2))
                     from documento_venta p
                     join documento_venta_linea l on l.documento_id = p.id
                     left join lateral (select sum(nl.cantidad) as cant
                                          from documento_venta_linea nl
                                          join documento_venta nn on nn.id = nl.documento_id and nn.estado = 'emitido'
                                         where nl.linea_origen_id = l.id) en on true
                    where p.cliente_id = p_cliente and p.tipo = 'pedido' and p.estado = 'emitido' and p.situacion = 'aprobado'), 0)
$$;

-- ---------------------------------------------------------------------
-- Flujo de aprobación del pedido retenido por crédito (§4.5)
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values ('pedido_credito', 'Pedido retenido por crédito');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'pedido_credito';

-- ---------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------
create trigger documento_venta_audit       after insert or update or delete on documento_venta       for each row execute function fn_audit();
create trigger documento_venta_linea_audit after insert or update or delete on documento_venta_linea for each row execute function fn_audit();
create trigger reserva_inventario_audit    after insert or update on reserva_inventario              for each row execute function fn_audit();
create trigger demanda_no_atendida_audit   after insert on demanda_no_atendida                       for each row execute function fn_audit();
