-- =====================================================================
-- 0014 · Adjuntos: archivos de soporte enlazados a un registro (§4.2)
--
--   R-X  Un adjunto guarda su huella SHA-256, tamaño, tipo, usuario y fecha. Los bytes
--        viven en el almacenamiento de archivos (fuera de la base y de la carpeta pública).
--   R-Y  Un adjunto no se edita ni se borra: se anula con motivo, usuario y fecha. Solo
--        lo anula quien lo subió o un usuario con rol Gerencia. Se conserva el archivo
--        (los soportes se guardan 10 años, §15).
--   R-Z  No se repite el mismo archivo (misma huella) en un mismo registro vigente.
--
-- Enlaza a cliente, proveedor y producto. Cuando lleguen los documentos (facturas, pagos,
-- gastos) se agregan sus tipos con una migración nueva.
-- =====================================================================

create table adjunto (
  id                uuid primary key default gen_random_uuid(),
  entidad_tipo      text not null check (entidad_tipo in ('cliente', 'proveedor', 'producto')),
  entidad_id        uuid not null,
  nombre            text not null check (length(trim(nombre)) between 1 and 150),
  tipo_contenido    text not null check (tipo_contenido in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  tamano_bytes      integer not null check (tamano_bytes > 0),
  hash_sha256       char(64) not null check (hash_sha256 ~ '^[0-9a-f]{64}$'),
  descripcion       text check (descripcion is null or length(descripcion) <= 300),
  subido_por        uuid not null references usuario(id),
  created_at        timestamptz not null default now(),
  anulado_por       uuid references usuario(id),
  anulado_at        timestamptz,
  motivo_anulacion  text,
  check ((anulado_por is null) = (anulado_at is null) and (anulado_por is null) = (motivo_anulacion is null)),
  check (motivo_anulacion is null or length(trim(motivo_anulacion)) > 2)
);

create index adjunto_entidad_idx on adjunto (entidad_tipo, entidad_id);
create unique index adjunto_no_repetido on adjunto (entidad_tipo, entidad_id, hash_sha256) where anulado_at is null;

create function fn_adjunto_reglas() returns trigger
language plpgsql as $$
declare v_existe boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'Un adjunto no se borra: se anula';
  end if;

  if tg_op = 'INSERT' then
    v_existe := case new.entidad_tipo
      when 'cliente'   then exists (select 1 from cliente where tercero_id = new.entidad_id)
      when 'proveedor' then exists (select 1 from proveedor where tercero_id = new.entidad_id)
      when 'producto'  then exists (select 1 from producto where id = new.entidad_id)
    end;
    if not v_existe then
      raise exception 'El adjunto apunta a un % que no existe', new.entidad_tipo;
    end if;
    if new.anulado_at is not null then
      raise exception 'Un adjunto nace vigente';
    end if;
    return new;
  end if;

  -- UPDATE: solo la anulación, una vez.
  if old.anulado_at is not null then
    raise exception 'Un adjunto anulado no se modifica';
  end if;
  if new.entidad_tipo <> old.entidad_tipo or new.entidad_id <> old.entidad_id or new.nombre <> old.nombre
     or new.tipo_contenido <> old.tipo_contenido or new.tamano_bytes <> old.tamano_bytes
     or new.hash_sha256 <> old.hash_sha256 or new.descripcion is distinct from old.descripcion
     or new.subido_por <> old.subido_por or new.created_at <> old.created_at then
    raise exception 'Un adjunto no se edita: anúlelo y suba otro';
  end if;
  if new.anulado_por is null then
    raise exception 'Un adjunto solo cambia al anularse';
  end if;
  if new.anulado_por <> old.subido_por and not fn_tiene_rol(new.anulado_por, 'gerencia') then
    raise exception 'Solo quien subió el adjunto o Gerencia lo pueden anular';
  end if;
  new.anulado_at := now();
  return new;
end $$;

create trigger adjunto_reglas
  before insert or update or delete on adjunto
  for each row execute function fn_adjunto_reglas();

create trigger adjunto_audit after insert or update or delete on adjunto
  for each row execute function fn_audit();
