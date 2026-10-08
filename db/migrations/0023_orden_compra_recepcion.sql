-- =====================================================================
-- 0023 · Compras: orden de compra y recepción de mercancía (§7.1, §7.2, §8.1, §12.3)
--
--   R-AY  Una orden de compra nace en borrador, se envía (recibe su número) y la aprueba Gerencia por el motor
--         de flujo; nunca quien la creó (la base lo exige). Enviada no se edita ni se borra: se aprueba, se
--         rechaza con motivo o se anula con motivo.
--   R-AZ  Solo se recibe mercancía contra una orden aprobada, de ese proveedor, y nunca más de lo pendiente de
--         cada línea (se valida al emitir, con la orden bloqueada, para que dos recepciones simultáneas no
--         se pasen de lo ordenado).
--   R-BA  La recepción valoriza el inventario al precio de la orden, convertido a USD con la tasa BCV del día de la
--         recepción, y no se edita ni se anula: un error se corrige con una devolución al proveedor (Fase 3,
--         pendiente). Su asiento, inventario contra "mercancía recibida no facturada", sale del motor.
--   R-BB  La orden guarda el criterio con que se repartirán los gastos de importación (valor, peso, volumen o
--         cantidad). Con peso o volumen, todos sus productos deben tener esa medida (migración 0022).
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values
  ('orden_compra', 'A', '', 1),
  ('recepcion', 'A', '', 1);

create table documento_compra (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null check (tipo in ('orden_compra', 'recepcion')),
  serie            varchar(4) not null default 'A',
  numero           bigint,                                           -- lo asigna el numerador
  -- Orden: borrador → pendiente (enviada) → aprobada | rechazada | anulada. Recepción: borrador → emitido.
  estado           text not null default 'borrador'
                   check (estado in ('borrador', 'pendiente', 'aprobada', 'rechazada', 'anulada', 'emitido')),
  proveedor_id     uuid not null references proveedor(tercero_id),
  almacen_id       uuid not null references almacen(id),             -- donde se recibe
  orden_id         uuid references documento_compra(id),             -- recepción → orden de compra
  moneda           char(3) not null default 'USD' references moneda(codigo),
  tasa             numeric(18,6) check (tasa > 0),                   -- VES por unidad de la moneda, congelada al enviar o recibir
  criterio_reparto text not null default 'valor' check (criterio_reparto in ('valor', 'peso', 'volumen', 'cantidad')),
  fecha_emision    timestamptz,
  fecha_prometida  date,                                             -- entrega prometida por el proveedor (§catálogo de decisiones)
  subtotal         numeric(16,2) not null default 0,
  total            numeric(16,2) not null default 0,                 -- en la moneda del documento (sin IVA: lo trae la factura)
  total_usd        numeric(16,2) not null default 0,
  observaciones    text,
  aprobado_por     uuid references usuario(id),
  aprobado_at      timestamptz,
  rechazo_motivo   text,
  anulado_por      uuid references usuario(id),
  anulado_at       timestamptz,
  anulado_motivo   text,
  created_by       uuid not null references usuario(id),
  created_at       timestamptz not null default now(),
  unique (tipo, serie, numero),
  check ((tipo = 'orden_compra' and estado <> 'emitido') or (tipo = 'recepcion' and estado in ('borrador', 'emitido'))),
  check ((estado = 'borrador') = (numero is null)),
  check (estado = 'borrador' or (tasa is not null and fecha_emision is not null)),
  check ((tipo = 'recepcion') = (orden_id is not null)),
  check (estado <> 'aprobada' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2),
  check (estado <> 'anulada' or length(trim(coalesce(anulado_motivo, ''))) > 2)
);
create index documento_compra_proveedor_idx on documento_compra (proveedor_id, tipo, estado);
create index documento_compra_orden_idx on documento_compra (orden_id);
create index documento_compra_almacen_idx on documento_compra (almacen_id, tipo, estado);

create table documento_compra_linea (
  id                 uuid primary key default gen_random_uuid(),
  documento_id       uuid not null references documento_compra(id) on delete cascade,
  linea              int not null check (linea > 0),
  producto_id        uuid not null references producto(id),
  descripcion        text not null,
  cantidad           numeric(14,4) not null check (cantidad > 0),
  precio_unitario    numeric(16,4) not null check (precio_unitario >= 0),   -- en la moneda del documento
  total              numeric(16,2) not null default 0,
  linea_origen_id    uuid references documento_compra_linea(id),            -- línea de recepción → línea de orden
  -- Recepción: lo que entró al inventario (la foto del costo, en USD).
  costo_unitario_usd numeric(16,4),
  costo_total_usd    numeric(16,2),
  unique (documento_id, linea),
  unique (documento_id, producto_id)
);
create index documento_compra_linea_producto_idx on documento_compra_linea (producto_id);
create index documento_compra_linea_origen_idx on documento_compra_linea (linea_origen_id);

-- Cantidad ya recibida de una línea de orden (recepciones emitidas).
create function fn_orden_linea_recibida(p_linea uuid) returns numeric
language sql stable as $$
  select coalesce(sum(r.cantidad), 0)
    from documento_compra_linea r join documento_compra d on d.id = r.documento_id and d.estado = 'emitido'
   where r.linea_origen_id = p_linea
$$;

-- ---------------------------------------------------------------------
-- Reglas del encabezado
-- ---------------------------------------------------------------------
create function fn_documento_compra_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'aprobado_por', 'aprobado_at', 'rechazo_motivo', 'anulado_por', 'anulado_at', 'anulado_motivo'];
  v_orden  documento_compra%rowtype;
  v_l      record;
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un documento de compra nace en borrador';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un documento de compra necesita el usuario que lo crea';
    end if;
    if not exists (select 1 from proveedor where tercero_id = new.proveedor_id and estado = 'activo') then
      raise exception 'El proveedor debe estar activo para comprarle';
    end if;
    if new.tipo = 'recepcion' then
      select * into v_orden from documento_compra where id = new.orden_id and tipo = 'orden_compra';
      if not found or v_orden.estado <> 'aprobada' then
        raise exception 'Solo se recibe contra una orden de compra aprobada';
      end if;
      if v_orden.proveedor_id <> new.proveedor_id then
        raise exception 'La recepción debe ser del mismo proveedor de la orden';
      end if;
      new.moneda := v_orden.moneda;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un documento de compra emitido no se borra: se anula con su motivo';
    end if;
    return old;
  end if;

  -- Borrador: se edita libre y pasa a pendiente (orden) o emitido (recepción), asignando su número.
  if old.estado = 'borrador' then
    if new.estado = 'borrador' then
      return new;
    end if;
    if not exists (select 1 from documento_compra_linea where documento_id = old.id) then
      raise exception 'No se puede emitir un documento sin líneas';
    end if;
    if old.tipo = 'orden_compra' and new.estado <> 'pendiente' then
      raise exception 'Una orden de compra en borrador solo pasa a pendiente';
    end if;
    if old.tipo = 'recepcion' then
      if new.estado <> 'emitido' then
        raise exception 'Una recepción en borrador solo pasa a emitida';
      end if;
      -- R-AZ: con la orden bloqueada, nada se recibe por encima de lo pendiente.
      select * into v_orden from documento_compra where id = old.orden_id for update;
      if v_orden.estado <> 'aprobada' then
        raise exception 'Solo se recibe contra una orden de compra aprobada';
      end if;
      for v_l in
        select l.producto_id, l.cantidad, o.cantidad as ordenada, fn_orden_linea_recibida(o.id) as recibida
          from documento_compra_linea l join documento_compra_linea o on o.id = l.linea_origen_id
         where l.documento_id = old.id
      loop
        if v_l.recibida + v_l.cantidad > v_l.ordenada then
          raise exception 'No se puede recibir más de lo pendiente de la orden (ordenado %, ya recibido %, esta recepción %)',
            v_l.ordenada, v_l.recibida, v_l.cantidad;
        end if;
      end loop;
    end if;
    new.numero := fn_siguiente_numero(new.tipo, new.serie);
    new.fecha_emision := now();
    return new;
  end if;

  if old.estado in ('rechazada', 'anulada') then
    raise exception 'Un documento de compra % no se modifica', old.estado;
  end if;
  if old.estado = 'emitido' then
    raise exception 'Una recepción emitida no se edita ni se anula: se corrige con una devolución al proveedor';
  end if;

  -- Orden enviada: solo cambian el estado y los datos de la decisión.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Una orden de compra enviada no se edita: se anula con su motivo o se corrige con otra orden';
  end if;
  if old.estado = 'pendiente' and new.estado = 'aprobada' then
    -- R-AY: aprueba un usuario activo con el rol Gerencia que no creó la orden.
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar una orden de compra';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien creó la orden de compra no la aprueba';
    end if;
    new.aprobado_at := now();
  elsif old.estado = 'pendiente' and new.estado = 'rechazada' then
    null;
  elsif new.estado = 'anulada' and old.estado in ('pendiente', 'aprobada') then
    if exists (select 1 from documento_compra r where r.orden_id = old.id and r.estado = 'emitido') then
      raise exception 'La orden ya tiene mercancía recibida: no se anula';
    end if;
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := coalesce(new.anulado_at, now());
  else
    raise exception 'Cambio de estado no permitido: de % a %', old.estado, new.estado;
  end if;
  return new;
end $$;

create trigger documento_compra_antes
  before insert or update or delete on documento_compra
  for each row execute function fn_documento_compra_antes();

create function fn_documento_compra_linea_antes() returns trigger
language plpgsql as $$
declare
  v_doc  documento_compra%rowtype;
  v_ori  documento_compra_linea%rowtype;
begin
  select * into v_doc from documento_compra where id = coalesce(new.documento_id, old.documento_id);
  -- Si el encabezado ya no existe, es el borrado en cascada de un borrador.
  if found and v_doc.estado <> 'borrador' then
    raise exception 'Las líneas de un documento de compra enviado o emitido no se modifican';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if not exists (select 1 from producto where id = new.producto_id and inventariable and estado = 'activo') then
    raise exception 'Solo se compran productos activos que lleven inventario';
  end if;
  if v_doc.tipo = 'recepcion' then
    select * into v_ori from documento_compra_linea where id = new.linea_origen_id;
    if not found or v_ori.documento_id <> v_doc.orden_id or v_ori.producto_id <> new.producto_id then
      raise exception 'La línea de la recepción debe corresponder a una línea de su orden de compra';
    end if;
  elsif new.linea_origen_id is not null then
    raise exception 'Solo las líneas de una recepción se enlazan con una orden';
  end if;
  return new;
end $$;

create trigger documento_compra_linea_antes
  before insert or update or delete on documento_compra_linea
  for each row execute function fn_documento_compra_linea_antes();

-- Totales de una orden en borrador (la base los calcula, no la aplicación).
create function fn_compra_calcular(p_documento uuid) returns void
language plpgsql as $$
declare
  v_doc  documento_compra%rowtype;
  v_hoy  date := (now() at time zone 'America/Caracas')::date;
  v_tasa numeric;
  v_usd  numeric;
begin
  select * into v_doc from documento_compra where id = p_documento for update;
  if not found then
    raise exception 'El documento no existe';
  end if;
  if v_doc.estado <> 'borrador' then
    raise exception 'Solo se calculan los documentos en borrador';
  end if;
  update documento_compra_linea set total = round(cantidad * precio_unitario, 2) where documento_id = p_documento;
  v_tasa := fn_tasa(v_doc.moneda, v_hoy);
  v_usd := fn_tasa('USD', v_hoy);
  update documento_compra d set
    subtotal  = coalesce(s.total, 0),
    total     = coalesce(s.total, 0),
    total_usd = round(coalesce(s.total, 0) * v_tasa / v_usd, 2),
    tasa      = v_tasa
    from (select sum(total) as total from documento_compra_linea where documento_id = p_documento) s
   where d.id = p_documento;
end $$;

-- ---------------------------------------------------------------------
-- Flujo de aprobación: Gerencia, distinta de quien creó la orden (§4.5).
-- Todavía no hay umbral por monto (§7 pide "aprobación por monto"): toda orden pasa por Gerencia
-- hasta que se definan los montos en Configuración → Flujos.
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values ('orden_compra', 'Orden de compra');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'orden_compra';

-- Regla contable (§7.2, regla 2): la recepción valoriza el inventario contra la cuenta puente.
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, 'costo', v.glosa
  from (values
    ('recepcion_compra', 1, 'D', '1.3.01', 'Entrada de mercancía al inventario'),
    ('recepcion_compra', 2, 'H', '2.1.02', 'Mercancía recibida no facturada')) as v(evento, orden, lado, codigo, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger documento_compra_audit       after insert or update or delete on documento_compra       for each row execute function fn_audit();
create trigger documento_compra_linea_audit after insert or update or delete on documento_compra_linea for each row execute function fn_audit();
