-- =====================================================================
-- 0020 · Ajuste de inventario con aprobación (§4.3, §8.3, §12.3)
--
--   R-AT  Un ajuste de inventario (conteo contra el sistema) lo crea Almacén y lo aprueba Gerencia por el motor
--         de flujo. Nunca lo aprueba quien lo creó ni quien hizo el conteo; la base de datos lo exige.
--   R-AU  Cada línea guarda lo que decía el sistema cuando se contó y lo contado. Al aprobar se aplica la
--         DIFERENCIA, de modo que los movimientos ocurridos entre el conteo y la aprobación no se pierden.
--   R-AV  Un ajuste con diferencia exige el motivo de cada línea (catálogo de mermas). El faltante sale al costo
--         promedio vigente; un sobrante entra al costo promedio, o al costo indicado si el producto no tiene.
--   R-AW  Un ajuste enviado no se edita ni se borra: se aprueba o se rechaza con motivo. Su número es correlativo y
--         se asigna al enviarlo, así que un borrador eliminado no deja huecos.
--   R-AX  El asiento (faltantes y sobrantes contra inventario) sale del motor contable al aprobar.
-- =====================================================================

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('ajuste_inventario', 'A', '', 1);

create table ajuste_inventario (
  id              uuid primary key default gen_random_uuid(),
  numero          bigint unique,
  estado          text not null default 'borrador' check (estado in ('borrador', 'pendiente', 'aprobado', 'rechazado')),
  almacen_id      uuid not null references almacen(id),
  observaciones   text,
  contado_por     uuid not null references usuario(id),
  created_by      uuid not null references usuario(id),
  created_at      timestamptz not null default now(),
  enviado_at      timestamptz,
  aprobado_por    uuid references usuario(id),
  aprobado_at     timestamptz,
  rechazo_motivo  text,
  check ((estado = 'borrador') = (numero is null)),
  check ((estado = 'aprobado') = (aprobado_por is not null and aprobado_at is not null)),
  check (estado <> 'rechazado' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create index ajuste_inventario_almacen_idx on ajuste_inventario (almacen_id, estado);

create table ajuste_inventario_linea (
  id                 uuid primary key default gen_random_uuid(),
  ajuste_id          uuid not null references ajuste_inventario(id) on delete cascade,
  linea              int not null check (linea > 0),
  producto_id        uuid not null references producto(id),
  cantidad_sistema   numeric(14,4) not null,
  cantidad_contada   numeric(14,4) not null check (cantidad_contada >= 0),
  diferencia         numeric(14,4) generated always as (cantidad_contada - cantidad_sistema) stored,
  costo_unitario_usd numeric(16,4) check (costo_unitario_usd is null or costo_unitario_usd >= 0),   -- solo sobrantes sin costo previo
  motivo_id          uuid references motivo(id),
  unique (ajuste_id, linea),
  unique (ajuste_id, producto_id)
);

create function fn_ajuste_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'borrador' then
      raise exception 'Un ajuste de inventario nace en borrador';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    if new.created_by is null then
      raise exception 'Un ajuste de inventario necesita el usuario que lo crea';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.estado <> 'borrador' then
      raise exception 'Un ajuste de inventario enviado no se borra: se aprueba o se rechaza';
    end if;
    return old;
  end if;

  if old.estado = 'borrador' then
    if new.estado = 'pendiente' then
      if not exists (select 1 from ajuste_inventario_linea where ajuste_id = old.id and diferencia <> 0) then
        raise exception 'El ajuste no tiene diferencias que aplicar';
      end if;
      if exists (select 1 from ajuste_inventario_linea where ajuste_id = old.id and diferencia <> 0 and motivo_id is null) then
        raise exception 'Cada línea con diferencia necesita su motivo';
      end if;
      new.numero := fn_siguiente_numero('ajuste_inventario', 'A');
      new.enviado_at := now();
    elsif new.estado <> 'borrador' then
      raise exception 'Un borrador solo pasa a pendiente';
    end if;
    return new;
  end if;

  -- Enviado: solo cambian el estado y los datos de la decisión.
  if (to_jsonb(new) - array['estado', 'aprobado_por', 'aprobado_at', 'rechazo_motivo'])
     is distinct from (to_jsonb(old) - array['estado', 'aprobado_por', 'aprobado_at', 'rechazo_motivo']) then
    raise exception 'Un ajuste de inventario enviado no se edita';
  end if;
  if old.estado <> 'pendiente' then
    raise exception 'Un ajuste de inventario % no se modifica', old.estado;
  end if;
  if new.estado = 'aprobado' then
    -- R-AT: aprueba un usuario activo con el rol Gerencia que ni creó el ajuste ni hizo el conteo.
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar un ajuste de inventario';
    end if;
    if new.aprobado_por = old.created_by or new.aprobado_por = old.contado_por then
      raise exception 'Quien creó el ajuste o hizo el conteo no lo aprueba';
    end if;
    new.aprobado_at := now();
  elsif new.estado <> 'rechazado' then
    raise exception 'Un ajuste pendiente solo se aprueba o se rechaza';
  end if;
  return new;
end $$;

create trigger ajuste_antes
  before insert or update or delete on ajuste_inventario
  for each row execute function fn_ajuste_antes();

create function fn_ajuste_linea_antes() returns trigger
language plpgsql as $$
declare
  v_estado text;
begin
  select estado into v_estado from ajuste_inventario where id = coalesce(new.ajuste_id, old.ajuste_id);
  -- Si el encabezado ya no existe, es el borrado en cascada de un borrador.
  if v_estado is not null and v_estado <> 'borrador' then
    raise exception 'Las líneas de un ajuste de inventario enviado no se modifican';
  end if;
  if tg_op <> 'DELETE' and new.motivo_id is not null then
    perform fn_motivo_valido(new.motivo_id, 'merma');
  end if;
  return coalesce(new, old);
end $$;

create trigger ajuste_linea_antes
  before insert or update or delete on ajuste_inventario_linea
  for each row execute function fn_ajuste_linea_antes();

-- Flujo de aprobación: Gerencia, distinta de quien lo creó (la base además excluye a quien hizo el conteo).
insert into flujo_definicion (objeto_tipo, nombre) values ('ajuste_inventario', 'Ajuste de inventario');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'gerencia' from flujo_definicion where objeto_tipo = 'ajuste_inventario';

-- Reglas contables (§12.3): faltantes y sobrantes contra el inventario, en USD a valor de costo.
insert into regla_contable (evento, orden, lado, cuenta_id, importe, glosa)
select v.evento, v.orden, v.lado, c.id, 'costo', v.glosa
  from (values
    ('ajuste_faltante', 1, 'D', '5.1.02', 'Faltante de inventario'),
    ('ajuste_faltante', 2, 'H', '1.3.01', 'Salida de inventario por ajuste'),
    ('ajuste_sobrante', 1, 'D', '1.3.01', 'Entrada de inventario por ajuste'),
    ('ajuste_sobrante', 2, 'H', '5.1.02', 'Sobrante de inventario')) as v(evento, orden, lado, codigo, glosa)
  join cuenta_contable c on c.codigo = v.codigo;

create trigger ajuste_inventario_audit       after insert or update or delete on ajuste_inventario       for each row execute function fn_audit();
create trigger ajuste_inventario_linea_audit after insert or update or delete on ajuste_inventario_linea for each row execute function fn_audit();
