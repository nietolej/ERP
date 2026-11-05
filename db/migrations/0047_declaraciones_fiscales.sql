-- =====================================================================
-- 0047 · Declaraciones fiscales y cierre fiscal (spec §11.4)
--
--   R-DD  Tres declaraciones: IVA (mensual), retenciones de IVA (mensual o por quincena si la empresa es contribuyente especial) y
--         retenciones de ISLR (mensual). Cada una guarda la foto de sus cifras y, en las de retenciones, el archivo tal como se declaró.
--   R-DE  Solo se declara un periodo ya terminado. Hay una declaración vigente por tipo y periodo; la reabre Gerencia con motivo y queda
--         auditado (la declaración original se conserva).
--   R-DF  Cierre fiscal: con el IVA de un mes declarado, la base rechaza anular facturas, notas de crédito o de débito de ventas de ese mes
--         y registrar (contabilizar o aprobar) facturas de compra, gastos o notas del proveedor fechados en él. Con las retenciones declaradas,
--         rechaza practicar retenciones de ese impuesto con fecha dentro del periodo. Las correcciones van con documentos nuevos en el periodo
--         abierto (NC o ND).
-- =====================================================================

create table declaracion_fiscal (
  id                  uuid primary key default gen_random_uuid(),
  tipo                text not null check (tipo in ('iva', 'retenciones_iva', 'retenciones_islr')),
  anio                smallint not null check (anio between 2000 and 2100),
  mes                 smallint not null check (mes between 1 and 12),
  quincena            smallint check (quincena in (1, 2)),
  desde               date not null,
  hasta               date not null,
  cifras              jsonb not null,
  excedente_siguiente numeric(16,2) check (excedente_siguiente >= 0),          -- solo IVA: crédito fiscal que se traslada al mes siguiente
  archivo             text,
  archivo_nombre      text,
  declarada_por       uuid not null references usuario(id),
  declarada_at        timestamptz not null default now(),
  reabierta_por       uuid references usuario(id),
  reabierta_at        timestamptz,
  reabierta_motivo    text,
  check (tipo = 'retenciones_iva' or quincena is null),
  check (hasta >= desde),
  check ((reabierta_at is null) = (reabierta_por is null) and (reabierta_at is null) = (reabierta_motivo is null)),
  check (reabierta_motivo is null or length(trim(reabierta_motivo)) > 2)
);
create unique index declaracion_fiscal_vigente on declaracion_fiscal (tipo, anio, mes, coalesce(quincena, 0)) where reabierta_at is null;
create index declaracion_fiscal_rango_idx on declaracion_fiscal (tipo, desde, hasta) where reabierta_at is null;

create function fn_declaracion_fiscal_antes() returns trigger
language plpgsql as $$
declare
  v_hoy date := (now() at time zone 'America/Caracas')::date;
  v_ini date;
  v_fin date;
begin
  if tg_op = 'DELETE' then
    raise exception 'Una declaración fiscal no se borra: se reabre con motivo';
  end if;

  if tg_op = 'INSERT' then
    new.declarada_por := coalesce(new.declarada_por, fn_usuario_actual());
    if new.declarada_por is null
       or not (fn_tiene_rol(new.declarada_por, 'contabilidad') or fn_tiene_rol(new.declarada_por, 'jefe_contabilidad') or fn_tiene_rol(new.declarada_por, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia declaran';
    end if;
    v_ini := make_date(new.anio, new.mes, 1);
    v_fin := (v_ini + interval '1 month' - interval '1 day')::date;
    if new.quincena = 1 then v_fin := make_date(new.anio, new.mes, 15); end if;
    if new.quincena = 2 then v_ini := make_date(new.anio, new.mes, 16); end if;
    if new.desde <> v_ini or new.hasta <> v_fin then
      raise exception 'Las fechas de la declaración no son las del periodo';
    end if;
    if new.hasta >= v_hoy then
      raise exception 'Solo se declara un periodo ya terminado';
    end if;
    new.reabierta_por := null; new.reabierta_at := null; new.reabierta_motivo := null;
    return new;
  end if;

  -- UPDATE: solo la reapertura, una vez, por Gerencia.
  if (to_jsonb(new) - 'reabierta_por' - 'reabierta_at' - 'reabierta_motivo') is distinct from (to_jsonb(old) - 'reabierta_por' - 'reabierta_at' - 'reabierta_motivo') then
    raise exception 'Una declaración fiscal no se modifica: se reabre y se declara de nuevo';
  end if;
  if old.reabierta_at is not null then
    raise exception 'Esta declaración ya fue reabierta';
  end if;
  new.reabierta_por := coalesce(new.reabierta_por, fn_usuario_actual());
  if new.reabierta_por is null or not fn_tiene_rol(new.reabierta_por, 'gerencia') then
    raise exception 'Solo Gerencia reabre un periodo declarado';
  end if;
  new.reabierta_at := now();
  return new;
end $$;
create trigger declaracion_fiscal_antes before insert or update or delete on declaracion_fiscal
  for each row execute function fn_declaracion_fiscal_antes();
create trigger declaracion_fiscal_audit after insert or update on declaracion_fiscal for each row execute function fn_audit();

-- ¿Está cerrado fiscalmente ese día para ese tipo de declaración? (hay una declaración vigente que lo cubre)
create function fn_fiscal_cerrado(p_fecha date, p_tipo text) returns boolean
language sql stable as $$
  select exists (select 1 from declaracion_fiscal where tipo = p_tipo and reabierta_at is null and p_fecha between desde and hasta)
$$;

create function fn_bloqueo_fiscal(p_fecha date, p_tipo text, p_que text) returns void
language plpgsql as $$
begin
  if p_fecha is not null and fn_fiscal_cerrado(p_fecha, p_tipo) then
    raise exception 'El periodo fiscal % está declarado: no se puede % con fecha %. Corrija con una nota en el periodo abierto o pida a Gerencia que reabra el periodo',
      to_char(p_fecha, 'MM-YYYY'), p_que, to_char(p_fecha, 'DD-MM-YYYY');
  end if;
end $$;

-- Ventas: no se anula un documento fiscal de un mes con el IVA declarado.
create function fn_venta_bloqueo_fiscal() returns trigger
language plpgsql as $$
begin
  if new.estado = 'anulado' and old.estado <> 'anulado' and new.tipo in ('factura', 'nota_credito', 'nota_debito') then
    perform fn_bloqueo_fiscal((old.fecha_emision at time zone 'America/Caracas')::date, 'iva', 'anular un documento de venta');
  end if;
  return new;
end $$;
create trigger documento_venta_bloqueo_fiscal before update on documento_venta for each row execute function fn_venta_bloqueo_fiscal();

-- Compras: no se registra un documento fechado en un mes con el IVA declarado.
create function fn_compra_bloqueo_fiscal() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'factura_compra' and new.estado = 'contabilizada' and old.estado <> 'contabilizada' then
    perform fn_bloqueo_fiscal(new.fecha_factura, 'iva', 'registrar una factura de compra');
  elsif tg_table_name = 'gasto_importacion' and new.estado = 'contabilizado' and old.estado <> 'contabilizado' then
    perform fn_bloqueo_fiscal(new.fecha_factura, 'iva', 'registrar un gasto de importación');
  elsif tg_table_name = 'gasto_proveedor' and new.estado = 'contabilizado' and old.estado <> 'contabilizado' then
    perform fn_bloqueo_fiscal(new.fecha_factura, 'iva', 'registrar una factura de gasto');
  elsif tg_table_name = 'nota_proveedor' and new.estado = 'aprobada' and old.estado <> 'aprobada' then
    perform fn_bloqueo_fiscal(new.fecha, 'iva', 'aprobar una nota del proveedor');
  end if;
  return new;
end $$;
create trigger factura_compra_bloqueo_fiscal   before update on factura_compra   for each row execute function fn_compra_bloqueo_fiscal();
create trigger gasto_importacion_bloqueo_fiscal before update on gasto_importacion for each row execute function fn_compra_bloqueo_fiscal();
create trigger gasto_proveedor_bloqueo_fiscal  before update on gasto_proveedor  for each row execute function fn_compra_bloqueo_fiscal();
create trigger nota_proveedor_bloqueo_fiscal   before update on nota_proveedor   for each row execute function fn_compra_bloqueo_fiscal();

-- Retenciones: no se practican con fecha dentro de un periodo cuyas retenciones de ese impuesto ya se declararon.
create function fn_retencion_bloqueo_fiscal() returns trigger
language plpgsql as $$
begin
  perform fn_bloqueo_fiscal(new.fecha, 'retenciones_' || new.impuesto, 'practicar una retención de ' || upper(new.impuesto));
  return new;
end $$;
create trigger retencion_compra_bloqueo_fiscal before insert on retencion_compra for each row execute function fn_retencion_bloqueo_fiscal();
