-- =====================================================================
-- 0054 · Revaluación mensual de partidas monetarias en divisas (decisión 1; spec §12.3 y §12.4)
--
--   R-DY  Al cierre de cada mes, Contabilidad propone la revaluación: las partidas monetarias en dólares (bancos y cajas, cuentas por pagar y
--         anticipos de clientes y a proveedores) se valoran a la tasa BCV del último día del mes y la diferencia contra su valor en libros va a
--         diferencial cambiario (ganancia 4.2.01, pérdida 6.3.02). Solo mueve bolívares: el valor en USD de cada partida no cambia.
--   R-DZ  El Jefe de contabilidad, distinto de quien la propuso, la aprueba por el motor de flujo. Al aprobar, la base guarda el asiento de ajuste
--         (`ajuste_cambiario`, fecha del último día) y su reverso el primer día del mes siguiente: la revaluación solo vale para el balance del cierre,
--         y los documentos que siguen (pagos, cobros, anticipos) siguen usando los valores históricos y liquidan su diferencial como siempre.
--   R-EA  Hay una revaluación vigente por periodo; una rechazada se vuelve a proponer. Una vez propuesta no se modifica ni se borra.
-- =====================================================================

alter table configuracion_contable drop constraint configuracion_contable_clave_check;
alter table configuracion_contable add constraint configuracion_contable_clave_check
  check (clave in ('redondeo', 'diferencial_ganancia', 'diferencial_perdida', 'saldos_apertura', 'resultado_ejercicio',
                   'revaluacion_cxp', 'revaluacion_anticipos_clientes', 'revaluacion_anticipos_proveedores'));
insert into configuracion_contable (clave, cuenta_id)
select v.clave, c.id
  from (values ('revaluacion_cxp', '2.1.01'), ('revaluacion_anticipos_clientes', '2.1.08'), ('revaluacion_anticipos_proveedores', '1.2.02')) as v(clave, codigo)
  join cuenta_contable c on c.codigo = v.codigo;

create table revaluacion_cambiaria (
  id                 uuid primary key default gen_random_uuid(),
  periodo_id         uuid not null references periodo_contable(id),
  tasa               numeric(18,6) not null check (tasa > 0),
  cifras             jsonb not null,
  ganancia_ves       numeric(18,2) not null check (ganancia_ves >= 0),
  perdida_ves        numeric(18,2) not null check (perdida_ves >= 0),
  estado             text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  created_by         uuid not null references usuario(id),
  created_at         timestamptz not null default now(),
  aprobado_por       uuid references usuario(id),
  aprobado_at        timestamptz,
  rechazo_motivo     text,
  asiento_id         uuid references asiento(id),
  asiento_reverso_id uuid references asiento(id),
  check (ganancia_ves + perdida_ves > 0),
  check (estado <> 'aprobada' or (aprobado_por is not null and aprobado_at is not null and asiento_id is not null and asiento_reverso_id is not null)),
  check (estado <> 'rechazada' or length(trim(coalesce(rechazo_motivo, ''))) > 2)
);
create unique index revaluacion_cambiaria_vigente on revaluacion_cambiaria (periodo_id) where estado <> 'rechazada';

create function fn_revaluacion_antes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Una revaluación cambiaria no se borra';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'Una revaluación nace pendiente de aprobación';
    end if;
    if not (fn_tiene_rol(new.created_by, 'contabilidad') or fn_tiene_rol(new.created_by, 'jefe_contabilidad') or fn_tiene_rol(new.created_by, 'gerencia')) then
      raise exception 'Solo Contabilidad o Gerencia proponen la revaluación cambiaria';
    end if;
    if (select mes from periodo_contable where id = new.periodo_id) > 12 then
      raise exception 'La revaluación es de un mes, no del periodo de cierre del ejercicio';
    end if;
    return new;
  end if;
  if new.periodo_id <> old.periodo_id or new.tasa <> old.tasa or new.cifras is distinct from old.cifras or new.ganancia_ves <> old.ganancia_ves
     or new.perdida_ves <> old.perdida_ves or new.created_by <> old.created_by then
    raise exception 'Una revaluación cambiaria no se modifica: se rechaza y se propone de nuevo';
  end if;
  if new.estado = old.estado then
    return new;
  end if;
  if old.estado = 'pendiente' and new.estado = 'aprobada' then
    if new.aprobado_por is null or new.aprobado_por = old.created_by or not fn_tiene_rol(new.aprobado_por, 'jefe_contabilidad') then
      raise exception 'El Jefe de contabilidad, distinto de quien propuso la revaluación, la aprueba';
    end if;
    new.aprobado_at := coalesce(new.aprobado_at, now());
  elsif old.estado = 'pendiente' and new.estado = 'rechazada' then
    null;
  else
    raise exception 'Cambio de estado de la revaluación no permitido (% → %)', old.estado, new.estado;
  end if;
  return new;
end $$;
create trigger revaluacion_cambiaria_antes before insert or update or delete on revaluacion_cambiaria for each row execute function fn_revaluacion_antes();
create trigger revaluacion_cambiaria_audit after insert or update on revaluacion_cambiaria for each row execute function fn_audit();

insert into flujo_definicion (objeto_tipo, nombre) values ('revaluacion_cambiaria', 'Revaluación cambiaria mensual');
insert into flujo_paso (definicion_id, orden, rol_aprobador)
select id, 1, 'jefe_contabilidad' from flujo_definicion where objeto_tipo = 'revaluacion_cambiaria';
