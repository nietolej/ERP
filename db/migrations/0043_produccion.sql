-- =====================================================================
-- 0043 · Producción o ensamblaje: órdenes simples (spec §8.4, decisión 12)
--
--   R-CQ  Orden simple, sin listas de materiales: indica el producto terminado, la cantidad, el almacén y los componentes con su cantidad.
--         Estados: borrador → pendiente (enviada a Gerencia) → liberada → en_proceso → terminada; o rechazada / anulada.
--   R-CR  La libera Gerencia, distinta de quien la creó. Liberar no reserva nada: la existencia se verifica al terminar.
--   R-CS  Al terminar, en una sola transacción: los componentes salen del almacén de la orden al costo promedio vigente y el producto
--         terminado entra al costo de la suma de esos costos. No se consume más de lo disponible ni se termina con un componente faltante.
--         Terminada no se modifica. (Mano de obra y gastos indirectos: pendiente.)
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('orden_produccion', 'A', '', 1);

create table orden_produccion (
  id                uuid primary key default gen_random_uuid(),
  numero            bigint not null unique,
  estado            text not null default 'borrador' check (estado in ('borrador', 'pendiente', 'liberada', 'en_proceso', 'terminada', 'rechazada', 'anulada')),
  producto_id       uuid not null references producto(id),              -- el producto terminado
  cantidad          numeric(14,4) not null check (cantidad > 0),
  almacen_id        uuid not null references almacen(id),
  observaciones     text,
  created_by        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  aprobado_por      uuid references usuario(id),
  aprobado_at       timestamptz,
  rechazo_motivo    text,
  iniciada_por      uuid references usuario(id),
  iniciada_at       timestamptz,
  terminada_por     uuid references usuario(id),
  terminada_at      timestamptz,
  costo_total_usd   numeric(16,2),                                      -- suma de los componentes consumidos
  costo_unitario_usd numeric(16,4),                                     -- costo con que entró el terminado
  anulada_por       uuid references usuario(id),
  anulada_at        timestamptz,
  anulado_motivo    text,
  check (estado not in ('liberada', 'en_proceso', 'terminada') or (aprobado_por is not null and aprobado_at is not null)),
  check (estado not in ('en_proceso', 'terminada') or iniciada_at is not null),
  check ((estado = 'terminada') = (terminada_at is not null and costo_total_usd is not null and costo_unitario_usd is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2),
  check ((estado = 'anulada') = (anulada_at is not null)),
  check (estado <> 'anulada' or (anulada_por is not null and length(trim(coalesce(anulado_motivo, ''))) > 2))
);
create index orden_produccion_estado_idx on orden_produccion (estado, almacen_id);

create table orden_produccion_componente (
  id              uuid primary key default gen_random_uuid(),
  orden_id        uuid not null references orden_produccion(id),
  linea           int not null check (linea > 0),
  producto_id     uuid not null references producto(id),
  cantidad        numeric(14,4) not null check (cantidad > 0),          -- total que consume la orden
  costo_total_usd numeric(16,2),                                        -- se llena al terminar (consumo al costo promedio)
  unique (orden_id, producto_id),
  unique (orden_id, linea)
);

create function fn_orden_produccion_antes() returns trigger
language plpgsql as $$
declare
  v_inv boolean;
  v_n   int;
  v_aprob uuid;
begin
  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Una orden de producción enviada no se borra: se anula';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Una orden de producción nace en borrador';
    end if;
    select inventariable into v_inv from producto where id = new.producto_id;
    if v_inv is distinct from true then
      raise exception 'El producto terminado debe ser inventariable';
    end if;
    if not exists (select 1 from almacen where id = new.almacen_id and activo) then
      raise exception 'El almacén de la orden debe estar activo';
    end if;
    new.numero := fn_siguiente_numero('orden_produccion', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una orden de producción necesita el usuario que la crea';
    end if;
    return new;
  end if;

  if old.estado in ('terminada', 'rechazada', 'anulada') then
    raise exception 'Una orden de producción % no se modifica', old.estado;
  end if;
  if new.estado = old.estado and old.estado <> 'borrador' then
    if (to_jsonb(new)) is distinct from (to_jsonb(old)) then
      raise exception 'Una orden de producción enviada no se edita';
    end if;
    return new;
  end if;
  if new.estado = 'borrador' and old.estado = 'borrador' then
    return new;
  end if;
  -- Desde aquí hay un cambio de estado: los datos de la orden no cambian.
  if (new.producto_id, new.cantidad, new.almacen_id, new.created_by, new.numero) is distinct from (old.producto_id, old.cantidad, old.almacen_id, old.created_by, old.numero) then
    raise exception 'Los datos de una orden enviada no se cambian';
  end if;

  if new.estado = 'anulada' then
    new.anulada_por := coalesce(new.anulada_por, fn_usuario_actual());
    new.anulada_at := now();
    return new;
  end if;
  if old.estado = 'borrador' and new.estado = 'pendiente' then
    select count(*) into v_n from orden_produccion_componente where orden_id = old.id;
    if v_n = 0 then
      raise exception 'Agregue al menos un componente antes de enviar la orden';
    end if;
    return new;
  elsif old.estado = 'pendiente' and new.estado = 'liberada' then
    v_aprob := new.aprobado_por;
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede liberar una orden de producción';
    end if;
    if new.aprobado_por = old.created_by then
      raise exception 'Quien creó la orden no la libera';
    end if;
    new.aprobado_at := now();
    return new;
  elsif old.estado = 'pendiente' and new.estado = 'rechazada' then
    return new;
  elsif old.estado = 'liberada' and new.estado = 'en_proceso' then
    new.iniciada_por := coalesce(new.iniciada_por, fn_usuario_actual());
    new.iniciada_at := now();
    return new;
  elsif old.estado = 'en_proceso' and new.estado = 'terminada' then
    if not exists (select 1 from movimiento_inventario where origen_tipo = 'orden_produccion' and origen_id = old.id and tipo = 'entrada_produccion') then
      raise exception 'Una orden no se termina sin la entrada del producto terminado';
    end if;
    if exists (select 1 from orden_produccion_componente where orden_id = old.id and costo_total_usd is null) then
      raise exception 'Una orden no se termina sin el consumo de todos sus componentes';
    end if;
    new.terminada_por := coalesce(new.terminada_por, fn_usuario_actual());
    new.terminada_at := now();
    return new;
  end if;
  raise exception 'Cambio de estado no permitido: de % a %', old.estado, new.estado;
end $$;
create trigger orden_produccion_antes before insert or update or delete on orden_produccion
  for each row execute function fn_orden_produccion_antes();

create function fn_orden_produccion_componente_antes() returns trigger
language plpgsql as $$
declare
  o orden_produccion%rowtype;
  v_inv boolean;
begin
  select * into o from orden_produccion where id = coalesce(new.orden_id, old.orden_id);
  if tg_op = 'UPDATE' and old.costo_total_usd is null and new.costo_total_usd is not null and o.estado = 'en_proceso'
     and (new.orden_id, new.linea, new.producto_id, new.cantidad) is not distinct from (old.orden_id, old.linea, old.producto_id, old.cantidad) then
    return new;                                    -- el consumo registra su costo al terminar
  end if;
  if o.id is not null and o.estado <> 'borrador' then
    raise exception 'Los componentes de una orden enviada no se modifican';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select inventariable into v_inv from producto where id = new.producto_id;
  if v_inv is distinct from true then
    raise exception 'Los componentes deben ser productos inventariables';
  end if;
  if new.producto_id = o.producto_id then
    raise exception 'Un producto no puede ser componente de sí mismo';
  end if;
  if new.costo_total_usd is not null then
    raise exception 'El costo del consumo lo registra la terminación de la orden';
  end if;
  return new;
end $$;
create trigger orden_produccion_componente_antes before insert or update or delete on orden_produccion_componente
  for each row execute function fn_orden_produccion_componente_antes();

-- Flujo de aprobación: Gerencia libera, distinta de quien creó la orden (R-CR)
insert into flujo_definicion (objeto_tipo, nombre) values ('orden_produccion', 'Orden de producción');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'orden_produccion';

-- Diferencia de redondeo entre el costo de los componentes y el del terminado (el costo unitario lleva 4 decimales).
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('produccion_redondeo_mas',   1, 'D', '1.3.01', 'monto', 'Inventario: el terminado entró por centavos de más'),
    ('produccion_redondeo_mas',   2, 'H', '6.3.03', 'monto', 'Diferencias por redondeo'),
    ('produccion_redondeo_menos', 1, 'D', '6.3.03', 'monto', 'Diferencias por redondeo'),
    ('produccion_redondeo_menos', 2, 'H', '1.3.01', 'monto', 'Inventario: el terminado entró por centavos de menos')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger orden_produccion_audit             after insert or update or delete on orden_produccion             for each row execute function fn_audit();
create trigger orden_produccion_componente_audit  after insert or update or delete on orden_produccion_componente  for each row execute function fn_audit();
