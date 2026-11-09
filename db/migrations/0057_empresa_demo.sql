-- ---------------------------------------------------------------------
-- Marca de entorno de demostración
-- ---------------------------------------------------------------------

-- Una base sembrada con la empresa ficticia (scripts/sembrar-demo.mts) se marca como demostración para que la
-- pantalla lo muestre y para que nadie confunda sus cifras con las de una empresa real. Una base de producción
-- nace con false (por defecto) y la marca no se puede cambiar después: ni una base real pasa a ser demo, ni
-- una demo se hace pasar por real.
alter table empresa add column es_demo boolean not null default false;

create function fn_empresa_demo_fija() returns trigger language plpgsql as $$
begin
  if new.es_demo is distinct from old.es_demo then
    raise exception 'La marca de entorno de demostración de la empresa no se cambia.';
  end if;
  return new;
end $$;

create trigger empresa_demo_fija before update on empresa for each row execute function fn_empresa_demo_fija();
