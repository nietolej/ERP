-- =====================================================================
-- 0009 · Proveedores, conceptos de ISLR y cambios con aprobación (§4.3, §5.1)
--
--   R-L  El código del proveedor (P00001…) lo asigna el numerador y no cambia.
--   R-M  Un proveedor nace 'pendiente' (lo registra Compras) y pasa a 'activo' solo con
--        la aprobación de un usuario activo con el rol Gerencia, distinto de quien lo
--        registró, que le asigna la condición de pago.
--   R-N  Los datos sensibles de un proveedor aprobado (razón social y datos fiscales del
--        tercero, tipo, país y concepto de ISLR) solo cambian aplicando una solicitud de
--        cambio aprobada por Gerencia (proveedor_cambio), aprobada por alguien distinto
--        de quien la solicitó. La condición de pago solo la cambia Gerencia.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Conceptos de ISLR (Decreto 1.808). Aquí solo el catálogo: los porcentajes, mínimos y
-- sustraendos (en UT y con vigencia) se agregan con la retención de ISLR (Fases 3 y 4).
-- Los carga Contabilidad; no se precargan para no escribir normativa en el código.
-- ---------------------------------------------------------------------
create table concepto_islr (
  id          uuid primary key default gen_random_uuid(),
  codigo      varchar(10) not null unique check (codigo ~ '^[A-Z0-9.\-]+$'),
  descripcion text not null check (length(trim(descripcion)) > 2),
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Proveedores
-- ---------------------------------------------------------------------
create table proveedor (
  tercero_id        uuid primary key references tercero(id),
  codigo            varchar(10) not null unique,
  tipo              text not null check (tipo in ('mercancia_local', 'importacion', 'servicios', 'gastos')),
  pais              char(2) not null default 'VE' check (pais ~ '^[A-Z]{2}$'),
  condicion_pago_id uuid references condicion_pago(id),
  concepto_islr_id  uuid references concepto_islr(id),
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente', 'activo', 'inactivo', 'bloqueado')),
  aprobado_por      uuid references usuario(id),
  aprobado_at       timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references usuario(id),
  check (estado = 'pendiente' or (aprobado_por is not null and aprobado_at is not null and condicion_pago_id is not null))
);

insert into numerador (tipo_documento, serie, prefijo, siguiente) values ('proveedor', 'A', 'P', 1);

-- Solicitudes de cambio de datos sensibles. `datos` guarda solo los campos que cambian.
create table proveedor_cambio (
  id              uuid primary key default gen_random_uuid(),
  proveedor_id    uuid not null references proveedor(tercero_id),
  datos           jsonb not null check (jsonb_typeof(datos) = 'object' and datos <> '{}'::jsonb),
  estado          text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  solicitado_por  uuid not null references usuario(id),
  solicitado_at   timestamptz not null default now(),
  resuelto_por    uuid references usuario(id),
  resuelto_at     timestamptz,
  motivo_rechazo  text,
  check ((estado = 'pendiente') = (resuelto_por is null)),
  check (estado <> 'rechazado' or length(trim(coalesce(motivo_rechazo, ''))) > 0),
  check (resuelto_por is null or resuelto_por <> solicitado_por)
);
-- Una sola solicitud abierta por proveedor.
create unique index proveedor_cambio_abierto on proveedor_cambio (proveedor_id) where estado = 'pendiente';

-- Marca de transacción que usa fn_aplicar_cambio_proveedor para aplicar un cambio aprobado.
create function fn_aplicando_cambio_aprobado() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.cambio_proveedor_aprobado', true), '') = 'si'
$$;

create function fn_proveedor_antes() returns trigger
language plpgsql as $$
declare v_prefijo text;
begin
  if tg_op = 'INSERT' then
    if new.codigo is not null then
      raise exception 'El código del proveedor lo asigna el sistema';
    end if;
    select prefijo into v_prefijo from numerador where tipo_documento = 'proveedor' and serie = 'A';
    new.codigo := v_prefijo || lpad(fn_siguiente_numero('proveedor', 'A')::text, 5, '0');
    if new.estado <> 'pendiente' or new.aprobado_por is not null then
      raise exception 'Un proveedor nuevo queda pendiente hasta que Gerencia lo apruebe';
    end if;
    new.created_by := coalesce(new.created_by, fn_usuario_actual());
    return new;
  end if;

  if new.codigo <> old.codigo then
    raise exception 'El código de un proveedor no se cambia';
  end if;
  if new.estado = 'pendiente' and old.estado <> 'pendiente' then
    raise exception 'Un proveedor aprobado no vuelve a pendiente';
  end if;
  if old.aprobado_por is not null and new.aprobado_por is distinct from old.aprobado_por then
    raise exception 'La aprobación de un proveedor no se modifica';
  end if;

  if old.estado = 'pendiente' and new.estado <> 'pendiente' then
    -- R-M: aprobación del alta.
    if new.aprobado_por is null or not fn_tiene_rol(new.aprobado_por, 'gerencia') then
      raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar un proveedor';
    end if;
    if new.aprobado_por = new.created_by then
      raise exception 'Quien registró el proveedor no puede aprobarlo';
    end if;
    new.aprobado_at := now();
    return new;
  end if;

  if old.estado <> 'pendiente' then
    -- R-N: datos sensibles solo con un cambio aprobado.
    if (new.tipo, new.pais, new.concepto_islr_id) is distinct from (old.tipo, old.pais, old.concepto_islr_id)
       and not fn_aplicando_cambio_aprobado() then
      raise exception 'El tipo, el país y el concepto de ISLR de un proveedor aprobado cambian con una solicitud aprobada por Gerencia';
    end if;
    if new.condicion_pago_id is distinct from old.condicion_pago_id
       and not fn_tiene_rol(fn_usuario_actual(), 'gerencia') then
      raise exception 'Solo Gerencia cambia la condición de pago de un proveedor';
    end if;
  end if;
  return new;
end $$;

create trigger proveedor_antes
  before insert or update on proveedor
  for each row execute function fn_proveedor_antes();

-- R-N en el tercero: si es proveedor aprobado, su razón social y sus datos fiscales
-- no cambian por fuera de una solicitud aprobada (tampoco desde la pantalla de clientes).
create function fn_tercero_sensible() returns trigger
language plpgsql as $$
begin
  if (new.razon_social, new.domiciliado, new.contribuyente_especial, new.agente_retencion_iva, new.tipo_persona)
       is distinct from
     (old.razon_social, old.domiciliado, old.contribuyente_especial, old.agente_retencion_iva, old.tipo_persona)
     and exists (select 1 from proveedor p where p.tercero_id = new.id and p.estado <> 'pendiente')
     and not fn_aplicando_cambio_aprobado() then
    raise exception 'Este tercero es proveedor: su razón social y sus datos fiscales cambian con una solicitud aprobada por Gerencia (Maestros → Proveedores)';
  end if;
  if new.rif <> old.rif then
    raise exception 'El RIF de un tercero no se cambia';
  end if;
  return new;
end $$;

create trigger tercero_sensible
  before update on tercero
  for each row execute function fn_tercero_sensible();

-- Aprueba y aplica una solicitud de cambio. Gerencia, distinta de quien la solicitó.
create function fn_aprobar_cambio_proveedor(p_cambio uuid, p_aprobador uuid) returns void
language plpgsql as $$
declare
  c proveedor_cambio;
  d jsonb;
begin
  select * into c from proveedor_cambio where id = p_cambio for update;
  if c.id is null then
    raise exception 'La solicitud de cambio no existe';
  end if;
  if c.estado <> 'pendiente' then
    raise exception 'La solicitud de cambio ya fue resuelta';
  end if;
  if not fn_tiene_rol(p_aprobador, 'gerencia') then
    raise exception 'Solo un usuario activo con el rol Gerencia puede aprobar cambios de proveedores';
  end if;
  if p_aprobador = c.solicitado_por then
    raise exception 'Quien solicitó el cambio no puede aprobarlo';
  end if;

  d := c.datos;
  perform set_config('app.cambio_proveedor_aprobado', 'si', true);
  update tercero set
    razon_social           = coalesce(d ->> 'razon_social', razon_social),
    domiciliado            = coalesce((d ->> 'domiciliado')::boolean, domiciliado),
    contribuyente_especial = coalesce((d ->> 'contribuyente_especial')::boolean, contribuyente_especial),
    agente_retencion_iva   = coalesce((d ->> 'agente_retencion_iva')::boolean, agente_retencion_iva)
   where id = c.proveedor_id;
  update proveedor set
    tipo             = coalesce(d ->> 'tipo', tipo),
    pais             = coalesce(d ->> 'pais', pais),
    concepto_islr_id = case when d ? 'concepto_islr_id' then nullif(d ->> 'concepto_islr_id', '')::uuid else concepto_islr_id end
   where tercero_id = c.proveedor_id;
  perform set_config('app.cambio_proveedor_aprobado', '', true);

  update proveedor_cambio set estado = 'aprobado', resuelto_por = p_aprobador, resuelto_at = now() where id = p_cambio;
end $$;

create trigger concepto_islr_audit    after insert or update or delete on concepto_islr    for each row execute function fn_audit();
create trigger proveedor_audit        after insert or update or delete on proveedor        for each row execute function fn_audit();
create trigger proveedor_cambio_audit after insert or update or delete on proveedor_cambio for each row execute function fn_audit();
