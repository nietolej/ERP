-- =====================================================================
-- 0019 · Datos que se capturan desde el primer día para poder decidir (docs/catalogo_decisiones.md)
--
--   R-AP  La existencia de cada día queda registrada por el propio sistema: cada cambio de existencia o de
--         costo actualiza la fila del día, así que no depende de ningún proceso programado y el cierre de
--         cada día es siempre el último valor del día. Solo los triggers escriben en estas tablas.
--   R-AQ  Los motivos son catálogos (descuento, devolución, anulación, venta perdida, merma) que administra
--         Gerencia. Un descuento exige motivo, y toda anulación se hace con un motivo del catálogo además
--         de su detalle: así se pueden contar y comparar.
--   R-AR  La demanda no atendida admite registros manuales (venta perdida por precio, plazo o competencia).
--   R-AS  Qué vendedor tuvo cada cliente y desde cuándo queda en un historial que no se reescribe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Existencia y costo al cierre de cada día (R-AP)
-- ---------------------------------------------------------------------
create table existencia_diaria (
  fecha       date not null,
  producto_id uuid not null references producto(id),
  almacen_id  uuid not null references almacen(id),
  cantidad    numeric(14,4) not null,
  reservado   numeric(14,4) not null,
  primary key (fecha, producto_id, almacen_id)
);
create index existencia_diaria_producto_idx on existencia_diaria (producto_id, almacen_id, fecha);

create table costo_diario (
  fecha              date not null,
  producto_id        uuid not null references producto(id),
  cantidad           numeric(14,4) not null,
  valor_usd          numeric(18,2) not null,
  costo_promedio_usd numeric(16,4) not null,
  primary key (fecha, producto_id)
);

create function fn_foto_protegida() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.inventario_interno', true), '') <> '1' then
    raise exception 'El historial diario de existencia y costo lo escribe el sistema: no se edita ni se borra';
  end if;
  return coalesce(new, old);
end $$;

create trigger existencia_diaria_protegida before insert or update or delete on existencia_diaria
  for each row execute function fn_foto_protegida();
create trigger costo_diario_protegido before insert or update or delete on costo_diario
  for each row execute function fn_foto_protegida();

create function fn_existencia_foto() returns trigger
language plpgsql as $$
begin
  perform set_config('app.inventario_interno', '1', true);
  insert into existencia_diaria (fecha, producto_id, almacen_id, cantidad, reservado)
  values (((now() at time zone 'America/Caracas')::date), new.producto_id, new.almacen_id, new.cantidad, new.reservado)
  on conflict (fecha, producto_id, almacen_id) do update set cantidad = excluded.cantidad, reservado = excluded.reservado;
  return null;
end $$;

create trigger existencia_foto after insert or update on existencia
  for each row execute function fn_existencia_foto();

create function fn_costo_foto() returns trigger
language plpgsql as $$
begin
  perform set_config('app.inventario_interno', '1', true);
  insert into costo_diario (fecha, producto_id, cantidad, valor_usd, costo_promedio_usd)
  values (((now() at time zone 'America/Caracas')::date), new.producto_id, new.cantidad, new.valor_usd, new.costo_promedio_usd)
  on conflict (fecha, producto_id) do update
    set cantidad = excluded.cantidad, valor_usd = excluded.valor_usd, costo_promedio_usd = excluded.costo_promedio_usd;
  return null;
end $$;

create trigger costo_foto after insert or update on producto_costo
  for each row execute function fn_costo_foto();

-- Lo que hubiera en el sistema al cierre de una fecha: el último registro de cada producto y almacén hasta ese día.
create function fn_existencia_al(p_fecha date)
returns table (producto_id uuid, almacen_id uuid, cantidad numeric, reservado numeric)
language sql stable as $$
  select distinct on (e.producto_id, e.almacen_id) e.producto_id, e.almacen_id, e.cantidad, e.reservado
    from existencia_diaria e
   where e.fecha <= p_fecha
   order by e.producto_id, e.almacen_id, e.fecha desc
$$;

-- Días del rango en que el producto tuvo existencia para vender (almacenes que permiten vender). Un día sin
-- movimientos conserva la existencia del día anterior. Antes del primer registro del producto no se cuenta:
-- no hay dato. Es el denominador de la velocidad de venta ajustada por los días con existencia (§8.3).
create function fn_dias_con_existencia(p_producto uuid, p_desde date, p_hasta date) returns int
language sql stable as $$
  select count(*)::int
    from generate_series(p_desde, p_hasta, interval '1 day') d(dia)
   where coalesce((
           select sum(u.cantidad)
             from (select distinct on (e.almacen_id) e.almacen_id, e.cantidad
                     from existencia_diaria e join almacen a on a.id = e.almacen_id and a.permite_venta
                    where e.producto_id = p_producto and e.fecha <= d.dia::date
                    order by e.almacen_id, e.fecha desc) u), 0) > 0
$$;

-- Respaldo de lo que ya existe al migrar (bases de desarrollo): la foto de hoy.
select set_config('app.inventario_interno', '1', false);
insert into existencia_diaria (fecha, producto_id, almacen_id, cantidad, reservado)
select ((now() at time zone 'America/Caracas')::date), producto_id, almacen_id, cantidad, reservado from existencia
on conflict do nothing;
insert into costo_diario (fecha, producto_id, cantidad, valor_usd, costo_promedio_usd)
select ((now() at time zone 'America/Caracas')::date), producto_id, cantidad, valor_usd, costo_promedio_usd from producto_costo
on conflict do nothing;
select set_config('app.inventario_interno', '', false);

-- ---------------------------------------------------------------------
-- Catálogos de motivos (R-AQ)
-- ---------------------------------------------------------------------
create table motivo (
  id      uuid primary key default gen_random_uuid(),
  tipo    text not null check (tipo in ('descuento', 'devolucion', 'anulacion', 'venta_perdida', 'merma')),
  codigo  varchar(30) not null check (codigo ~ '^[A-Z0-9_]+$'),
  nombre  text not null check (length(trim(nombre)) > 2),
  activo  boolean not null default true,
  sistema boolean not null default false,        -- lo usa el propio sistema: no se desactiva ni cambia de código
  unique (tipo, codigo)
);

create function fn_motivo_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un motivo no se borra: se inactiva';
  end if;
  if tg_op = 'UPDATE' then
    if new.tipo <> old.tipo or new.codigo <> old.codigo then
      raise exception 'El tipo y el código de un motivo no se cambian';
    end if;
    if old.sistema and (not new.activo or not new.sistema) then
      raise exception 'El motivo % lo usa el sistema: no se puede desactivar', old.codigo;
    end if;
  end if;
  return new;
end $$;

create trigger motivo_reglas before update or delete on motivo
  for each row execute function fn_motivo_reglas();

-- Configuración inicial: punto de partida editable por Gerencia (se agregan o inactivan motivos en pantalla).
insert into motivo (tipo, codigo, nombre, sistema) values
  ('descuento',     'DESCUENTO_CLIENTE',  'Descuento pactado con el cliente', true),
  ('descuento',     'VOLUMEN',            'Volumen de compra', false),
  ('descuento',     'COMPETENCIA',        'Precio de la competencia', false),
  ('descuento',     'CLIENTE_CLAVE',      'Cliente estratégico', false),
  ('descuento',     'OTRO',               'Otro motivo (explicar)', false),
  ('anulacion',     'ERROR_DIGITACION',   'Error de digitación', false),
  ('anulacion',     'CLIENTE_DESISTIO',   'El cliente desistió', false),
  ('anulacion',     'SIN_EXISTENCIA',     'No hay existencia', false),
  ('anulacion',     'CREDITO_RECHAZADO',  'Rechazado por crédito', true),
  ('anulacion',     'DESPACHO_PARCIAL',   'Despacho parcial por faltante en el picking', true),
  ('anulacion',     'OTRO',               'Otro motivo (explicar)', false),
  ('venta_perdida', 'SIN_EXISTENCIA',     'No había existencia', true),
  ('venta_perdida', 'PRECIO',             'Precio más alto que la competencia', false),
  ('venta_perdida', 'PLAZO_ENTREGA',      'Plazo de entrega', false),
  ('venta_perdida', 'CONDICION_PAGO',     'Condición de pago', false),
  ('venta_perdida', 'OTRO',               'Otro motivo (explicar)', false),
  ('devolucion',    'DEFECTO',            'Producto defectuoso', false),
  ('devolucion',    'ERROR_DESPACHO',     'Error de despacho', false),
  ('devolucion',    'ERROR_PEDIDO',       'Error al hacer el pedido', false),
  ('devolucion',    'GARANTIA',           'Garantía', false),
  ('devolucion',    'DESISTIO',           'El cliente desistió', false),
  ('devolucion',    'OTRO',               'Otro motivo (explicar)', false),
  ('merma',         'DANO',               'Daño o rotura', false),
  ('merma',         'ERROR_CONTEO',       'Diferencia de conteo', false),
  ('merma',         'OTRO',               'Otro motivo (explicar)', false);

create trigger motivo_audit after insert or update on motivo for each row execute function fn_audit();

-- Un motivo de un tipo se usa solo donde corresponde y mientras está activo.
create function fn_motivo_valido(p_motivo uuid, p_tipo text) returns void
language plpgsql as $$
declare
  v motivo%rowtype;
begin
  select * into v from motivo where id = p_motivo;
  if not found or v.tipo <> p_tipo then
    raise exception 'El motivo no corresponde (se esperaba uno de tipo %)', p_tipo;
  end if;
  if not v.activo then
    raise exception 'El motivo "%" está inactivo', v.nombre;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Motivo del descuento en cada línea de venta
-- ---------------------------------------------------------------------
alter table documento_venta_linea
  add column motivo_descuento_id uuid references motivo(id),
  add constraint documento_venta_linea_motivo_descuento check (descuento_pct = 0 or motivo_descuento_id is not null) not valid;

create function fn_documento_venta_linea_motivo() returns trigger
language plpgsql as $$
begin
  if new.motivo_descuento_id is not null and (tg_op = 'INSERT' or new.motivo_descuento_id is distinct from old.motivo_descuento_id) then
    perform fn_motivo_valido(new.motivo_descuento_id, 'descuento');
  end if;
  return new;
end $$;

create trigger documento_venta_linea_motivo before insert or update on documento_venta_linea
  for each row execute function fn_documento_venta_linea_motivo();

-- ---------------------------------------------------------------------
-- Motivo de la anulación de un documento (además del detalle escrito)
-- ---------------------------------------------------------------------
alter table documento_venta
  add column anulado_motivo_id uuid references motivo(id),
  add constraint documento_venta_anulado_motivo check (estado <> 'anulado' or anulado_motivo_id is not null) not valid;

create or replace function fn_documento_venta_antes() returns trigger
language plpgsql as $$
declare
  v_libres text[] := array['estado', 'situacion', 'aprobado_por', 'aprobado_at', 'anulado_por', 'anulado_at', 'anulado_motivo',
                           'anulado_motivo_id', 'salida_at', 'salida_por'];
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

  -- Emitido: solo cambian el estado, la situación y los datos de aprobación, salida o anulación.
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Un documento emitido no se edita: se anula con su motivo o se corrige con otro documento';
  end if;
  if new.estado = 'borrador' then
    raise exception 'Un documento emitido no vuelve a borrador';
  end if;
  if new.estado = 'anulado' and old.salida_at is not null then
    raise exception 'La mercancía de una nota de entrega despachada ya salió: no se anula, se corrige con una devolución';
  end if;
  if old.salida_at is not null and (new.salida_at is distinct from old.salida_at or new.salida_por is distinct from old.salida_por) then
    raise exception 'La salida de una nota de entrega no se modifica';
  end if;
  if new.estado = 'anulado' then
    perform fn_motivo_valido(new.anulado_motivo_id, 'anulacion');
    new.anulado_por := coalesce(new.anulado_por, fn_usuario_actual());
    new.anulado_at := coalesce(new.anulado_at, now());
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Demanda no atendida: motivo y registro manual de ventas perdidas (R-AR)
-- ---------------------------------------------------------------------
alter table demanda_no_atendida
  add column motivo_id   uuid references motivo(id),
  add column observacion text,
  add column created_by  uuid references usuario(id),
  alter column documento_id drop not null,
  alter column linea_id drop not null,
  add constraint demanda_no_atendida_documento_linea check ((documento_id is null) = (linea_id is null));

alter table demanda_no_atendida disable trigger demanda_no_atendida_inmutable;
update demanda_no_atendida set motivo_id = (select id from motivo where tipo = 'venta_perdida' and codigo = 'SIN_EXISTENCIA');
alter table demanda_no_atendida enable trigger demanda_no_atendida_inmutable;
alter table demanda_no_atendida alter column motivo_id set not null;

create function fn_demanda_motivo() returns trigger
language plpgsql as $$
begin
  perform fn_motivo_valido(new.motivo_id, 'venta_perdida');
  new.created_by := coalesce(new.created_by, fn_usuario_actual());
  return new;
end $$;

create trigger demanda_motivo before insert on demanda_no_atendida
  for each row execute function fn_demanda_motivo();

-- ---------------------------------------------------------------------
-- Historial de cartera: qué vendedor tuvo cada cliente y desde cuándo (R-AS)
-- ---------------------------------------------------------------------
create table cliente_vendedor_historial (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references cliente(tercero_id),
  vendedor_id  uuid not null references vendedor(id),
  desde        timestamptz not null default now(),
  hasta        timestamptz,
  cambiado_por uuid references usuario(id),
  check (hasta is null or hasta >= desde)
);
create unique index cliente_vendedor_vigente on cliente_vendedor_historial (cliente_id) where hasta is null;
create index cliente_vendedor_historial_idx on cliente_vendedor_historial (cliente_id, desde);

create function fn_cliente_vendedor_historial_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El historial de cartera no se borra';
  end if;
  if new.cliente_id <> old.cliente_id or new.vendedor_id <> old.vendedor_id or new.desde <> old.desde or old.hasta is not null then
    raise exception 'El historial de cartera solo se cierra con su fecha de fin';
  end if;
  return new;
end $$;

create trigger cliente_vendedor_historial_reglas before update or delete on cliente_vendedor_historial
  for each row execute function fn_cliente_vendedor_historial_reglas();

create function fn_cliente_vendedor_registrar() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.vendedor_id is not distinct from old.vendedor_id then
      return null;
    end if;
    update cliente_vendedor_historial set hasta = now() where cliente_id = new.tercero_id and hasta is null;
  end if;
  if new.vendedor_id is not null then
    insert into cliente_vendedor_historial (cliente_id, vendedor_id, cambiado_por) values (new.tercero_id, new.vendedor_id, fn_usuario_actual());
  end if;
  return null;
end $$;

create trigger cliente_vendedor_registrar after insert or update of vendedor_id on cliente
  for each row execute function fn_cliente_vendedor_registrar();

-- Vendedor que tenía un cliente en un momento dado (null si no tenía).
create function fn_vendedor_de_cliente(p_cliente uuid, p_momento timestamptz) returns uuid
language sql stable as $$
  select vendedor_id from cliente_vendedor_historial
   where cliente_id = p_cliente and desde <= p_momento and (hasta is null or hasta > p_momento)
   order by desde desc limit 1
$$;

-- Clientes que ya existían al migrar (bases de desarrollo).
insert into cliente_vendedor_historial (cliente_id, vendedor_id, desde)
select tercero_id, vendedor_id, created_at from cliente where vendedor_id is not null;

create trigger cliente_vendedor_historial_audit after insert or update on cliente_vendedor_historial
  for each row execute function fn_audit();
