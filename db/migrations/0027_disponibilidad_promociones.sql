-- =====================================================================
-- 0027 · Disponibilidad y velocidad de venta; promociones ligadas a las líneas de venta (§6.1, §8.3, spec_reportes §9.1)
--
--   R-BO  Los días disponibles, los días sin existencia, la velocidad de venta (básica y ajustada), la cobertura, la venta
--         perdida estimada y el estado de salud de cada producto se calculan UNA sola vez, aquí, con la existencia al cierre
--         de cada día (existencia_diaria) y las salidas por venta del kardex. Los umbrales son parámetros, no código.
--   R-BP  Una promoción nace en borrador, se arma con su alcance (productos, códigos comunes, categorías, marcas y, si se
--         quiere, clientes), se envía a aprobación y la aprueba Gerencia, nunca quien la creó. Una promoción aprobada no se
--         edita: se anula con motivo o vence por fecha.
--   R-BQ  Cada línea de venta guarda la promoción que aplicó (promocion_id). El pedido solo acepta una promoción aprobada,
--         vigente, que alcance al producto y al cliente, con el descuento o el precio que la promoción define.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Parámetros de inventario (valores de referencia, a confirmar por Gerencia)
-- ---------------------------------------------------------------------
create table parametro_inventario (
  codigo      varchar(40) primary key check (codigo ~ '^[A-Z_]+$'),
  descripcion text not null,
  valor       numeric(14,4) not null check (valor >= 0),
  unidad      text not null check (unidad in ('dias', 'porcentaje', 'unidades_por_dia'))
);
insert into parametro_inventario (codigo, descripcion, valor, unidad) values
  ('VENTANA_VELOCIDAD_DIAS',     'Días que mide la velocidad de venta vigente (vista vw_disponibilidad)',                        90,  'dias'),
  ('COBERTURA_RIESGO_DIAS',      'Riesgo de quiebre: cobertura menor a estos días',                                               15,  'dias'),
  ('DISPONIBILIDAD_REPRIMIDA',   'Demanda reprimida: disponibilidad menor a este porcentaje de los días',                         60,  'porcentaje'),
  ('VELOCIDAD_REPRIMIDA',        'Demanda reprimida: velocidad ajustada mayor a estas unidades por día',                          0.1, 'unidades_por_dia'),
  ('COBERTURA_SOBRESTOCK_DIAS',  'Sobrestock: cobertura mayor a estos días (6 meses)',                                            180, 'dias');
create trigger parametro_inventario_audit after insert or update or delete on parametro_inventario for each row execute function fn_audit();

create function fn_parametro_inventario(p_codigo text) returns numeric
language plpgsql stable as $$
declare v numeric;
begin
  select valor into v from parametro_inventario where codigo = p_codigo;
  if v is null then
    raise exception 'Falta configurar el parámetro de inventario %', p_codigo;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Disponibilidad y velocidad de venta por producto en un periodo (R-BO)
--
--   dias_periodo         días del periodo desde el primer registro de existencia del producto (antes no hay dato)
--   dias_con_existencia  días en que la existencia de los almacenes que venden, al cierre del día, fue mayor que cero
--   dias_sin_existencia  dias_periodo − dias_con_existencia
--   unidades_vendidas    salidas por venta menos devoluciones de clientes del periodo (nunca negativo)
--   velocidad_basica     unidades_vendidas ÷ dias_periodo
--   velocidad_ajustada   unidades_vendidas ÷ dias_con_existencia (lo que se vende cuando hay existencia)
--   cobertura_dias       existencia comercial al cierre del periodo ÷ velocidad_ajustada
--   venta_perdida_*      dias_sin_existencia × velocidad_ajustada (en unidades y a precio de la lista A vigente al cierre)
--   estado_salud         RIESGO_QUIEBRE, DEMANDA_REPRIMIDA, SOBRESTOCK, SIN_ROTACION o SALUDABLE (en ese orden de prioridad)
--
-- La existencia diaria es escalonada: un día sin movimientos conserva el valor anterior. Por eso se calcula por tramos
-- entre un cambio y el siguiente, no día por día. Debe coincidir con fn_dias_con_existencia (se prueba).
-- ---------------------------------------------------------------------
create function fn_disponibilidad(p_desde date, p_hasta date)
returns table (
  producto_id uuid, dias_periodo int, dias_con_existencia int, dias_sin_existencia int, pct_disponibilidad numeric,
  unidades_vendidas numeric, velocidad_basica numeric, velocidad_ajustada numeric,
  stock_comercial numeric, cobertura_dias numeric,
  venta_perdida_unidades numeric, precio_lista_a_usd numeric, venta_perdida_usd numeric, estado_salud text)
language sql stable as $$
  with iv as (                                -- tramos de existencia constante por producto y almacén que vende
    select e.producto_id, e.fecha as ini,
           lead(e.fecha) over (partition by e.producto_id, e.almacen_id order by e.fecha) as fin,
           e.cantidad
      from existencia_diaria e
      join almacen a on a.id = e.almacen_id and a.permite_venta
     where e.fecha <= p_hasta and p_hasta >= p_desde
  ),
  primero as (select producto_id, min(ini) as primer from iv group by producto_id),
  cortes as (                                 -- fechas del periodo en que cambia la existencia de algún almacén
    select producto_id, p_desde as dia from primero
    union
    select producto_id, ini from iv where ini > p_desde
  ),
  tramos as (
    select c.producto_id, c.dia,
           coalesce(lead(c.dia) over (partition by c.producto_id order by c.dia), p_hasta + 1) as hasta_excl
      from cortes c
  ),
  dis as (
    select t.producto_id,
           coalesce(sum(t.hasta_excl - t.dia) filter (where s.total > 0), 0)::int as dias
      from tramos t
      cross join lateral (
        select coalesce(sum(i.cantidad), 0) as total from iv i
         where i.producto_id = t.producto_id and i.ini <= t.dia and (i.fin is null or i.fin > t.dia)) s
     group by t.producto_id
  ),
  ventas as (
    select m.producto_id, greatest(-sum(m.cantidad), 0) as unidades
      from movimiento_inventario m
     where m.tipo in ('salida_venta', 'devolucion_cliente')
       and (m.fecha at time zone 'America/Caracas')::date between p_desde and p_hasta
     group by m.producto_id
  ),
  stock as (
    select x.producto_id, sum(x.cantidad) as total
      from fn_existencia_al(p_hasta) x join almacen a on a.id = x.almacen_id and a.permite_venta
     group by x.producto_id
  ),
  par as (
    select fn_parametro_inventario('COBERTURA_RIESGO_DIAS') as riesgo, fn_parametro_inventario('DISPONIBILIDAD_REPRIMIDA') as disp,
           fn_parametro_inventario('VELOCIDAD_REPRIMIDA') as vel, fn_parametro_inventario('COBERTURA_SOBRESTOCK_DIAS') as sobre
  ),
  base as (
    select pr.producto_id,
           greatest(p_hasta - greatest(p_desde, pr.primer) + 1, 0) as dias_periodo,
           d.dias as dias_con,
           coalesce(v.unidades, 0) as unidades,
           coalesce(s.total, 0) as stock
      from primero pr
      join dis d on d.producto_id = pr.producto_id
      left join ventas v on v.producto_id = pr.producto_id
      left join stock s on s.producto_id = pr.producto_id
  ),
  calc as (
    select b.*,
           b.dias_periodo - b.dias_con as dias_sin,
           round(100.0 * b.dias_con / nullif(b.dias_periodo, 0), 2) as pct,
           round(b.unidades / nullif(b.dias_periodo, 0), 4) as vel_basica,
           round(b.unidades / nullif(b.dias_con, 0), 4) as vel_ajustada
      from base b
  )
  select c.producto_id, c.dias_periodo, c.dias_con, c.dias_sin, c.pct,
         c.unidades, c.vel_basica, c.vel_ajustada, c.stock,
         case when c.vel_ajustada > 0 then round(c.stock / c.vel_ajustada, 1) end as cobertura_dias,
         case when c.vel_ajustada is not null then round(c.dias_sin * c.vel_ajustada, 2) end as venta_perdida_unidades,
         fn_precio(c.producto_id, 'A', p_hasta) as precio_a,
         case when c.vel_ajustada is not null then round(c.dias_sin * c.vel_ajustada * coalesce(fn_precio(c.producto_id, 'A', p_hasta), 0), 2) end as venta_perdida_usd,
         case
           when c.stock <= 0 or (c.vel_ajustada > 0 and c.stock / c.vel_ajustada < par.riesgo) then 'RIESGO_QUIEBRE'
           when c.pct < par.disp and coalesce(c.vel_ajustada, 0) > par.vel then 'DEMANDA_REPRIMIDA'
           when c.vel_ajustada > 0 and c.stock / c.vel_ajustada > par.sobre then 'SOBRESTOCK'
           when c.unidades = 0 and c.stock > 0 then 'SIN_ROTACION'
           else 'SALUDABLE'
         end as estado_salud
    from calc c cross join par
$$;

-- Velocidad vigente: la ventana de días que fija el parámetro, terminada hoy (hora de Caracas).
create view vw_disponibilidad as
select d.*, p.codigo, p.descripcion, p.marca_id, p.producto_base_id
  from fn_disponibilidad(
         ((now() at time zone 'America/Caracas')::date) - (fn_parametro_inventario('VENTANA_VELOCIDAD_DIAS')::int - 1),
         ((now() at time zone 'America/Caracas')::date)) d
  join producto p on p.id = d.producto_id;

-- ---------------------------------------------------------------------
-- Promociones (R-BP)
-- ---------------------------------------------------------------------
insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('promocion', 'A', 'PRM', 1);
insert into motivo (tipo, codigo, nombre, sistema) values ('descuento', 'PROMOCION', 'Promoción aprobada', true);

create table promocion (
  id              uuid primary key default gen_random_uuid(),
  codigo          varchar(10) not null unique,
  nombre          text not null check (length(trim(nombre)) > 2),
  descripcion     text,
  tipo            text not null check (tipo in ('descuento_pct', 'precio_especial')),
  descuento_pct   numeric(5,2) check (descuento_pct > 0 and descuento_pct <= 100),
  cantidad_minima numeric(14,4) check (cantidad_minima > 0),            -- compra mínima por línea para que aplique
  vigente_desde   date not null,
  vigente_hasta   date not null,
  estado          text not null default 'borrador' check (estado in ('borrador', 'pendiente', 'aprobada', 'rechazada', 'anulada')),
  aprobado_por    uuid references usuario(id),
  aprobado_at     timestamptz,
  rechazo_motivo  text,
  anulado_por     uuid references usuario(id),
  anulado_at      timestamptz,
  anulado_motivo  text,
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  check (vigente_hasta >= vigente_desde),
  check ((tipo = 'descuento_pct') = (descuento_pct is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2),
  check (estado <> 'anulada' or length(trim(coalesce(anulado_motivo, ''))) > 2),
  check ((estado = 'aprobada') = (aprobado_por is not null) or estado = 'anulada')
);
create index promocion_estado_idx on promocion (estado, vigente_desde, vigente_hasta);

create table promocion_alcance (
  id                  uuid primary key default gen_random_uuid(),
  promocion_id        uuid not null references promocion(id),
  tipo                text not null check (tipo in ('producto', 'codigo_comun', 'categoria', 'marca', 'cliente')),
  entidad_id          uuid not null,
  precio_especial_usd numeric(14,2) check (precio_especial_usd > 0),   -- solo promociones de precio especial, por producto
  unique (promocion_id, tipo, entidad_id),
  check (precio_especial_usd is null or tipo = 'producto')
);

-- ¿La categoría del producto es la indicada o una de sus descendientes?
create function fn_categoria_incluye(p_categoria uuid, p_de_producto uuid) returns boolean
language sql stable as $$
  select p_categoria is not null and p_de_producto is not null and exists (
    with recursive ruta(id) as (
      select p_de_producto
      union
      select c.padre_id from categoria_producto c join ruta r on c.id = r.id where c.padre_id is not null)
    select 1 from ruta where id = p_categoria)
$$;

-- ¿La promoción alcanza a este producto y a este cliente? Sin filas de cliente, alcanza a todos.
create function fn_promocion_alcanza(p_promocion uuid, p_producto uuid, p_cliente uuid) returns boolean
language sql stable as $$
  select exists (
           select 1
             from promocion_alcance a
             join producto p on p.id = p_producto
             left join producto_base pb on pb.id = p.producto_base_id
            where a.promocion_id = p_promocion
              and ((a.tipo = 'producto' and a.entidad_id = p.id)
                or (a.tipo = 'codigo_comun' and a.entidad_id = p.producto_base_id)
                or (a.tipo = 'marca' and a.entidad_id = p.marca_id)
                or (a.tipo = 'categoria' and fn_categoria_incluye(a.entidad_id, pb.categoria_id))))
     and (not exists (select 1 from promocion_alcance where promocion_id = p_promocion and tipo = 'cliente')
          or exists (select 1 from promocion_alcance where promocion_id = p_promocion and tipo = 'cliente' and entidad_id = p_cliente))
$$;

-- La mejor promoción para una línea: aprobada, vigente en la fecha, con la compra mínima cumplida y que alcance al producto y al
-- cliente. Devuelve el precio y el descuento con que queda la línea; gana el menor precio neto. Sin promoción, ninguna fila.
create function fn_promocion_para_linea(p_producto uuid, p_cliente uuid, p_fecha date, p_cantidad numeric, p_precio_lista numeric)
returns table (promocion_id uuid, precio_unitario numeric, descuento_pct numeric, precio_neto numeric)
language sql stable as $$
  select x.id, x.precio, x.pct, x.neto
    from (
      select p.id,
             case when p.tipo = 'precio_especial' then e.precio_especial_usd else p_precio_lista end as precio,
             case when p.tipo = 'descuento_pct' then p.descuento_pct else 0 end as pct,
             case when p.tipo = 'precio_especial' then e.precio_especial_usd
                  else round(p_precio_lista * (100 - p.descuento_pct) / 100, 4) end as neto
        from promocion p
        left join promocion_alcance e on e.promocion_id = p.id and e.tipo = 'producto' and e.entidad_id = p_producto and p.tipo = 'precio_especial'
       where p.estado = 'aprobada' and p_fecha between p.vigente_desde and p.vigente_hasta
         and (p.cantidad_minima is null or p_cantidad >= p.cantidad_minima)
         and (p.tipo = 'descuento_pct' or e.precio_especial_usd is not null)
         and fn_promocion_alcanza(p.id, p_producto, p_cliente)) x
   where x.neto < p_precio_lista
   order by x.neto, x.id
   limit 1
$$;

create function fn_promocion_antes() returns trigger
language plpgsql as $$
declare
  v_hoy date := (now() at time zone 'America/Caracas')::date;
  v_prefijo text;
  v_aprobador uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una promoción no se borra: se anula';
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Una promoción nace en borrador';
    end if;
    if new.codigo is not null then
      raise exception 'El código de la promoción lo asigna el sistema';
    end if;
    select prefijo into v_prefijo from numerador where tipo_documento = 'promocion' and serie = 'A';
    new.codigo := v_prefijo || lpad(fn_siguiente_numero('promocion', 'A')::text, 4, '0');
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Una promoción necesita el usuario que la crea';
    end if;
    new.aprobado_por := null; new.aprobado_at := null;
    return new;
  end if;

  if new.codigo <> old.codigo or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'El código y el creador de una promoción no se cambian';
  end if;
  if old.estado in ('rechazada', 'anulada') then
    raise exception 'Una promoción % no se modifica', old.estado;
  end if;
  v_aprobador := new.aprobado_por;
  new.aprobado_por := old.aprobado_por; new.aprobado_at := old.aprobado_at;
  new.anulado_por := old.anulado_por; new.anulado_at := old.anulado_at;

  if (new.nombre, new.descripcion, new.tipo, new.descuento_pct, new.cantidad_minima, new.vigente_desde, new.vigente_hasta)
       is distinct from (old.nombre, old.descripcion, old.tipo, old.descuento_pct, old.cantidad_minima, old.vigente_desde, old.vigente_hasta)
     and old.estado <> 'borrador' then
    raise exception 'Una promoción enviada a aprobación no se edita: se anula y se crea otra';
  end if;

  if new.estado = old.estado then
    return new;
  end if;

  if (old.estado, new.estado) = ('borrador', 'pendiente') then
    if new.vigente_hasta < v_hoy then
      raise exception 'La promoción ya venció: ajuste sus fechas';
    end if;
    if not exists (select 1 from promocion_alcance where promocion_id = old.id and tipo <> 'cliente') then
      raise exception 'Indique a qué productos aplica la promoción';
    end if;
    if new.tipo = 'precio_especial' then
      if exists (select 1 from promocion_alcance where promocion_id = old.id and tipo not in ('producto', 'cliente')) then
        raise exception 'Una promoción de precio especial solo se arma con productos concretos y, si se quiere, clientes';
      end if;
      if exists (select 1 from promocion_alcance where promocion_id = old.id and tipo = 'producto' and precio_especial_usd is null) then
        raise exception 'Cada producto de una promoción de precio especial necesita su precio';
      end if;
    end if;
  elsif (old.estado, new.estado) = ('pendiente', 'aprobada') then
    if v_aprobador is null or not fn_tiene_rol(v_aprobador, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar una promoción';
    end if;
    if v_aprobador = old.created_by then
      raise exception 'Quien creó la promoción no puede aprobarla';
    end if;
    new.aprobado_por := v_aprobador;
    new.aprobado_at := now();
  elsif (old.estado, new.estado) = ('pendiente', 'rechazada') then
    null;                                                       -- el motivo lo exige la restricción de la tabla
  elsif new.estado = 'anulada' and old.estado in ('borrador', 'pendiente', 'aprobada') then
    new.anulado_por := coalesce(fn_usuario_actual(), new.anulado_por);
    new.anulado_at := now();
  else
    raise exception 'Una promoción % no pasa a %', old.estado, new.estado;
  end if;
  return new;
end $$;

create trigger promocion_antes
  before insert or update or delete on promocion
  for each row execute function fn_promocion_antes();

create function fn_promocion_alcance_antes() returns trigger
language plpgsql as $$
declare
  v_estado text;
  v_tipo   text;
  v_ok     boolean;
begin
  select estado, tipo into v_estado, v_tipo from promocion where id = coalesce(new.promocion_id, old.promocion_id);
  -- Si la promoción ya no existe, no hay nada que proteger (nunca se borra, así que no ocurre).
  if v_estado is distinct from 'borrador' then
    raise exception 'El alcance solo se cambia mientras la promoción está en borrador';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  v_ok := case new.tipo
    when 'producto'     then exists (select 1 from producto where id = new.entidad_id)
    when 'codigo_comun' then exists (select 1 from producto_base where id = new.entidad_id)
    when 'categoria'    then exists (select 1 from categoria_producto where id = new.entidad_id)
    when 'marca'        then exists (select 1 from marca where id = new.entidad_id)
    when 'cliente'      then exists (select 1 from cliente where tercero_id = new.entidad_id)
  end;
  if not v_ok then
    raise exception 'El alcance apunta a un % que no existe', new.tipo;
  end if;
  if v_tipo = 'descuento_pct' and new.precio_especial_usd is not null then
    raise exception 'Una promoción de descuento no lleva precio especial';
  end if;
  if v_tipo = 'precio_especial' and new.tipo not in ('producto', 'cliente') then
    raise exception 'Una promoción de precio especial solo se arma con productos concretos y, si se quiere, clientes';
  end if;
  if v_tipo = 'precio_especial' and new.tipo = 'producto' and new.precio_especial_usd is null then
    raise exception 'Indique el precio especial del producto';
  end if;
  return new;
end $$;

create trigger promocion_alcance_antes
  before insert or update or delete on promocion_alcance
  for each row execute function fn_promocion_alcance_antes();

-- ---------------------------------------------------------------------
-- Aprobación por el motor de flujo (§4.5): Gerencia, distinta de quien la creó
-- ---------------------------------------------------------------------
insert into flujo_definicion (objeto_tipo, nombre) values ('promocion', 'Promoción');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'promocion';

-- ---------------------------------------------------------------------
-- Cada línea de venta guarda la promoción que aplicó (R-BQ)
-- ---------------------------------------------------------------------
alter table documento_venta_linea add column promocion_id uuid references promocion(id);
create index documento_venta_linea_promocion_idx on documento_venta_linea (promocion_id) where promocion_id is not null;

-- En el pedido en borrador la promoción debe ser real y vigente. En la nota y en la factura solo se copia lo que el pedido fijó.
create function fn_linea_promocion_valida() returns trigger
language plpgsql as $$
declare
  v_doc   record;
  v_promo promocion%rowtype;
  v_hoy   date := (now() at time zone 'America/Caracas')::date;
  v_esp   numeric;
begin
  if new.promocion_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.promocion_id is not distinct from old.promocion_id
     and (new.producto_id, new.cantidad, new.precio_unitario, new.descuento_pct) is not distinct from
         (old.producto_id, old.cantidad, old.precio_unitario, old.descuento_pct) then
    return new;
  end if;
  select tipo, cliente_id into v_doc from documento_venta where id = new.documento_id;
  if v_doc.tipo is distinct from 'pedido' then
    return new;
  end if;
  select * into v_promo from promocion where id = new.promocion_id;
  if v_promo.estado <> 'aprobada' then
    raise exception 'La promoción % no está aprobada', v_promo.codigo;
  end if;
  if v_hoy not between v_promo.vigente_desde and v_promo.vigente_hasta then
    raise exception 'La promoción % no está vigente', v_promo.codigo;
  end if;
  if v_promo.cantidad_minima is not null and new.cantidad < v_promo.cantidad_minima then
    raise exception 'La promoción % exige comprar al menos %', v_promo.codigo, v_promo.cantidad_minima;
  end if;
  if not fn_promocion_alcanza(v_promo.id, new.producto_id, v_doc.cliente_id) then
    raise exception 'La promoción % no aplica a este producto o a este cliente', v_promo.codigo;
  end if;
  if v_promo.tipo = 'descuento_pct' then
    if new.descuento_pct <> v_promo.descuento_pct or new.precio_unitario <> new.precio_lista then
      raise exception 'La línea no coincide con el descuento de la promoción %', v_promo.codigo;
    end if;
  else
    select precio_especial_usd into v_esp from promocion_alcance where promocion_id = v_promo.id and tipo = 'producto' and entidad_id = new.producto_id;
    if new.precio_unitario is distinct from v_esp or new.descuento_pct <> 0 then
      raise exception 'La línea no coincide con el precio especial de la promoción %', v_promo.codigo;
    end if;
  end if;
  return new;
end $$;

create trigger documento_venta_linea_promocion
  before insert or update on documento_venta_linea
  for each row execute function fn_linea_promocion_valida();

-- Lo que cada promoción ha movido: notas de entrega vigentes (USD), con venta a precio de lista, lo cobrado y el descuento otorgado.
create view vw_promocion_aplicada as
select p.id as promocion_id, p.codigo, p.nombre, p.estado, p.vigente_desde, p.vigente_hasta,
       count(x.linea_id)::int as lineas,
       count(distinct x.nota_id)::int as notas,
       coalesce(sum(x.cantidad), 0)::numeric(16,4) as unidades,
       coalesce(sum(x.venta_lista), 0)::numeric(16,2) as venta_lista_usd,
       coalesce(sum(x.base), 0)::numeric(16,2) as venta_cobrada_usd,
       (coalesce(sum(x.venta_lista), 0) - coalesce(sum(x.base), 0))::numeric(16,2) as descuento_usd
  from promocion p
  left join (
    select l.promocion_id, l.id as linea_id, n.id as nota_id, l.cantidad,
           round(l.cantidad * l.precio_lista, 2) as venta_lista, l.base
      from documento_venta_linea l
      join documento_venta n on n.id = l.documento_id and n.tipo = 'nota_entrega' and n.estado = 'emitido'
     where l.promocion_id is not null) x on x.promocion_id = p.id
 group by p.id;

create trigger promocion_audit          after insert or update or delete on promocion          for each row execute function fn_audit();
create trigger promocion_alcance_audit  after insert or update or delete on promocion_alcance  for each row execute function fn_audit();
