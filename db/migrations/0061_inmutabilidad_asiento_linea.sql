-- La línea pertenece al mismo asiento durante toda su vida.
create function fn_impedir_traslado_asiento_linea() returns trigger language plpgsql as $$
begin
  raise exception 'No se puede trasladar una línea a otro asiento';
end;
$$;

create trigger impedir_traslado_asiento_linea
before update of asiento_id on asiento_linea
for each row when (old.asiento_id is distinct from new.asiento_id)
execute function fn_impedir_traslado_asiento_linea();
