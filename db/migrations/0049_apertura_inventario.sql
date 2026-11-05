-- =====================================================================
-- 0049 · Conteo físico inicial de inventario (spec §14.3)
--
--   R-DK  El inventario con que arranca la empresa se registra por almacén, con el conteo físico del día anterior al arranque: Almacén
--         cuenta (producto y cantidad), Contabilidad fija el costo unitario en USD de cada línea y Gerencia aprueba. Un conteo por almacén.
--   R-DL  Al aprobar, en una sola transacción: una entrada de inventario tipo «apertura» por línea, al costo fijado, con la fecha de
--         arranque, y su asiento (Inventario contra Saldos de apertura). Esas entradas no son compras ni ventas.
--   R-DM  Gerencia, distinta de quien registró el conteo y de quien fijó los costos, lo aprueba. Hasta entonces no mueve nada.
--         El cierre de la apertura exige que no haya conteos pendientes; cerrada, no se aceptan más.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('apertura_inventario', 'A', '', 1);

create table apertura_inventario (
  id             uuid primary key default gen_random_uuid(),
  numero         bigint not null unique,
  almacen_id     uuid not null references almacen(id),
  fecha          date not null,                                         -- fecha de arranque
  observaciones  text,
  estado         text not null default 'borrador' check (estado in ('borrador', 'pendiente', 'aprobado', 'rechazado')),
  created_by     uuid not null references usuario(id),
  created_at     timestamptz not null default now(),
  costos_por     uuid references usuario(id),                           -- quien fijó el costo de la última línea
  aprobado_por   uuid references usuario(id),
  aprobado_at    timestamptz,
  rechazo_motivo text,
  check (estado <> 'aprobado' or (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index apertura_inventario_almacen_unico on apertura_inventario (almacen_id) where estado in ('borrador', 'pendiente', 'aprobado');

create table apertura_inventario_linea (
  id                 uuid primary key default gen_random_uuid(),
  apertura_id        uuid not null references apertura_inventario(id),
  linea              int not null check (linea > 0),
  producto_id        uuid not null references producto(id),
  cantidad           numeric(14,4) not null check (cantidad > 0),
  costo_unitario_usd numeric(16,4) check (costo_unitario_usd >= 0),     -- lo fija Contabilidad
  unique (apertura_id, producto_id),
  unique (apertura_id, linea)
);

create function fn_apertura_inventario_antes() returns trigger
language plpgsql as $$
declare
  a      arranque%rowtype;
  v_n    int;
  v_sin  int;
  v_aprob uuid;
begin
  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un conteo inicial enviado no se borra: se rechaza';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    select * into a from arranque where id = 1;
    if a.fecha_arranque is null then
      raise exception 'Gerencia debe fijar primero la fecha de arranque';
    end if;
    if a.cerrada_at is not null then
      raise exception 'La apertura está cerrada: no se registran más documentos de apertura';
    end if;
    if new.estado <> 'borrador' then
      raise exception 'Un conteo inicial nace en borrador';
    end if;
    if not exists (select 1 from almacen where id = new.almacen_id and activo) then
      raise exception 'El almacén debe existir y estar activo';
    end if;
    new.fecha := a.fecha_arranque;
    new.numero := fn_siguiente_numero('apertura_inventario', 'A');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un conteo inicial necesita el usuario que lo registra';
    end if;
    new.costos_por := null; new.aprobado_por := null; new.aprobado_at := null; new.rechazo_motivo := null;
    return new;
  end if;

  if (to_jsonb(new) - 'estado' - 'costos_por' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo' - 'observaciones')
     is distinct from (to_jsonb(old) - 'estado' - 'costos_por' - 'aprobado_por' - 'aprobado_at' - 'rechazo_motivo' - 'observaciones') then
    raise exception 'Los datos de un conteo inicial no se cambian';
  end if;
  if new.estado = old.estado then
    if old.estado <> 'borrador' and (new.costos_por is distinct from old.costos_por or new.observaciones is distinct from old.observaciones) then
      raise exception 'Un conteo inicial enviado no se edita';
    end if;
    new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at; new.rechazo_motivo := old.rechazo_motivo;
    return new;
  end if;
  if old.estado = 'borrador' and new.estado = 'pendiente' then
    select count(*), count(*) filter (where costo_unitario_usd is null) into v_n, v_sin from apertura_inventario_linea where apertura_id = old.id;
    if v_n = 0 then
      raise exception 'Agregue al menos un producto contado antes de enviar el conteo';
    end if;
    if v_sin > 0 then
      raise exception 'Contabilidad debe fijar el costo de las % líneas que todavía no lo tienen', v_sin;
    end if;
    return new;
  elsif old.estado = 'pendiente' and new.estado = 'aprobado' then
    v_aprob := new.aprobado_por;
    new.aprobado_por := coalesce(v_aprob, fn_usuario_actual());
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar el conteo inicial';
    end if;
    if new.aprobado_por = old.created_by or new.aprobado_por is not distinct from old.costos_por then
      raise exception 'Quien registró el conteo o fijó sus costos no lo aprueba';
    end if;
    new.aprobado_at := now();
    new.rechazo_motivo := null;
    return new;
  elsif old.estado = 'pendiente' and new.estado = 'rechazado' then
    new.aprobado_por := null; new.aprobado_at := null;
    return new;
  end if;
  raise exception 'Cambio de estado no permitido: de % a %', old.estado, new.estado;
end $$;
create trigger apertura_inventario_antes before insert or update or delete on apertura_inventario
  for each row execute function fn_apertura_inventario_antes();

create function fn_apertura_inventario_linea_antes() returns trigger
language plpgsql as $$
declare
  c apertura_inventario%rowtype;
  v_inv boolean;
  v_usuario uuid;
begin
  select * into c from apertura_inventario where id = coalesce(new.apertura_id, old.apertura_id);
  if c.id is not null and c.estado <> 'borrador' then
    raise exception 'Las líneas de un conteo enviado no se modifican';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'INSERT' or new.producto_id <> old.producto_id or new.cantidad <> old.cantidad then
    select inventariable into v_inv from producto where id = new.producto_id;
    if v_inv is distinct from true then
      raise exception 'Solo se cuentan productos inventariables';
    end if;
  end if;
  -- El costo lo fija Contabilidad (o Gerencia) y queda registrado quién.
  if (tg_op = 'INSERT' and new.costo_unitario_usd is not null) or (tg_op = 'UPDATE' and new.costo_unitario_usd is distinct from old.costo_unitario_usd) then
    v_usuario := fn_usuario_actual();
    if v_usuario is null or not (fn_tiene_rol(v_usuario, 'contabilidad') or fn_tiene_rol(v_usuario, 'jefe_contabilidad') or fn_tiene_rol(v_usuario, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia fijan el costo del conteo inicial';
    end if;
    update apertura_inventario set costos_por = v_usuario where id = new.apertura_id;
  end if;
  return new;
end $$;
create trigger apertura_inventario_linea_antes before insert or update or delete on apertura_inventario_linea
  for each row execute function fn_apertura_inventario_linea_antes();

insert into flujo_definicion (objeto_tipo, nombre) values ('apertura_inventario', 'Conteo físico inicial de inventario');
insert into flujo_paso (definicion_id, orden, rol_aprobador) select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'apertura_inventario';

insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, v.importe, v.glosa
  from (values
    ('apertura_inventario', 1, 'D', '1.3.01', 'monto', 'Inventario inicial (conteo físico)'),
    ('apertura_inventario', 2, 'H', '3.9.01', 'monto', 'Saldos de apertura')) as v(evento, orden, lado, codigo, importe, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

-- El cierre de la apertura también espera los conteos de inventario.
create or replace function fn_arranque_antes() returns trigger
language plpgsql as $$
declare
  v_ves numeric;
  v_usd numeric;
  v_pend int;
  v_dif numeric;
begin
  if tg_op <> 'UPDATE' then
    raise exception 'El arranque no se crea ni se borra: se configura';
  end if;
  if old.fecha_arranque is not null and new.fecha_arranque is distinct from old.fecha_arranque then
    raise exception 'La fecha de arranque se fija una sola vez';
  end if;
  if old.fecha_arranque is null and new.fecha_arranque is not null then
    new.fijada_por := coalesce(new.fijada_por, fn_usuario_actual());
    if new.fijada_por is null or not fn_tiene_rol(new.fijada_por, 'gerencia') then
      raise exception 'Solo Gerencia fija la fecha de arranque';
    end if;
    new.fijada_at := now();
  end if;
  if old.cerrada_at is not null and (new.cerrada_at is distinct from old.cerrada_at or new.cerrada_por is distinct from old.cerrada_por) then
    raise exception 'La apertura ya está cerrada';
  end if;
  if old.cerrada_at is null and new.cerrada_por is not null then
    new.cerrada_por := coalesce(new.cerrada_por, fn_usuario_actual());
    if not fn_tiene_rol(new.cerrada_por, 'gerencia') then
      raise exception 'Solo Gerencia cierra la apertura';
    end if;
    if new.fecha_arranque is null then
      raise exception 'Fije primero la fecha de arranque';
    end if;
    select (select count(*) from apertura_banco where estado = 'pendiente') + (select count(*) from apertura_cxc where estado = 'pendiente')
         + (select count(*) from apertura_cxp where estado = 'pendiente') + (select count(*) from apertura_inventario where estado in ('borrador', 'pendiente')) into v_pend;
    if v_pend > 0 then
      raise exception 'Quedan % documentos de apertura sin aprobar', v_pend;
    end if;
    select coalesce(sum(l.debe_ves - l.haber_ves), 0), coalesce(sum(l.debe_usd - l.haber_usd), 0) into v_ves, v_usd
      from asiento_linea l join asiento a on a.id = l.asiento_id and a.estado = 'contabilizado' join cuenta_contable c on c.id = l.cuenta_id where c.codigo = '3.9.01';
    -- En bolívares: el residuo en dólares sale de mezclar tasas históricas con la del arranque y solo se informa (el mayor cuadra en cada moneda).
    if v_ves <> 0 then
      raise exception 'Saldos de apertura debe quedar en cero (hoy: Bs %): falta el asiento de apertura del contador', v_ves;
    end if;
    select abs(diferencia_ves) + abs(diferencia_usd) into v_dif from vw_control_cuadre;
    if coalesce(v_dif, 0) <> 0 then
      raise exception 'El mayor no cuadra: no se cierra la apertura';
    end if;
    new.cerrada_at := now();
  end if;
  return new;
end $$;

create trigger apertura_inventario_audit        after insert or update on apertura_inventario        for each row execute function fn_audit();
create trigger apertura_inventario_linea_audit  after insert or update or delete on apertura_inventario_linea for each row execute function fn_audit();
